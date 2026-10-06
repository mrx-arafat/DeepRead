import { describe, expect, it } from "vitest";
import type { AiStatus } from "../../shared/types.ts";
import { helperCredit } from "./helperCredit.ts";

const status = (active: AiStatus["active"], owner?: string): AiStatus => ({ owner, active, providers: [] });

describe("helperCredit", () => {
  it("should name whose helper answers a reader, so a gift is seen as one", () => {
    expect(helperCredit(status("claude", "Arafat"), true)).toBe("Arafat's Claude Code");
    expect(helperCredit(status("codex", "Arafat"), true)).toBe("Arafat's Codex");
    expect(helperCredit(status("openrouter", "Arafat"), true)).toBe("Arafat's API model");
  });

  it("should say nothing to the admin, in a library without profiles, or while nothing answers", () => {
    expect(helperCredit(status("claude", "Arafat"), false)).toBeNull();
    expect(helperCredit(status("claude"), true)).toBeNull();
    expect(helperCredit(status(null, "Arafat"), true)).toBeNull();
    expect(helperCredit(null, true)).toBeNull();
  });
});
