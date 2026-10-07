// Functional test of DeepRead with profiles (ADMIN_PASSKEY set): real routes, real disk storage in a temp dir, real
// session cookies, with the PDF parser, the cover renderer, the model and the translator replaced by fakes.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes } from "../shared/bytes.ts";
import type {
  AdminProfile,
  AdminShare,
  AiRequest,
  AiStatus,
  ApiError,
  BookDetail,
  BookShare,
  BookSummary,
  Note,
  ParsedBook,
  PublicProfile,
  Session,
  SessionInfo,
  SharingOverview,
  StorageView,
} from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import type { AppEnv } from "./app-env.ts";
import { createApp } from "./app.ts";
import type { ParsePdf } from "./deps.ts";
import { createAi } from "./ai.ts";
import { createLibrary } from "./library.ts";
import { createOpenRouter } from "./openrouter.ts";
import type { OpenRouter } from "./openrouter.ts";
import { createProfiles } from "./profiles.ts";
import type { Profiles } from "./profiles.ts";
import { sessionKey } from "./session-token.ts";
import { loadSessionSecret } from "./sessions.ts";
import { createLocalStore } from "./storage.ts";
import type { ObjectStore } from "./storage.ts";

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
  streamText: () =>
    (async function* () {
      yield "An answer.";
    })(),
  model: () => "fake-model",
  status: async () => ({ active: null, providers: [] }),
  ensureStatus: async () => {},
  statusFor: async () => ({ active: null, providers: [] }),
  for: () => fakeLlm,
  choose: async () => ({ active: null, providers: [] }),
  close() {},
};

/** `store`, noting each read, size and listing it is asked for in `calls` ("read profiles.json"). */
const counted = (store: ObjectStore, calls: string[]): ObjectStore => ({
  ...store,
  read: (key) => (calls.push(`read ${key}`), store.read(key)),
  size: (key) => (calls.push(`size ${key}`), store.size(key)),
  list: (prefix) => (calls.push(`list ${prefix}`), store.list(prefix)),
});

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
  // Every DeepRead started on this data folder: signing in saves the locks without waiting, so each is flushed before the folder goes.
  const started: Profiles[] = [];
  const flushed = (): Promise<unknown> => Promise.all(started.map((profiles) => profiles.flush()));

  /** DeepRead starting (again) on the same data folder: profiles.json, the books and the session secret carry over. */
  async function start({
    limit = null,
    parsePdf = fakeParsePdf,
    ai = { llm: fakeLlm },
    store = createLocalStore(dataDir),
  }: { limit?: number | null; parsePdf?: ParsePdf; ai?: { llm: Ai; openrouter?: OpenRouter }; store?: ObjectStore } = {}): Promise<void> {
    const profiles = createProfiles({ store, dataDir, limit, adminPasskey: PASSKEY, adminName: "Arafat" });
    started.push(profiles);
    const key = sessionKey(await loadSessionSecret(dataDir), PASSKEY);
    app = createApp({
      accounts: { profiles, sessionKey: key },
      parsePdf,
      renderCover: async () => null,
      llm: ai.llm,
      openrouter: ai.openrouter,
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
    await flushed();
    started.length = 0;
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

  it("should save the locks so a restart keeps them until they end, and drop them with a right code or with the profile", async () => {
    const adminCookie = await signIn(admin, PASSKEY);
    const mina = await addProfile(adminCookie, "Mina", "246810");
    const tryCode = (code: string) => call("POST", "/api/session", "", { profileId: mina.id, code });
    const locksFile = join(dataDir, "locks.json");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-06T10:00:00Z"));
    // The right code as the fifth try locks the client in the same moment, and signs in: no lock is left behind in the file.
    for (let attempt = 1; attempt <= 4; attempt++) expect((await tryCode("111111")).status).toBe(401);
    expect((await tryCode("246810")).status).toBe(200);
    await flushed();
    expect(await readFile(locksFile, "utf8")).not.toContain(mina.id);

    for (let attempt = 1; attempt <= 5; attempt++) expect((await tryCode("111111")).status).toBe(401);
    await flushed();

    // DeepRead stopped and started again, such as a crash someone caused to get fresh tries: the lock is still there, even for the right code.
    await start();
    vi.setSystemTime(Date.parse("2026-10-06T10:04:00Z"));
    const locked = await tryCode("246810");
    expect(locked.status).toBe(429);
    expect(await json<ApiError>(locked)).toEqual({ error: "too_many_tries", message: "Too many wrong codes. Try again in 1 minute." });

    // Once it has ended the right code signs in, and clears the count of locks too: the next lock is 5 minutes again, not 10.
    vi.setSystemTime(Date.parse("2026-10-06T10:05:00Z"));
    expect((await tryCode("246810")).status).toBe(200);
    await flushed();
    expect(await readFile(locksFile, "utf8")).not.toContain(mina.id);
    for (let attempt = 1; attempt <= 5; attempt++) expect((await tryCode("111111")).status).toBe(401);
    expect(await json<ApiError>(tryCode("246810"))).toEqual({ error: "too_many_tries", message: "Too many wrong codes. Try again in 5 minutes." });
    await flushed();
    // The file holds when the lock ends as a point in time, so it is right whenever DeepRead starts again; and only its owner reads it.
    expect(await readFile(locksFile, "utf8")).toContain(String(Date.parse("2026-10-06T10:10:00Z")));
    expect((await stat(locksFile)).mode & 0o777).toBe(0o600);

    // The profile's locks leave the file with it.
    vi.useRealTimers();
    expect((await call("DELETE", `/api/admin/profiles/${mina.id}`, adminCookie)).status).toBe(204);
    await flushed();
    expect(await readFile(locksFile, "utf8")).not.toContain(mina.id);
  });

  it("should count wrong codes from one IPv6 /64 together, so another address inside it gives no fresh tries", async () => {
    const from = (address: string, code: string) =>
      call("POST", "/api/session", `deepread_key=${REMOTE_KEY}`, { profileId: admin, code }, { "cf-connecting-ip": address });
    for (let attempt = 1; attempt <= 5; attempt++) expect((await from(`2001:db8:0:1::${attempt}`, "a guess")).status).toBe(401);
    expect((await from("2001:db8:0:1:ffff:eeee:dddd:cccc", PASSKEY)).status).toBe(429);
    // Another /64 is another client; the first one written another way is still the guesser.
    expect((await from("2001:db8:0:2::1", PASSKEY)).status).toBe(200);
    expect((await from("2001:0DB8:0000:0001::9", PASSKEY)).status).toBe(429);
  });

  it("should open with no locks when locks.json is damaged, say so when it cannot be read, and sign in", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const damaged of ["{ not json", JSON.stringify({ profiles: { [admin]: { local: "locked" }, nobody: [1, 2] } }), "[]"]) {
      await writeFile(join(dataDir, "locks.json"), damaged);
      await start();
      expect((await call("GET", "/api/profiles")).status).toBe(200);
      expect(await signIn(admin, PASSKEY)).not.toBe("");
    }
    // Only the first is not JSON at all; the others are read and found to hold no usable lock.
    expect(warn).toHaveBeenCalledTimes(1);
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

    const minaUsage = await json<StorageView>(call("GET", "/api/storage", minaCookie));
    const rafiUsage = await json<StorageView>(call("GET", "/api/storage", rafiCookie));
    expect(minaUsage.used).toBeGreaterThan(pdfBytes("Mina Reads").length);
    // A reader is told their own books, never the sum of everyone's.
    expect(minaUsage).not.toHaveProperty("total");
    expect(rafiUsage).not.toHaveProperty("total");
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
    const { message } = await json<ApiError>(full);
    expect(message).toMatch(/^There is no room for it: the space everyone shares is full \(your books take .+\), and this one needs /);
    // Not what the others keep: Rafi's books are not Mina's business.
    expect(message).not.toContain(formatBytes(minaUsage.used + rafiUsage.used));
    expect(await json<StorageView>(call("GET", "/api/storage", minaCookie))).toEqual({ ...minaUsage, limit });
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
      // Which AI helpers a profile may use is the admin's to decide.
      ["PATCH", `/api/admin/profiles/${admin}`, { ai: ["claude"] }],
    ];
    for (const [method, path, body] of requests) {
      const response = await call(method, path, minaCookie, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "admin_only", message: "Only the admin can do that." });
    }
    expect((await json<PublicProfile[]>(call("GET", "/api/profiles"))).map((p) => p.name)).toEqual(["Arafat", "Mina"]);
    expect((await call("GET", "/api/ai/providers", minaCookie)).status).toBe(200);
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
      ai: [],
      aiRequested: [],
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
    expect((await json<StorageView>(call("GET", "/api/storage", adminCookie))).used).toBe(0);
  });
  describe("sharing a book", () => {
    const note = (id: string): Note => ({ id, chapterId: "c1", blockId: "c1-b0", quote: "text", mode: "simple", lang: "bn" });
    const share = (cookie: string, bookId: string, profileId: string) => call("PUT", `/api/books/${bookId}/shares/${profileId}`, cookie);
    const unshare = (cookie: string, bookId: string, profileId: string) => call("DELETE", `/api/books/${bookId}/shares/${profileId}`, cookie);
    const shelf = (cookie: string) => json<BookSummary[]>(call("GET", "/api/books", cookie));

    it("should put a shared book on the other reader's shelf, read with their own place and notes, until it is unshared", async () => {
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const minaCookie = await signIn(mina.id, "246810");
      const bookId = await upload(adminCookie, "No Longer Human");

      expect((await share(adminCookie, bookId, mina.id)).status).toBe(204);
      const [shared, ...rest] = await shelf(minaCookie);
      expect(rest).toEqual([]);
      expect(shared).toMatchObject({ title: "No Longer Human", progress: null, sharedBy: { id: admin, name: "Arafat" } });
      // Its own id on her shelf: the same book id may well be one of her own books.
      expect(shared!.id).not.toBe(bookId);
      const id = shared!.id;

      expect(await json<BookDetail>(call("GET", `/api/books/${id}`, minaCookie))).toMatchObject({ title: "No Longer Human", sharedBy: { name: "Arafat" } });
      expect((await call("GET", `/api/books/${id}/chapters/c1`, minaCookie)).status).toBe(200);
      // She reads it here; the owner's PDF file stays with the owner.
      expect((await call("GET", `/api/books/${id}/pdf`, minaCookie)).status).toBe(403);

      // Her place and her notes are hers: the owner's copy of the book is not touched.
      expect((await call("PUT", `/api/books/${id}/progress`, minaCookie, { chapterId: "c1", blockId: "c1-b0", offset: 4 })).status).toBe(200);
      expect((await call("PUT", `/api/books/${id}/notes/n1`, minaCookie, { note: note("n1"), before: null })).status).toBe(204);
      expect((await shelf(minaCookie))[0]?.progress).toMatchObject({ chapterId: "c1", blockId: "c1-b0", offset: 4 });
      expect(await json<Note[]>(call("GET", `/api/books/${id}/notes`, minaCookie))).toEqual([note("n1")]);
      expect((await shelf(adminCookie))[0]?.progress).toBeNull();
      expect(await json<Note[]>(call("GET", `/api/books/${bookId}/notes`, adminCookie))).toEqual([]);

      // Read only: she can neither change the book nor pass it on.
      const rename = await call("PATCH", `/api/books/${id}`, minaCookie, { title: "Mine now" });
      expect(rename.status).toBe(403);
      expect(await json<ApiError>(rename)).toMatchObject({ error: "shared_read_only", message: expect.stringContaining("Arafat") });
      expect((await share(minaCookie, id, admin)).status).toBe(403);

      expect(await json<BookShare[]>(call("GET", `/api/books/${bookId}/shares`, adminCookie))).toEqual([
        { profile: expect.objectContaining({ id: mina.id, name: "Mina" }), sharedAt: expect.any(String) },
      ]);

      expect((await unshare(adminCookie, bookId, mina.id)).status).toBe(204);
      expect(await shelf(minaCookie)).toEqual([]);
      expect((await call("GET", `/api/books/${id}`, minaCookie)).status).toBe(404);
      expect((await call("GET", `/api/books/${id}/chapters/c1`, minaCookie)).status).toBe(404);

      // Shared again, she finds her place and her notes where she left them.
      await share(adminCookie, bookId, mina.id);
      expect((await shelf(minaCookie))[0]?.progress).toMatchObject({ blockId: "c1-b0", offset: 4 });
      expect(await json<Note[]>(call("GET", `/api/books/${id}/notes`, minaCookie))).toEqual([note("n1")]);
    });

    it("should let the reader take a shared book off their shelf, and share only one's own books with someone else who exists", async () => {
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const zed = await addProfile(adminCookie, "Zed", "135790");
      const minaCookie = await signIn(mina.id, "246810");
      const zedCookie = await signIn(zed.id, "135790");
      const bookId = await upload(adminCookie, "No Longer Human");
      await share(adminCookie, bookId, mina.id);
      const id = (await shelf(minaCookie))[0]!.id;

      // Shared with Mina, not with Zed: to him the book is not there.
      expect((await call("GET", `/api/books/${id}`, zedCookie)).status).toBe(404);
      expect((await call("GET", `/api/books/${id}/pdf`, zedCookie)).status).toBe(404);
      expect((await share(minaCookie, bookId, zed.id)).status).toBe(404);

      const self = await share(adminCookie, bookId, admin);
      expect(self.status).toBe(400);
      expect(await json<ApiError>(self)).toMatchObject({ error: "invalid_recipient" });
      expect((await share(adminCookie, bookId, "nobody-123456")).status).toBe(404);
      expect((await share(adminCookie, "no-such-book-12345678", zed.id)).status).toBe(404);

      expect((await call("DELETE", `/api/books/${id}`, minaCookie)).status).toBe(204);
      expect(await shelf(minaCookie)).toEqual([]);
      expect(await titles(adminCookie)).toEqual(["No Longer Human"]);
      expect(await json<BookShare[]>(call("GET", `/api/books/${bookId}/shares`, adminCookie))).toEqual([]);
    });

    it("should explain a passage of a shared book, keeping the answers with the reader who asked", async () => {
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const minaCookie = await signIn(mina.id, "246810");
      const bookId = await upload(adminCookie, "No Longer Human");
      await share(adminCookie, bookId, mina.id);
      const id = (await shelf(minaCookie))[0]!.id;
      const ask = (cookie: string, book: string) =>
        call("POST", "/api/ai/explain", cookie, { bookId: book, chapterId: "c1", blockId: "c1-b0", selection: "text", mode: "word", lang: "bn" });

      const first = await ask(minaCookie, id);
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("An answer.");
      expect(await (await ask(minaCookie, id)).text()).toContain('"cached":true');
      // The owner's own copy of the book has not been asked about: her answers are hers.
      expect(await (await ask(adminCookie, bookId)).text()).toContain('"cached":false');

      await unshare(adminCookie, bookId, mina.id);
      expect((await ask(minaCookie, id)).status).toBe(404);
    });

    it("should end a book's shares when its owner removes it, so adding the same PDF again shares nothing", async () => {
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const minaCookie = await signIn(mina.id, "246810");
      const bookId = await upload(adminCookie, "No Longer Human");
      await share(adminCookie, bookId, mina.id);

      expect((await call("DELETE", `/api/books/${bookId}`, adminCookie)).status).toBe(204);
      expect(await shelf(minaCookie)).toEqual([]);
      expect(await upload(adminCookie, "No Longer Human")).toBe(bookId);
      expect(await shelf(minaCookie)).toEqual([]);

      // A removed profile takes its shares with it, both ways.
      await share(adminCookie, bookId, mina.id);
      expect((await call("DELETE", `/api/admin/profiles/${mina.id}`, adminCookie)).status).toBe(204);
      expect(await json<BookShare[]>(call("GET", `/api/books/${bookId}/shares`, adminCookie))).toEqual([]);
    });

    it("should show a shelf again without asking the store, with the owner's changes and the reader's own place", async () => {
      const calls: string[] = [];
      await start({ store: counted(createLocalStore(dataDir), calls) });
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const minaCookie = await signIn(mina.id, "246810");
      await upload(minaCookie, "Mina's Book");
      const bookId = await upload(adminCookie, "No Longer Human");
      await share(adminCookie, bookId, mina.id);
      const places = async () => (await shelf(minaCookie)).map((book) => [book.title, book.progress?.blockId ?? null]);
      expect(await places()).toEqual([["No Longer Human", null], ["Mina's Book", null]]);
      const id = (await shelf(minaCookie))[0]!.id;

      calls.length = 0;
      expect(await places()).toEqual([["No Longer Human", null], ["Mina's Book", null]]);
      expect(await json<BookDetail>(call("GET", `/api/books/${id}`, minaCookie))).toMatchObject({ title: "No Longer Human" });
      expect(calls).toEqual([]);

      expect((await call("PUT", `/api/books/${id}/progress`, minaCookie, { chapterId: "c1", blockId: "c1-b0" })).status).toBe(200);
      expect((await call("PATCH", `/api/books/${bookId}`, adminCookie, { title: "Ningen Shikkaku" })).status).toBe(200);
      expect(await places()).toEqual([["Ningen Shikkaku", "c1-b0"], ["Mina's Book", null]]);

      // Removed by its owner and shared again, it comes back without the place she had in it.
      expect((await call("DELETE", `/api/books/${bookId}`, adminCookie)).status).toBe(204);
      expect(await upload(adminCookie, "No Longer Human")).toBe(bookId);
      await share(adminCookie, bookId, mina.id);
      expect(await places()).toEqual([["No Longer Human", null], ["Mina's Book", null]]);

      // Started again, her shelf reads her place just before she saves one, and gets its answer only after the save.
      let answered = () => {};
      let release = () => {};
      const readBeforeSave = new Promise<void>((resolve) => (answered = resolve));
      const saved = new Promise<void>((resolve) => (release = resolve));
      let holding = true;
      const local = createLocalStore(dataDir);
      await start({
        store: {
          ...local,
          read: async (key) => {
            const data = await local.read(key);
            if (holding && key.endsWith("/progress.json")) {
              holding = false;
              answered();
              await saved;
            }
            return data;
          },
        },
      });
      const listing = places();
      await readBeforeSave;
      expect((await call("PUT", `/api/books/${id}/progress`, minaCookie, { chapterId: "c1", blockId: "c1-b0" })).status).toBe(200);
      release();
      expect(await listing).toEqual([["No Longer Human", null], ["Mina's Book", null]]);
      expect(await places()).toEqual([["No Longer Human", "c1-b0"], ["Mina's Book", null]]);
    });

    it("should list what each reader shares and is shared, and show the admin every share with a way to stop it", async () => {
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const minaCookie = await signIn(mina.id, "246810");
      const hers = await upload(minaCookie, "Mina's Book");
      const mine = await upload(adminCookie, "No Longer Human");
      await share(minaCookie, hers, admin);
      await share(adminCookie, mine, mina.id);

      const overview = await json<SharingOverview>(call("GET", "/api/shares", minaCookie));
      expect(overview.given).toEqual([{ bookId: hers, title: "Mina's Book", author: null, hasCover: false, with: [{ profile: expect.objectContaining({ name: "Arafat" }), sharedAt: expect.any(String) }] }]);
      expect(overview.received).toEqual([
        {
          bookId: expect.any(String),
          title: "No Longer Human",
          author: null,
          hasCover: false,
          from: expect.objectContaining({ name: "Arafat" }),
          sharedAt: expect.any(String),
        },
      ]);

      const all = await json<AdminShare[]>(call("GET", "/api/admin/shares", adminCookie));
      expect(all.map((one) => [one.owner.name, one.title, one.recipient.name]).sort()).toEqual([
        ["Arafat", "No Longer Human", "Mina"],
        ["Mina", "Mina's Book", "Arafat"],
      ]);
      expect((await call("GET", "/api/admin/shares", minaCookie)).status).toBe(403);

      expect((await call("DELETE", `/api/admin/shares/${mina.id}/${hers}/${admin}`, adminCookie)).status).toBe(204);
      expect((await shelf(adminCookie)).map((b) => b.title)).toEqual(["No Longer Human"]);
      expect((await call("DELETE", `/api/admin/shares/${mina.id}/${hers}/${admin}`, adminCookie)).status).toBe(404);
    });
  });
  describe("AI helpers, which the admin gives to readers one by one", () => {
    const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
    const MODEL = "vendor/good-model";
    const MODELS = { data: [{ id: MODEL, name: "Vendor: Good", context_length: 8000, pricing: { prompt: "0.000001", completion: "0.000002" } }] };
    let requests: Array<{ url: string; authorization: string | undefined }>;

    /** Claude Code on this server answers "answer from claude"; the API model answers "A helpful answer.", over a faked network. */
    async function startServer({ claude = true, env = {} }: { claude?: boolean; env?: Record<string, string> } = {}): Promise<void> {
      const encoder = new TextEncoder();
      const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push({ url: String(url), authorization: headers.Authorization });
        if (String(url).endsWith("/models")) return new Response(JSON.stringify(MODELS));
        if (String(url).endsWith("/key")) return new Response(JSON.stringify({ data: { usage: 0.1, limit: 2 } }));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "A helpful answer." } }] })}\n\ndata: [DONE]\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }) as typeof fetch;
      const openrouter = createOpenRouter({ dataDir, env, fetch: fetcher });
      const llm = createAi({
        dataDir,
        installed: async (bin) => bin === "claude" && claude,
        create: () => ({
          async *streamText() {
            yield "answer from claude";
          },
          model: () => "claude-model",
          close() {},
        }),
        openrouter,
      });
      await llm.status();
      await start({ ai: { llm, openrouter } });
      admin = (await json<PublicProfile[]>(call("GET", "/api/profiles")))[0]!.id;
    }

    let selections = 0;
    /** A question never asked before, so the answer is the helper's and not one kept from an earlier question. */
    const explain = async (cookie: string, bookId: string) =>
      (
        await call("POST", "/api/ai/explain", cookie, {
          bookId,
          chapterId: "c1",
          blockId: "c1-b0",
          selection: `word ${(selections += 1)}`,
          mode: "word",
          lang: "bn",
        })
      ).text();
    const providers = (cookie: string) => json<AiStatus>(call("GET", "/api/ai/providers", cookie));
    const stateOf = (status: AiStatus) => Object.fromEntries(status.providers.map((p) => [p.id, `${p.installed ? "on" : "off"}${p.allowed ? " yours" : ""}${p.requested ? " asked" : ""}`]));

    beforeEach(() => {
      requests = [];
    });

    it("should let only the admin see and set the key, the model and the daily limit, and never send the key back", async () => {
      await startServer({ claude: false });
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const minaCookie = await signIn(mina.id, "246810");

      expect(await json<unknown>(call("GET", "/api/admin/openrouter", adminCookie))).toEqual({
        keySet: false,
        keySource: null,
        keyHint: null,
        model: null,
        modelSource: null,
        dailyLimit: 100,
        usedToday: {},
        active: null,
      });
      for (const [method, path, body] of [
        ["GET", "/api/admin/openrouter"],
        ["PUT", "/api/admin/openrouter", { apiKey: KEY }],
        ["POST", "/api/admin/openrouter/test"],
        ["GET", "/api/admin/openrouter/models"],
      ] as Array<[string, string, unknown?]>) {
        const refused = await call(method, path, minaCookie, body);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: "admin_only" });
      }

      const badKey = await call("PUT", "/api/admin/openrouter", adminCookie, { apiKey: "not a key" });
      expect(badKey.status).toBe(400);
      expect(await json<ApiError>(badKey)).toMatchObject({ error: "invalid_key" });
      const unknown = await call("PUT", "/api/admin/openrouter", adminCookie, { model: "nvidia/nvfp4" });
      expect(unknown.status).toBe(400);
      expect(await json<ApiError>(unknown)).toMatchObject({ error: "unknown_model", message: expect.stringContaining("nvidia/nvfp4") });
      expect(await json<ApiError>(call("PUT", "/api/admin/openrouter", adminCookie, { dailyLimit: -1 }))).toMatchObject({ error: "invalid_limit" });
      expect((await call("PUT", "/api/admin/openrouter", adminCookie, {})).status).toBe(400);

      const saved = await call("PUT", "/api/admin/openrouter", adminCookie, { apiKey: KEY, model: MODEL, dailyLimit: 40 });
      expect(saved.status).toBe(200);
      const view = await saved.text();
      expect(view).not.toContain(KEY);
      // Nothing else on this server can answer, so the API model is what answers for the admin now.
      expect(JSON.parse(view)).toEqual({
        keySet: true,
        keySource: "admin",
        keyHint: "cdef",
        model: MODEL,
        modelSource: "admin",
        dailyLimit: 40,
        usedToday: {},
        active: "openrouter",
        balance: { used: 0.1, limit: 2 },
      });
      expect(await json<unknown[]>(call("GET", "/api/admin/openrouter/models", adminCookie))).toEqual([
        { id: MODEL, name: "Vendor: Good", free: false, promptPerMillion: 1, completionPerMillion: 2 },
      ]);
      expect(await json<unknown>(call("POST", "/api/admin/openrouter/test", adminCookie))).toMatchObject({ ok: true, model: MODEL, balance: { used: 0.1, limit: 2 } });
      // The helper list every reader sees names the model, never the key.
      expect(await (await call("GET", "/api/ai/providers", minaCookie)).text()).not.toContain(KEY);
    });

    it("should give a reader a helper only when the admin does: they ask, the admin answers, they use it and pick among theirs", async () => {
      await startServer({ env: { OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL } });
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const minaCookie = await signIn(mina.id, "246810");
      const bookId = await upload(minaCookie, "Mina's Book");

      // On this server Claude Code is installed and Codex is not, and the admin has set up an API key. The admin sees all of it;
      // Mina sees the same three, none of them hers yet.
      expect(stateOf(await providers(adminCookie))).toEqual({ claude: "on yours", codex: "off yours", openrouter: "on yours" });
      // The helpers are Arafat's, and Mina is told whose.
      expect(await providers(minaCookie)).toMatchObject({ active: null, owner: "Arafat" });
      expect(stateOf(await providers(minaCookie))).toEqual({ claude: "on", codex: "off", openrouter: "on" });
      expect(await explain(minaCookie, bookId)).toContain("ask the admin for one");
      expect(requests).toEqual([]);

      // She cannot take one, nor ask for what the server lacks.
      expect((await call("PUT", "/api/ai/provider", minaCookie, { id: "claude" })).status).toBe(403);
      expect(await json<ApiError>(call("POST", "/api/ai/request", minaCookie, { id: "codex" }))).toMatchObject({ error: "ai_not_installed" });
      expect((await call("POST", "/api/ai/request", minaCookie, { id: "nope" })).status).toBe(400);

      // She can ask for one that is there, and asking twice changes nothing.
      expect(stateOf(await json<AiStatus>(call("POST", "/api/ai/request", minaCookie, { id: "claude" })))).toEqual({ claude: "on asked", codex: "off", openrouter: "on" });
      await call("POST", "/api/ai/request", minaCookie, { id: "claude" });
      const asked = (await json<AdminProfile[]>(call("GET", "/api/admin/profiles", adminCookie))).find((p) => p.id === mina.id);
      expect(asked).toMatchObject({ ai: [], aiRequested: ["claude"] });

      // The rules for the grant itself.
      expect(await json<ApiError>(call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { ai: ["bogus"] }))).toMatchObject({ error: "invalid_ai" });
      expect(await json<ApiError>(call("PATCH", `/api/admin/profiles/${admin}`, adminCookie, { ai: ["claude"] }))).toMatchObject({ error: "admin_ai" });

      // The admin gives her Claude Code and the API model. The request is answered, and Claude Code is first.
      const given = await json<AdminProfile>(call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { ai: ["openrouter", "claude"] }));
      expect(given).toMatchObject({ ai: ["claude", "openrouter"], aiRequested: [] });
      expect(await providers(minaCookie)).toMatchObject({ active: "claude" });
      expect(stateOf(await providers(minaCookie))).toEqual({ claude: "on yours", codex: "off", openrouter: "on yours" });
      expect(await explain(minaCookie, bookId)).toContain("answer from claude");

      // She picks the API model, which answers through the admin's key, and the pick stays.
      expect(await json<AiStatus>(call("PUT", "/api/ai/provider", minaCookie, { id: "openrouter" }))).toMatchObject({ active: "openrouter" });
      expect(await explain(minaCookie, bookId)).toContain("A helpful answer.");
      expect(requests.filter((r) => r.url.endsWith("/chat/completions")).map((r) => r.authorization)).toEqual([`Bearer ${KEY}`]);
      expect(await providers(minaCookie)).toMatchObject({ active: "openrouter" });

      // The admin takes the API model back: her pick goes with it, and she can no longer choose it.
      await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { ai: ["claude"] });
      expect(await providers(minaCookie)).toMatchObject({ active: "claude" });
      expect((await call("PUT", "/api/ai/provider", minaCookie, { id: "openrouter" })).status).toBe(403);

      // Taking everything back leaves her where she began; a request can be turned down without giving anything.
      await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { ai: [] });
      expect(await explain(minaCookie, bookId)).toContain("ask the admin for one");
      await call("POST", "/api/ai/request", minaCookie, { id: "claude" });
      const dismissed = await json<AdminProfile>(call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { aiDismiss: ["claude"] }));
      expect(dismissed).toMatchObject({ ai: [], aiRequested: [] });
      expect(stateOf(await providers(minaCookie))).toEqual({ claude: "on", codex: "off", openrouter: "on" });
    });

    it("should list what readers asked for, oldest first, and let the admin approve each at once or turn it down", async () => {
      await startServer({ env: { OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL } });
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const sam = await addProfile(adminCookie, "Sam", "135790");
      const minaCookie = await signIn(mina.id, "246810");
      const samCookie = await signIn(sam.id, "135790");
      const bookId = await upload(minaCookie, "Mina's Book");
      const ask = (cookie: string, id: string) => call("POST", "/api/ai/request", cookie, { id });

      expect(await json<unknown[]>(call("GET", "/api/admin/ai-requests", adminCookie))).toEqual([]);
      await ask(minaCookie, "claude");
      await ask(minaCookie, "openrouter");
      await ask(samCookie, "claude");
      const waiting = await json<AiRequest[]>(call("GET", "/api/admin/ai-requests", adminCookie));
      expect(waiting.map((r) => [r.profile.name, r.helper])).toEqual([["Mina", "claude"], ["Mina", "openrouter"], ["Sam", "claude"]]);
      expect(waiting.map((r) => r.requestedAt)).toEqual([...waiting.map((r) => r.requestedAt)].sort());
      expect(new Date(waiting[0]!.requestedAt).getTime()).not.toBeNaN();

      // Only the admin sees and answers them.
      for (const [method, path] of [
        ["GET", "/api/admin/ai-requests"],
        ["POST", `/api/admin/ai-requests/${mina.id}/claude/approve`],
        ["DELETE", `/api/admin/ai-requests/${mina.id}/claude`],
      ] as const) {
        expect((await call(method, path, minaCookie)).status).toBe(403);
      }

      // Two approvals made at the same moment both stand: neither overwrites the other.
      const both = await Promise.all([
        call("POST", `/api/admin/ai-requests/${mina.id}/claude/approve`, adminCookie),
        call("POST", `/api/admin/ai-requests/${mina.id}/openrouter/approve`, adminCookie),
      ]);
      expect(both.map((r) => r.status)).toEqual([200, 200]);
      expect((await json<AdminProfile[]>(call("GET", "/api/admin/profiles", adminCookie))).find((p) => p.id === mina.id)).toMatchObject({
        ai: ["claude", "openrouter"],
        aiRequested: [],
      });
      expect(await explain(minaCookie, bookId)).toContain("answer from claude");
      // Approving again changes nothing, and what is left is Sam's.
      expect((await call("POST", `/api/admin/ai-requests/${mina.id}/claude/approve`, adminCookie)).status).toBe(200);
      expect((await json<AiRequest[]>(call("GET", "/api/admin/ai-requests", adminCookie))).map((r) => [r.profile.name, r.helper])).toEqual([["Sam", "claude"]]);

      // Not now: the request goes, nothing is given, and Sam sees it as his to ask for again.
      const turnedDown = await call("DELETE", `/api/admin/ai-requests/${sam.id}/claude`, adminCookie);
      expect(await turnedDown.json()).toMatchObject({ ai: [], aiRequested: [] });
      expect(await json<unknown[]>(call("GET", "/api/admin/ai-requests", adminCookie))).toEqual([]);
      expect(stateOf(await providers(samCookie))).toMatchObject({ claude: "on" });
    });

    it("should refuse to approve a helper this server does not have, or one that does not exist, or for a profile that is not there", async () => {
      await startServer({ env: {} });
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      const approve = (profileId: string, helper: string) => call("POST", `/api/admin/ai-requests/${profileId}/${helper}/approve`, adminCookie);

      // No key and model are set, so the API model cannot answer anyone yet; Codex is not installed (only Claude Code is).
      const notSet = await approve(mina.id, "openrouter");
      expect(notSet.status).toBe(409);
      expect(await json<ApiError>(notSet)).toMatchObject({ error: "ai_not_installed", message: expect.stringContaining("API Model") });
      expect((await approve(mina.id, "codex")).status).toBe(409);
      expect((await approve(mina.id, "nope")).status).toBe(400);
      expect((await approve("nobody-123456", "claude")).status).toBe(404);
      // The admin's own profile uses everything that works: there is nothing to approve.
      expect(await json<ApiError>(approve(admin, "claude"))).toMatchObject({ error: "admin_ai" });
      expect(await json<AdminProfile[]>(call("GET", "/api/admin/profiles", adminCookie))).toSatisfy((list: AdminProfile[]) => list.every((p) => p.ai.length === 0));
    });

    it("should hold a reader to the daily number of requests the admin set for the API model, and say when it starts again", async () => {
      await startServer({ claude: false, env: { OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL, OPENROUTER_DAILY_LIMIT: "2" } });
      const adminCookie = await signIn(admin, PASSKEY);
      const mina = await addProfile(adminCookie, "Mina", "246810");
      await call("PATCH", `/api/admin/profiles/${mina.id}`, adminCookie, { ai: ["openrouter"] });
      const minaCookie = await signIn(mina.id, "246810");
      const bookId = await upload(minaCookie, "Mina's Book");

      expect(await explain(minaCookie, bookId)).toContain("A helpful answer.");
      expect(await explain(minaCookie, bookId)).toContain("A helpful answer.");
      const over = await explain(minaCookie, bookId);
      expect(over).toContain("used today's 2 requests");
      expect(over).not.toContain("A helpful answer.");
      expect(requests.filter((r) => r.url.endsWith("/chat/completions"))).toHaveLength(2);
      expect((await json<{ usedToday: Record<string, number> }>(call("GET", "/api/admin/openrouter", adminCookie))).usedToday).toEqual({ [mina.id]: 2 });

      // The admin raises it, and she carries on.
      await call("PUT", "/api/admin/openrouter", adminCookie, { dailyLimit: 5 });
      expect(await explain(minaCookie, bookId)).toContain("A helpful answer.");
    });
  });
});
