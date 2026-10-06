// Functional test of DeepRead with profiles (ADMIN_PASSKEY set): real routes, real disk storage in a temp dir, real
// session cookies, with the PDF parser, the cover renderer, the model and the translator replaced by fakes.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminProfile, ApiError, BookSummary, ParsedBook, PublicProfile, Session, SessionInfo, StorageUsage } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import type { AppEnv } from "./app-env.ts";
import { createApp } from "./app.ts";
import type { ParsePdf } from "./deps.ts";
import { createLibrary } from "./library.ts";
import { createProfiles } from "./profiles.ts";
import { sessionKey } from "./session-token.ts";
import { loadSessionSecret } from "./sessions.ts";
import { createLocalStore } from "./storage.ts";

// Longer than any profile code may be: the admin types the whole passkey to sign in.
const PASSKEY = "a long admin passkey for tests, ".repeat(3);
// Lets requests that came through the tunnel (they carry cf-connecting-ip) past the access guard.
const REMOTE_KEY = "a remote key for tests";

const book = (title: string): ParsedBook => ({
  title,
  author: null,
  pageCount: 1,
  warnings: [],
  chapters: [{ id: "c1", title: "One", startPage: 1, endPage: 1, blocks: [{ id: "c1-b0", type: "paragraph", text: `${title} text.`, page: 1 }] }],
});

// The fake parser reads the uploaded file from disk, so these bytes stand in for a real PDF; `padding` makes it bigger.
const pdfBytes = (title: string, padding = 0) => `%PDF-1.4\n${JSON.stringify(book(title))}\n${"x".repeat(padding)}`;
const fakeParsePdf: ParsePdf = async (path) => JSON.parse((await readFile(path, "utf8")).split("\n")[1] ?? "") as ParsedBook;

const fakeLlm: Ai = {
  streamText: () => (async function* () {})(),
  model: () => "fake-model",
  status: async () => ({ active: null, providers: [] }),
  choose: async () => ({ active: null, providers: [] }),
  close() {},
};

/** The session cookie a response sets, as a Cookie header sends it back ("" when it sets none). */
const cookieFrom = (response: Response): string => (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function png(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#c0392b";
  context.fillRect(0, 0, width, height);
  return new Uint8Array(await canvas.encode("png"));
}

describe("DeepRead with profiles", () => {
  let dataDir: string;
  let app: Hono<AppEnv>;
  let admin: string;

  /** DeepRead starting (again) on the same data folder: profiles.json, the books and the session secret carry over. */
  async function start({ limit = null, parsePdf = fakeParsePdf }: { limit?: number | null; parsePdf?: ParsePdf } = {}): Promise<void> {
    const profiles = createProfiles({ store: createLocalStore(dataDir), dataDir, limit, adminPasskey: PASSKEY, adminName: "Arafat" });
    const key = sessionKey(await loadSessionSecret(dataDir), PASSKEY);
    app = createApp({
      accounts: { profiles, sessionKey: key },
      parsePdf,
      renderCover: async () => null,
      llm: fakeLlm,
      quickTranslate: async (text) => text,
      remoteKey: REMOTE_KEY,
    });
  }

  /** DeepRead without profiles on the same data folder: the one library at books/, no sign-in. */
  const singleMode = () =>
    createApp({ library: createLibrary(dataDir), parsePdf: fakeParsePdf, renderCover: async () => null, llm: fakeLlm, quickTranslate: async (text) => text });
  async function uploadSingle(single: Hono<AppEnv>, title: string): Promise<string> {
    const form = new FormData();
    form.set("file", new File([pdfBytes(title)], `${title}.pdf`));
    const response = await single.request("/api/books", { method: "POST", body: form });
    expect(response.status).toBe(201);
    return (await json<BookSummary>(response)).id;
  }

  const call = (method: string, path: string, cookie = "", body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(cookie && { cookie }), ...(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
    });
  const json = async <T>(response: Response | Promise<Response>): Promise<T> => (await (await response).json()) as T;

  async function signIn(profileId: string, code: string): Promise<string> {
    const response = await call("POST", "/api/session", "", { profileId, code });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }
  async function addProfile(adminCookie: string, name: string, code: string): Promise<AdminProfile> {
    const response = await call("POST", "/api/admin/profiles", adminCookie, { name, code, preset: "cat-rose" });
    expect(response.status).toBe(201);
    return json<AdminProfile>(response);
  }
  const uploadOf = (cookie: string, title: string, padding = 0) => {
    const form = new FormData();
    form.set("file", new File([pdfBytes(title, padding)], `${title}.pdf`, { type: "application/pdf" }));
    return call("POST", "/api/books", cookie, form);
  };
  async function upload(cookie: string, title: string, padding = 0): Promise<string> {
    const response = await uploadOf(cookie, title, padding);
    expect(response.status).toBe(201);
    return (await json<BookSummary>(response)).id;
  }
  const titles = async (cookie: string) => (await json<BookSummary[]>(call("GET", "/api/books", cookie))).map((b) => b.title);

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-profiles-"));
    await start();
    admin = (await json<PublicProfile[]>(call("GET", "/api/profiles")))[0]!.id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("should show the profiles but no books when nobody is signed in", async () => {
    expect(await json<PublicProfile[]>(call("GET", "/api/profiles"))).toEqual([
      { id: admin, name: "Arafat", avatar: { preset: "smile-blue", photo: null }, admin: true, badge: "Admin" },
    ]);
    expect(admin).toMatch(/^arafat-[0-9a-f]{6}$/);
    expect(await json<SessionInfo>(call("GET", "/api/session"))).toEqual({ mode: "profiles", session: null });
    expect((await call("GET", "/api/health")).status).toBe(200);

    for (const path of ["/api/books", "/api/storage", "/api/translate?q=hi&lang=bn", "/api/ai/providers", "/api/admin/profiles"]) {
      const response = await call("GET", path);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "sign_in_required", message: "Choose your profile to keep reading." });
    }
    // A cookie that was never signed is nobody's.
    expect((await call("GET", "/api/books", "deepread_session=eyJwcm9maWxlSWQiOiJ4In0.forged")).status).toBe(401);
  });

  it("should sign in with the right code, and lock out only the client that sent five wrong ones", async () => {
    const adminCookie = await signIn(admin, PASSKEY);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    // `from`: through the tunnel, where each request carries the address Cloudflare saw. Without it: this computer.
    const tryCode = (profileId: string, code: string, from?: string) =>
      call("POST", "/api/session", from ? `deepread_key=${REMOTE_KEY}` : "", { profileId, code }, from ? { "cf-connecting-ip": from } : {});

    expect((await tryCode("nobody-123456", "246810")).status).toBe(404);
    expect((await call("POST", "/api/session", "", { profileId: mina.id })).status).toBe(400);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-06T10:00:00Z"));
    for (let attempt = 1; attempt <= 5; attempt++) {
      const wrong = await tryCode(mina.id, "111111");
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ error: "wrong_code", message: "That code is not right." });
    }
    // Closed on this computer now, even to the right code; not from Mina's phone, and not for other profiles.
    const locked = await tryCode(mina.id, "246810");
    expect(locked.status).toBe(429);
    expect(await json<ApiError>(locked)).toEqual({ error: "too_many_tries", message: "Too many wrong codes. Try again in 5 minutes." });
    expect((await tryCode(mina.id, "246810", "198.51.100.4")).status).toBe(200);
    expect((await tryCode(admin, PASSKEY)).status).toBe(200);

    // A guesser on the internet locks only their own address out of the admin's profile, never the admin.
    for (let attempt = 1; attempt <= 5; attempt++) expect((await tryCode(admin, "a guess", "203.0.113.7")).status).toBe(401);
    expect((await tryCode(admin, PASSKEY, "203.0.113.7")).status).toBe(429);
    expect((await tryCode(admin, PASSKEY)).status).toBe(200);
    expect((await tryCode(admin, PASSKEY, "198.51.100.4")).status).toBe(200);

    vi.setSystemTime(Date.parse("2026-10-06T10:05:00Z"));
    const signedIn = await call("POST", "/api/session", "", { profileId: mina.id, code: "246810" });
    expect(signedIn.status).toBe(200);
    const setCookie = signedIn.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^deepread_session=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);
    const session = await json<Session>(signedIn);
    expect(session).toEqual({
      profile: { id: mina.id, name: "Mina", avatar: { preset: "cat-rose", photo: null }, admin: false, badge: null },
      admin: false,
      impersonatedBy: null,
      expiresAt: "2026-11-05T10:05:00.000Z",
    });
    const cookie = cookieFrom(signedIn);
    expect(await json<SessionInfo>(call("GET", "/api/session", cookie))).toEqual({ mode: "profiles", session });
    expect((await call("GET", "/api/books", cookie)).status).toBe(200);

    // The right code cleared the count: four more wrong ones do not close it again.
    for (let attempt = 1; attempt <= 4; attempt++) await call("POST", "/api/session", "", { profileId: mina.id, code: "1111" });
    expect((await call("POST", "/api/session", "", { profileId: mina.id, code: "246810" })).status).toBe(200);

    // Fixed at sign-in, not renewed by use: 30 days later it has ended.
    vi.setSystemTime(Date.parse("2026-11-05T10:05:00Z"));
    expect((await call("GET", "/api/books", cookie)).status).toBe(401);
    vi.useRealTimers();

    // Over https (here a proxy that says so) the cookie is Secure; signing out clears it.
    const secure = await call("POST", "/api/session", "", { profileId: mina.id, code: "246810" }, { "x-forwarded-proto": "https" });
    expect(secure.headers.get("set-cookie")).toMatch(/; Secure/);
    const signedOut = await call("DELETE", "/api/session", cookieFrom(secure));
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.get("set-cookie")).toMatch(/^deepread_session=; Max-Age=0;/);
  });

  it("should keep each profile's books to itself while counting everyone's against the shared limit", async () => {
    const adminCookie = await signIn(admin, PASSKEY);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    const rafi = await addProfile(adminCookie, "Rafi", "135790");
    const minaCookie = await signIn(mina.id, "246810");
    const rafiCookie = await signIn(rafi.id, "135790");

    const minaBook = await upload(minaCookie, "Mina Reads");
    // A much bigger book than Mina's, so it alone decides whether her next one fits.
    const rafiBook = await upload(rafiCookie, "Rafi Reads", 20_000);
    expect(await titles(minaCookie)).toEqual(["Mina Reads"]);
    expect(await titles(rafiCookie)).toEqual(["Rafi Reads"]);
    expect(await titles(adminCookie)).toEqual([]);
    for (const path of [`/api/books/${rafiBook}`, `/api/books/${rafiBook}/pdf`, `/api/books/${rafiBook}/chapters/c1`]) {
      expect((await call("GET", path, minaCookie)).status).toBe(404);
    }
    expect((await call("DELETE", `/api/books/${rafiBook}`, minaCookie)).status).toBe(404);
    expect(await titles(rafiCookie)).toEqual(["Rafi Reads"]);
    expect(await readdir(join(dataDir, "profiles", mina.id, "books"))).toEqual([minaBook]);

    const minaUsage = await json<StorageUsage>(call("GET", "/api/storage", minaCookie));
    const rafiUsage = await json<StorageUsage>(call("GET", "/api/storage", rafiCookie));
    expect(minaUsage.used).toBeGreaterThan(pdfBytes("Mina Reads").length);
    expect(minaUsage.total).toBe(minaUsage.used + rafiUsage.used);
    expect(rafiUsage.total).toBe(minaUsage.total);
    const board = await json<AdminProfile[]>(call("GET", "/api/admin/profiles", adminCookie));
    expect(board.map((p) => [p.name, p.bookCount, p.used])).toEqual([
      ["Arafat", 0, 0],
      ["Mina", 1, minaUsage.used],
      ["Rafi", 1, rafiUsage.used],
    ]);

    // Room for Mina's next book (about the size of her first) on her own, but not once Rafi's books count too.
    expect(rafiUsage.used).toBeGreaterThan(minaUsage.used * 2);
    const limit = minaUsage.used * 3;
    await start({ limit });
    const full = await uploadOf(minaCookie, "Mina Again");
    expect(full.status).toBe(507);
    expect((await json<ApiError>(full)).message).toMatch(/^There is no room for it: everyone's books together take .+ \(yours .+\) of the .+ they may use/);
    expect(await json<StorageUsage>(call("GET", "/api/storage", minaCookie))).toEqual({ ...minaUsage, limit });
  });

  it("should keep the admin's dashboard to the admin", async () => {
    const adminCookie = await signIn(admin, PASSKEY);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    const minaCookie = await signIn(mina.id, "246810");
    const requests: Array<[string, string, unknown?]> = [
      ["GET", "/api/admin/profiles"],
      ["POST", "/api/admin/profiles", { name: "Sneaky", code: "0000", preset: "owl-violet" }],
      ["PATCH", `/api/admin/profiles/${admin}`, { name: "Not the admin" }],
      ["DELETE", `/api/admin/profiles/${admin}`],
      ["POST", `/api/admin/profiles/${admin}/sign-out`],
      ["POST", `/api/admin/impersonate/${admin}`],
      // One AI helper answers for everyone, so only the admin picks it.
      ["PUT", "/api/ai/provider", { id: "codex" }],
    ];
    for (const [method, path, body] of requests) {
      const response = await call(method, path, minaCookie, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "admin_only", message: "Only the admin can do that." });
    }
    expect((await json<PublicProfile[]>(call("GET", "/api/profiles"))).map((p) => p.name)).toEqual(["Arafat", "Mina"]);
    expect((await call("GET", "/api/ai/providers", minaCookie)).status).toBe(200);
    expect((await call("PUT", "/api/ai/provider", adminCookie, { id: "codex" })).status).toBe(200);
  });

  it("should let the admin add, rename and re-code a profile, and a new code sign that profile out", async () => {
    const adminCookie = await signIn(admin, PASSKEY);
    const added = await call("POST", "/api/admin/profiles", adminCookie, { name: "  Mina  ", code: "246810", preset: "cat-rose" });
    expect(added.status).toBe(201);
    const mina = await json<AdminProfile>(added);
    expect(mina).toEqual({
      id: expect.stringMatching(/^mina-[0-9a-f]{6}$/),
      name: "Mina",
      avatar: { preset: "cat-rose", photo: null },
      admin: false,
      badge: null,
      createdAt: expect.any(String),
      bookCount: 0,
      used: 0,
    });
    const refused: Array<[unknown, string]> = [
      [{ name: "MINA", code: "135790", preset: "cat-rose" }, "name_taken"],
      [{ name: "", code: "135790", preset: "cat-rose" }, "invalid_name"],
      [{ name: "x".repeat(41), code: "135790", preset: "cat-rose" }, "invalid_name"],
      [{ name: "Rafi", code: "13579", preset: "cat-rose" }, "invalid_code"],
      [{ name: "Rafi", code: "135790", preset: "dragon" }, "invalid_preset"],
    ];
    for (const [body, error] of refused) {
      const response = await call("POST", "/api/admin/profiles", adminCookie, body);
      expect([response.status, ((await response.json()) as ApiError).error]).toEqual([400, error]);
    }

    const before = await signIn(mina.id, "246810");
    const renamed = await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { name: "Mina R", preset: "owl-violet" });
    expect(await json<AdminProfile>(renamed)).toMatchObject({ id: mina.id, name: "Mina R", avatar: { preset: "owl-violet" } });
    expect((await call("GET", "/api/books", before)).status).toBe(200);

    expect((await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { code: "135790" })).status).toBe(200);
    expect((await call("GET", "/api/books", before)).status).toBe(401);
    expect((await call("POST", "/api/session", "", { profileId: mina.id, code: "246810" })).status).toBe(401);
    await signIn(mina.id, "135790");

    const adminCode = await call("PATCH", `/api/admin/profiles/${admin}`, adminCookie, { code: "a new passkey" });
    expect(adminCode.status).toBe(400);
    expect(await json<ApiError>(adminCode)).toMatchObject({ error: "admin_code", message: expect.stringContaining("ADMIN_PASSKEY") });
    expect((await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { name: "arafat" })).status).toBe(400);
    expect((await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, {})).status).toBe(400);
    expect((await call("PATCH", "/api/admin/profiles/nobody-123456", adminCookie, { name: "Ghost" })).status).toBe(404);
  });

  it("should let the admin give any profile a badge, the admin's own included, and fall back to Admin when the admin's is cleared", async () => {
    const adminCookie = await signIn(admin, PASSKEY);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    const badges = async () => Object.fromEntries((await json<PublicProfile[]>(call("GET", "/api/profiles"))).map((p) => [p.name, p.badge]));
    expect(await badges()).toEqual({ Arafat: "Admin", Mina: null });

    expect(await json<AdminProfile>(call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { badge: "  Editor " }))).toMatchObject({ badge: "Editor" });
    expect(await json<AdminProfile>(call("PATCH", `/api/admin/profiles/${admin}`, adminCookie, { badge: "Owner" }))).toMatchObject({ badge: "Owner", admin: true });
    expect(await badges()).toEqual({ Arafat: "Owner", Mina: "Editor" });

    // A badge is set on its own: nothing else about the profile moves, and nobody is signed out.
    const minaCookie = await signIn(mina.id, "246810");
    await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { badge: "Kid" });
    expect((await call("GET", "/api/books", minaCookie)).status).toBe(200);

    await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { badge: "" });
    await call("PATCH", `/api/admin/profiles/${admin}`, adminCookie, { badge: "" });
    expect(await badges()).toEqual({ Arafat: "Admin", Mina: null });

    const tooLong = await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { badge: "x".repeat(21) });
    expect(tooLong.status).toBe(400);
    expect(await json<ApiError>(tooLong)).toMatchObject({ error: "invalid_badge" });
    expect((await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { badge: 7 })).status).toBe(400);

    const added = await json<AdminProfile>(call("POST", "/api/admin/profiles", adminCookie, { name: "Zed", code: "246810", preset: "owl-violet", badge: "Guest" }));
    expect(added.badge).toBe("Guest");

    // Only the admin hands them out.
    expect((await call("PATCH", `/api/admin/profiles/${mina.id}`, minaCookie, { badge: "Boss" })).status).toBe(403);
  });

  it("should let the admin sign a profile out everywhere, but not the admin's own profile", async () => {
    const adminCookie = await signIn(admin, PASSKEY);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    const minaCookie = await signIn(mina.id, "246810");
    const viewingCookie = cookieFrom(await call("POST", `/api/admin/impersonate/${mina.id}`, adminCookie));

    const signedOut = await call("POST", `/api/admin/profiles/${mina.id}/sign-out`, adminCookie);
    expect(signedOut.status).toBe(204);
    expect((await call("GET", "/api/books", minaCookie)).status).toBe(401);
    // The admin viewing as Mina signed in as the admin, so that session stands; her code still opens a new one.
    expect((await call("GET", "/api/books", viewingCookie)).status).toBe(200);
    expect((await call("GET", "/api/books", await signIn(mina.id, "246810"))).status).toBe(200);

    const own = await call("POST", `/api/admin/profiles/${admin}/sign-out`, adminCookie);
    expect(own.status).toBe(400);
    expect(await json<ApiError>(own)).toMatchObject({ error: "admin_profile", message: expect.stringContaining("ADMIN_PASSKEY") });
    expect((await call("GET", "/api/books", adminCookie)).status).toBe(200);
    expect((await call("POST", "/api/admin/profiles/nobody-123456/sign-out", adminCookie)).status).toBe(404);
  });

  it("should keep a profile's photo as a small square and show it to the picker", async () => {
    const adminCookie = await signIn(admin, PASSKEY);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    const photoForm = (bytes: Uint8Array<ArrayBuffer> | string, name = "me.png") => {
      const form = new FormData();
      form.set("file", new File([bytes], name));
      return form;
    };

    const uploaded = await call("PUT", `/api/admin/profiles/${mina.id}/photo`, adminCookie, photoForm(await png(300, 200)));
    expect(uploaded.status).toBe(200);
    const photo = (await json<AdminProfile>(uploaded)).avatar.photo;
    expect(photo).toMatch(/^[0-9a-f]+$/);
    expect((await json<PublicProfile[]>(call("GET", "/api/profiles"))).find((p) => p.id === mina.id)?.avatar).toEqual({ preset: "cat-rose", photo });

    // The picker shows it before anyone signs in.
    const served = await call("GET", `/api/profiles/${mina.id}/avatar?v=${photo}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(served.headers.get("cache-control")).toBe("private, max-age=86400");
    const image = await loadImage(Buffer.from(await served.arrayBuffer()));
    expect([image.width, image.height]).toEqual([256, 256]);

    const again = await json<AdminProfile>(call("PUT", `/api/admin/profiles/${mina.id}/photo`, adminCookie, photoForm(await png(64, 64))));
    expect(again.avatar.photo).not.toBe(photo);

    const notImages: Array<[Uint8Array<ArrayBuffer> | string, number, string]> = [
      ["just some text", 415, "not_image"],
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]), 415, "not_image"],
      [new Uint8Array(5 * 1024 * 1024 + 1), 413, "too_large"],
    ];
    for (const [bytes, status, error] of notImages) {
      const response = await call("PUT", `/api/admin/profiles/${mina.id}/photo`, adminCookie, photoForm(bytes));
      expect([response.status, ((await response.json()) as ApiError).error]).toEqual([status, error]);
    }

    const removed = await call("DELETE", `/api/admin/profiles/${mina.id}/photo`, adminCookie);
    expect((await json<AdminProfile>(removed)).avatar.photo).toBeNull();
    expect((await call("GET", `/api/profiles/${mina.id}/avatar`)).status).toBe(404);
    expect(await readdir(join(dataDir, "profiles", mina.id)).catch(() => [])).not.toContain("avatar.webp");
  });

  it("should let the admin read as another profile and come back", async () => {
    const adminSignIn = await call("POST", "/api/session", "", { profileId: admin, code: PASSKEY });
    const adminCookie = cookieFrom(adminSignIn);
    const adminSession = await json<Session>(adminSignIn);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    await upload(await signIn(mina.id, "246810"), "Mina Reads");
    await upload(adminCookie, "Admin Reads");

    const viewing = await call("POST", `/api/admin/impersonate/${mina.id}`, adminCookie);
    expect(viewing.status).toBe(200);
    const asMina = await json<Session>(viewing);
    expect(asMina).toEqual({
      profile: { id: mina.id, name: "Mina", avatar: { preset: "cat-rose", photo: null }, admin: false, badge: null },
      admin: true,
      impersonatedBy: adminSession.profile,
      expiresAt: adminSession.expiresAt,
    });
    const viewingCookie = cookieFrom(viewing);
    expect(await titles(viewingCookie)).toEqual(["Mina Reads"]);
    expect(await json<SessionInfo>(call("GET", "/api/session", viewingCookie))).toEqual({ mode: "profiles", session: asMina });
    expect((await call("GET", "/api/admin/profiles", viewingCookie)).status).toBe(200);

    const back = await call("DELETE", "/api/admin/impersonate", viewingCookie);
    expect(await json<Session>(back)).toEqual(adminSession);
    expect(await titles(cookieFrom(back))).toEqual(["Admin Reads"]);
    expect((await call("POST", "/api/admin/impersonate/nobody-123456", adminCookie)).status).toBe(404);
  });

  it("should remove a profile with its books and end its sessions", async () => {
    const adminCookie = await signIn(admin, PASSKEY);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    const minaCookie = await signIn(mina.id, "246810");
    await upload(minaCookie, "Mina Reads");
    const viewingCookie = cookieFrom(await call("POST", `/api/admin/impersonate/${mina.id}`, adminCookie));

    const removed = await call("DELETE", `/api/admin/profiles/${mina.id}`, viewingCookie);
    expect(removed.status).toBe(204);
    expect((await call("GET", "/api/books", minaCookie)).status).toBe(401);
    expect((await call("POST", "/api/session", "", { profileId: mina.id, code: "246810" })).status).toBe(404);
    expect((await json<PublicProfile[]>(call("GET", "/api/profiles"))).map((p) => p.id)).toEqual([admin]);
    expect(await readdir(join(dataDir, "profiles"))).not.toContain(mina.id);
    // The admin was reading as Mina: they are back as themselves, not signed out.
    expect(await json<SessionInfo>(call("GET", "/api/session", cookieFrom(removed)))).toMatchObject({
      session: { profile: { id: admin }, impersonatedBy: null },
    });

    const adminDelete = await call("DELETE", `/api/admin/profiles/${admin}`, adminCookie);
    expect([adminDelete.status, ((await adminDelete.json()) as ApiError).error]).toEqual([400, "admin_profile"]);
    expect((await call("DELETE", `/api/admin/profiles/${mina.id}`, adminCookie)).status).toBe(404);
  });

  it("should move the books from before profiles into the admin's profile, once", async () => {
    // The same data folder in single mode first: one library at books/, no sign-in.
    await rm(dataDir, { recursive: true, force: true });
    const single = singleMode();
    expect(await json<SessionInfo>(single.request("/api/session"))).toEqual({ mode: "single" });
    expect(await json<PublicProfile[]>(single.request("/api/profiles"))).toEqual([]);
    const before = await uploadSingle(single, "Kept From Before");

    await start();
    const owner = (await json<PublicProfile[]>(call("GET", "/api/profiles")))[0]!;
    const adminCookie = await signIn(owner.id, PASSKEY);
    expect(await titles(adminCookie)).toEqual(["Kept From Before"]);
    expect(await readdir(join(dataDir, "books"))).toEqual([]);
    expect(await readdir(join(dataDir, "profiles", owner.id, "books"))).toEqual([before]);

    // Starting again moves nothing twice and keeps the same admin.
    await start();
    expect((await json<PublicProfile[]>(call("GET", "/api/profiles"))).map((p) => p.id)).toEqual([owner.id]);
    expect(await titles(adminCookie)).toEqual(["Kept From Before"]);
  });

  it("should leave a book from before profiles where it is when the admin's profile already has one with its id", async () => {
    await rm(dataDir, { recursive: true, force: true });
    const kept = await uploadSingle(singleMode(), "Kept From Before");
    await start();
    const owner = (await json<PublicProfile[]>(call("GET", "/api/profiles")))[0]!;

    // Back without profiles for a while: the same PDF again, with a reading place of its own this time, and a new book.
    const single = singleMode();
    expect(await uploadSingle(single, "Kept From Before")).toBe(kept);
    const place = { chapterId: "c1", blockId: "c1-b0" };
    const saved = await single.request(`/api/books/${kept}/progress`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(place) });
    expect(saved.status).toBe(200);
    const fresh = await uploadSingle(single, "New Since");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await start();
    await call("GET", "/api/profiles");
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `Moved 1 book from before profiles into Arafat's profile: ${fresh}.`,
      `Kept 1 book from before profiles in books/, because Arafat's profile already has a book with the same id: ${kept}.`,
    ]);
    // Removing it would have lost the reading place saved in it.
    expect(await readdir(join(dataDir, "books"))).toEqual([kept]);
    const rootMeta = JSON.parse(await readFile(join(dataDir, "books", kept, "meta.json"), "utf8")) as BookSummary;
    expect(rootMeta.progress).toMatchObject(place);
    expect((await titles(await signIn(owner.id, PASSKEY))).sort()).toEqual(["Kept From Before", "New Since"]);
  });

  it("should stop an upload under way when its profile is removed, so nothing of it is written back", async () => {
    let parseStarted!: () => void;
    let finishParse!: () => void;
    const started = new Promise<void>((resolve) => (parseStarted = resolve));
    const parsing = new Promise<void>((resolve) => (finishParse = resolve));
    await start({
      parsePdf: async (path) => {
        parseStarted();
        await parsing;
        return fakeParsePdf(path);
      },
    });
    const adminCookie = await signIn(admin, PASSKEY);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    const uploading = uploadOf(await signIn(mina.id, "246810"), "Mina Reads");

    // Removed while her book is still being read; the upload already holds her library.
    await started;
    expect((await call("DELETE", `/api/admin/profiles/${mina.id}`, adminCookie)).status).toBe(204);
    finishParse();
    const response = await uploading;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "sign_in_required", message: "Choose your profile to keep reading." });
    expect(await readdir(join(dataDir, "profiles")).catch(() => [])).not.toContain(mina.id);
    expect((await json<StorageUsage>(call("GET", "/api/storage", adminCookie))).total).toBe(0);
  });
});
