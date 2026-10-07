import { describe, expect, it } from "vitest";
import type { AiStatus } from "../../shared/types.ts";
import { helperCredit } from "./helperCredit.ts";

const status = (active: AiStatus["active"], owner?: string): AiStatus => ({ owner, active, providers: [] });

describe("helperCredit", () => {
  it("should tell a reader their AI help is a gift from the admin, without naming anyone or anything", () => {
    for (const active of ["claude", "codex", "openrouter"] as const) {
      expect(helperCredit(status(active, "Arafat"), true)).toBe("AI help is on the house, from your admin");
    }
  });

  it("should say nothing to the admin, in a library without profiles, or while nothing answers", () => {
    expect(helperCredit(status("claude", "Arafat"), false)).toBeNull();
    expect(helperCredit(status("claude"), true)).toBeNull();
    expect(helperCredit(status(null, "Arafat"), true)).toBeNull();
    expect(helperCredit(null, true)).toBeNull();
  });
});
