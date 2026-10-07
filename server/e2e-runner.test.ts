import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("isolated E2E runner", () => {
  it("lists supported journeys without starting the app", () => {
    const output = execFileSync(process.execPath, ["scripts/e2e-runner.mjs"], { encoding: "utf8" });
    expect(output).toContain("notebook");
    expect(output).toContain("ux02-profile-recovery");
    expect(output).toContain("pnpm e2e:run <journey>");
  });

  it("rejects an unknown journey before starting a browser", () => {
    const result = spawnSync(process.execPath, ["scripts/e2e-runner.mjs", "not-a-journey"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("error: unknown journey not-a-journey");
    expect(result.stdout).toContain("notebook");
  });
});
