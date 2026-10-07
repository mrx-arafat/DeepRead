import { describe, expect, it } from "vitest";
import { cleanAddress, isNearby, serviceAt } from "./apiServices.ts";

describe("serviceAt", () => {
  it("should know a named service however its address is written", () => {
    expect(serviceAt("https://openrouter.ai/api/v1").id).toBe("openrouter");
    expect(serviceAt("https://OpenRouter.ai/api/v1/").id).toBe("openrouter");
    expect(serviceAt("http://localhost:11434/v1").id).toBe("ollama");
    expect(serviceAt("http://127.0.0.1:1234/v1").name).toBe("LM Studio");
  });

  it("should call any other address custom, shown by its host, with no key asked of it", () => {
    expect(serviceAt("http://10.0.0.5:8080/v1")).toEqual({ id: "custom", name: "Custom", who: "10.0.0.5:8080", needsKey: false, local: false });
    expect(serviceAt("https://api.openai.com/v2").id).toBe("custom");
    expect(serviceAt("not an address").who).toBe("not an address");
  });
});

describe("cleanAddress", () => {
  it("should keep an http or https address without its trailing slash or /chat/completions", () => {
    expect(cleanAddress("  https://api.example.com/v1/ ")).toBe("https://api.example.com/v1");
    expect(cleanAddress("http://127.0.0.1:8080/v1/chat/completions")).toBe("http://127.0.0.1:8080/v1");
  });

  it("should refuse what the server would not keep", () => {
    expect(cleanAddress("api.example.com/v1")).toBeNull();
    expect(cleanAddress("ftp://example.com/v1")).toBeNull();
    expect(cleanAddress("https://example.com/v1?key=1")).toBeNull();
    expect(cleanAddress("https://me:secret@example.com/v1")).toBeNull();
  });
});

describe("isNearby", () => {
  it("should tell an address on the server or a local network from one on the internet", () => {
    expect(isNearby("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isNearby("http://192.168.1.20:1234/v1")).toBe(true);
    expect(isNearby("http://172.32.0.1/v1")).toBe(false);
    expect(isNearby("https://api.groq.com/openai/v1")).toBe(false);
  });
});
