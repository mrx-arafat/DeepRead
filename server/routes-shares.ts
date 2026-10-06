import { Hono } from "hono";
import type { Context } from "hono";
import type { BookShare, PublicProfile, SharingOverview } from "../shared/types.ts";
import type { AppEnv } from "./app-env.ts";
import type { Accounts } from "./deps.ts";
import { apiError, bookNotFound, invalidId, sharedReadOnly } from "./http.ts";
import { isBookId } from "./library.ts";
import { isProfileId, publicProfile } from "./profiles.ts";
import { profileNotFound } from "./routes-session.ts";
import { parseSharedBookId } from "./shares.ts";

/**
 * Sharing, with profiles on: a reader shares their own books with other profiles and stops when they like, and sees
 * what they share and what is shared with them. Every route works for the profile being read as.
 */
export function sharesRoutes(accounts: Accounts): Hono<AppEnv> {
  const { profiles } = accounts;
  const { shares } = profiles;
  const routes = new Hono<AppEnv>();

  const readerId = (c: Context<AppEnv>): string => {
    const session = c.var.session;
    // readerGuard lets nobody through without a session when profiles are on, and these routes exist only then.
    if (!session) throw new Error("sharing needs someone signed in");
    return session.profile.id;
  };

  async function everyone(): Promise<Map<string, PublicProfile>> {
    return new Map((await profiles.list()).map((profile) => [profile.id, publicProfile(profile)]));
  }

  /** The 400, 403 or 404 for a book id that is not one of the reader's own books, or null when it is. */
  async function notOwnBook(c: Context<AppEnv>, id: string): Promise<Response | null> {
    if (parseSharedBookId(id)) {
      const shared = await c.var.library.detail(id);
      return shared ? sharedReadOnly(c, shared.sharedBy?.name) : bookNotFound(c);
    }
    if (!isBookId(id)) return invalidId(c);
    return (await profiles.library(readerId(c)).detail(id)) ? null : bookNotFound(c);
  }

  routes.get("/books/:id/shares", async (c) => {
    const id = c.req.param("id");
    const refused = await notOwnBook(c, id);
    if (refused) return refused;
    const people = await everyone();
    const owner = readerId(c);
    const list: BookShare[] = (await shares.list()).flatMap((share) => {
      const profile = share.ownerId === owner && share.bookId === id ? people.get(share.recipientId) : undefined;
      return profile ? [{ profile, sharedAt: share.sharedAt }] : [];
    });
    return c.json(list);
  });

  routes.put("/books/:id/shares/:profileId", async (c) => {
    const id = c.req.param("id");
    const recipientId = c.req.param("profileId");
    const refused = await notOwnBook(c, id);
    if (refused) return refused;
    if (recipientId === readerId(c)) return apiError(c, 400, "invalid_recipient", "This book is already yours. Choose someone else to share it with.");
    if (!isProfileId(recipientId) || !(await profiles.find(recipientId))) return profileNotFound(c);
    await shares.add(readerId(c), id, recipientId);
    return c.body(null, 204);
  });

  routes.delete("/books/:id/shares/:profileId", async (c) => {
    const id = c.req.param("id");
    const refused = await notOwnBook(c, id);
    if (refused) return refused;
    // Not shared with them is what was asked for already.
    await shares.remove(readerId(c), id, c.req.param("profileId"));
    return c.body(null, 204);
  });

  routes.get("/shares", async (c) => {
    const owner = readerId(c);
    const people = await everyone();
    const books = new Map((await profiles.library(owner).list()).map((book) => [book.id, book]));
    const given = new Map<string, SharingOverview["given"][number]>();
    for (const share of await shares.list()) {
      const book = share.ownerId === owner ? books.get(share.bookId) : undefined;
      const profile = people.get(share.recipientId);
      if (!book || !profile) continue;
      const entry = given.get(share.bookId) ?? { bookId: book.id, title: book.title, author: book.author, hasCover: book.hasCover, with: [] };
      entry.with.push({ profile, sharedAt: share.sharedAt });
      given.set(share.bookId, entry);
    }
    const received = (await c.var.library.list()).flatMap((book) =>
      book.sharedBy
        ? [{ bookId: book.id, title: book.title, author: book.author, hasCover: book.hasCover, from: book.sharedBy, sharedAt: book.addedAt }]
        : [],
    );
    const overview: SharingOverview = { given: [...given.values()].sort((a, b) => a.title.localeCompare(b.title)), received };
    return c.json(overview);
  });

  return routes;
}
