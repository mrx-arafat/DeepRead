// Quick translation with an injected fetch: no network. The response shapes are the ones the real endpoint returned.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuickTranslate } from "./translate.ts";

describe("createQuickTranslate", () => {
  let dir: string;
  let cacheFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "deepread-translate-"));
    cacheFile = join(dir, "translate-cache.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const respond = (body: string, status = 200) => async () => new Response(body, { status });

  it("should translate, then answer repeats from the on-disk cache even after a restart", async () => {
    let fetches = 0;
    const first = createQuickTranslate({
      cacheFile,
      fetchImpl: async (url) => {
        fetches += 1;
        expect(String(url)).toContain("tl=bn");
        expect(String(url)).toContain("q=ubiquitous");
        return new Response('[["সর্বব্যাপী","en"]]');
      },
    });
    expect(await first.translate("ubiquitous", "bn")).toBe("সর্বব্যাপী");
    expect(await first.translate("  ubiquitous ", "bn")).toBe("সর্বব্যাপী");
    expect(fetches).toBe(1);
    await first.flush();
    expect(JSON.parse(await readFile(cacheFile, "utf8"))).toEqual({ "bn\nubiquitous": "সর্বব্যাপী" });

    const restarted = createQuickTranslate({ cacheFile, fetchImpl: respond("should not be called", 500) });
    expect(await restarted.translate("ubiquitous", "bn")).toBe("সর্বব্যাপী");
  });

  it("should fail, and cache nothing, when the service blocks, errors, times out or returns nonsense", async () => {
    const blocked = '<html><body>Sorry... we are sorry but your request looks automated</body></html>';
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const attempts = [
      createQuickTranslate({ cacheFile, fetchImpl: respond(blocked) }),
      createQuickTranslate({ cacheFile, fetchImpl: respond("[]", 503) }),
      createQuickTranslate({ cacheFile, fetchImpl: respond("[[]]") }),
      createQuickTranslate({ cacheFile, fetchImpl: hang, timeoutMs: 50 }),
    ];
    for (const attempt of attempts) {
      await expect(attempt.translate("hello", "fr")).rejects.toThrow(/translate service/);
      await attempt.flush();
    }
    await expect(readFile(cacheFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("should ask Microsoft when Google sends its robot check, and keep that answer like any other", async () => {
    const asked: string[] = [];
    const translator = createQuickTranslate({
      cacheFile,
      fetchImpl: async (url, init) => {
        const address = new URL(String(url));
        asked.push(address.host);
        // What Google sends from an address it suspects.
        if (address.host === "clients5.google.com") return new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/index" } });
        expect(address.searchParams.get("to")).toBe("bn");
        expect(JSON.parse(String(init?.body))).toEqual(["ubiquitous"]);
        return Response.json([{ translations: [{ text: "সর্বব্যাপী", to: "bn" }] }]);
      },
    });
    expect(await translator.translate("ubiquitous", "bn")).toBe("সর্বব্যাপী");
    expect(await translator.translate("ubiquitous", "bn")).toBe("সর্বব্যাপী");
    expect(asked).toEqual(["clients5.google.com", "edge.microsoft.com"]);
  });

  it("should read the other shapes the endpoint is known to return", async () => {
    const shapes: Array<[string, string]> = [
      ['["hola"]', "hola"],
      ['{"sentences":[{"trans":"bonjour ","orig":"hello"},{"trans":"monde","orig":"world"}]}', "bonjour monde"],
      ['[["uno","en"],["dos","en"]]', "uno dos"],
    ];
    for (const [body, expected] of shapes) {
      const translator = createQuickTranslate({ cacheFile: join(dir, `${expected}.json`), fetchImpl: respond(body) });
      expect(await translator.translate("x", "es")).toBe(expected);
    }
  });
});
