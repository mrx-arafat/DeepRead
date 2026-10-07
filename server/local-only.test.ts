import { describe, expect, it } from "vitest";
import { publicOriginFrom } from "./local-only.ts";

describe("publicOriginFrom", () => {
  const STRONG = "several unrelated words";

  it("should give the address people type, as an origin, only when it is set", () => {
    expect(publicOriginFrom(undefined, "")).toBeUndefined();
    expect(publicOriginFrom("  ", STRONG)).toBeUndefined();
    expect(publicOriginFrom("https://read.example.com/", STRONG)).toBe("https://read.example.com");
    expect(publicOriginFrom("https://Read.Example.com:8443", STRONG)).toBe("https://read.example.com:8443");
  });

  it("should refuse an address or a passkey that would leave the books open to anyone", () => {
    expect(() => publicOriginFrom("https://read.example.com", "")).toThrow(/ADMIN_PASSKEY/);
    expect(() => publicOriginFrom("https://read.example.com", "short-key")).toThrow(/12 characters/);
    expect(() => publicOriginFrom("http://read.example.com", STRONG)).toThrow(/https:\/\//);
    expect(() => publicOriginFrom("https://read.example.com/books", STRONG)).toThrow(/DEEPREAD_PUBLIC_URL/);
    expect(() => publicOriginFrom("read.example.com", STRONG)).toThrow(/DEEPREAD_PUBLIC_URL/);
  });
});
