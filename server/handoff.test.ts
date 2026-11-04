// Open in ChatGPT over HTTP: whether readers get the button, the admin's switch, and that the choice is kept.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, PublicProfile } from "../shared/types.ts";
import type { Ai } from "./ai.ts";
import { createApp } from "./app.ts";
import { createHandoffSettings } from "./handoff-settings.ts";
import { createLibrary } from "./library.ts";
import { createProfiles } from "./profiles.ts";
import type { Profiles } from "./profiles.ts";
import { sessionKey } from "./session-token.ts";
import { loadSessionSecret } from "./sessions.ts";
import { createLocalStore } from "./storage.ts";

const PASSKEY = "a long admin passkey for handoff tests";

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

describe("Open in ChatGPT over HTTP", () => {
  let dataDir: string;
  let started: Profiles[];
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "deepread-handoff-"));
    started = [];
  });
  afterEach(async () => {
    await Promise.all(started.map((profiles) => profiles.flush()));
    await rm(dataDir, { recursive: true, force: true });
  });

  const fakes = { parsePdf: async () => { throw new Error("not used"); }, renderCover: async () => null, llm: fakeLlm, quickTranslate: async (text: string) => text };
  type Call = (method: string, path: string, cookie?: string, body?: unknown) => Response | Promise<Response>;

  /** DeepRead with profiles, starting (again) on the data folder: a request to it, sending `cookie`. */
  async function start(): Promise<Call> {
    const profiles = createProfiles({ store: createLocalStore(dataDir), dataDir, limit: null, adminPasskey: PASSKEY, adminName: "Arafat" });
    started.push(profiles);
    const app = createApp({ ...fakes, accounts: { profiles, sessionKey: sessionKey(await loadSessionSecret(dataDir), PASSKEY) }, handoff: createHandoffSettings(dataDir) });
    return (method, path, cookie = "", body) =>
      app.request(path, {
        method,
        headers: { ...(cookie && { cookie }), ...(body !== undefined && { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
  }

  async function signIn(call: Call, profileId: string, code: string): Promise<string> {
    const response = await call("POST", "/api/session", "", { profileId, code });
    expect(response.status).toBe(200);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  it("should be on for everyone without profiles, and let only the admin turn it off for readers, kept across a restart", async () => {
    const single = createApp({ ...fakes, library: createLibrary(dataDir), handoff: createHandoffSettings(dataDir) });
    expect(await (await single.request("/api/handoff")).json()).toEqual({ enabled: true });
    expect((await single.request("/api/admin/handoff")).status).toBe(404);

    const call = await start();
    const adminId = (((await (await call("GET", "/api/profiles")).json()) as PublicProfile[])[0] as PublicProfile).id;
    const admin = await signIn(call, adminId, PASSKEY);
    const added = await call("POST", "/api/admin/profiles", admin, { name: "Mina", code: "246810", preset: "cat-rose" });
    expect(added.status).toBe(201);
    const mina = await signIn(call, ((await added.json()) as PublicProfile).id, "246810");

    expect(await (await call("GET", "/api/admin/handoff", admin)).json()).toEqual({ enabled: true });
    const refused = await call("PUT", "/api/admin/handoff", mina, { enabled: false });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ApiError).error).toBe("admin_only");
    for (const body of [{ enabled: "no" }, {}, "not json"]) {
      const bad = await call("PUT", "/api/admin/handoff", admin, body);
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as ApiError).message).toMatch(/\.$/);
    }
    expect(await (await call("PUT", "/api/admin/handoff", admin, { enabled: false })).json()).toEqual({ enabled: false });
    // Off for readers; the admin may still, as with translation.
    expect(await (await call("GET", "/api/handoff", mina)).json()).toEqual({ enabled: false });
    expect(await (await call("GET", "/api/handoff", admin)).json()).toEqual({ enabled: true });

    const again = await start();
    expect(await (await again("GET", "/api/handoff", mina)).json()).toEqual({ enabled: false });
    expect(await (await again("GET", "/api/admin/handoff", admin)).json()).toEqual({ enabled: false });
  });
});
