import { describe, expect, it } from "vitest";
import type { AiStatus } from "../../shared/types.ts";
import { helperRows } from "./helperState.ts";

const status = (active: AiStatus["active"], providers: AiStatus["providers"], owner?: string): AiStatus => ({ owner, active, providers });
const summary = (rows: ReturnType<typeof helperRows>) => rows.map((row) => `${row.id}: ${row.state}${row.note ? ` (${row.note})` : ""}`);

describe("helperRows", () => {
  // Claude Code is installed on the server, Codex is not, and the admin has set up the API model.
  const server = [
    { id: "claude", name: "Claude Code", installed: true },
    { id: "codex", name: "Codex", installed: false },
    { id: "openrouter", name: "API Model", installed: true, detail: "vendor/model" },
  ] as const;

  it("should show the admin everything, with what works to pick and what does not greyed with why", () => {
    const rows = helperRows(status("claude", server.map((p) => ({ ...p, allowed: true, requested: false }))), "admin");
    expect(summary(rows)).toEqual(["claude: selected", "codex: missing (Not installed on this computer.)", "openrouter: available"]);
  });

  it("should show a reader the same three, with theirs to pick, the others to ask the admin for, and what is not there greyed", () => {
    const rows = helperRows(
      status(null, [
        { ...server[0], allowed: false, requested: false },
        { ...server[1], allowed: false, requested: false },
        { ...server[2], allowed: false, requested: true },
      ], "Arafat"),
      "reader",
    );
    expect(summary(rows)).toEqual([
      "claude: ask (Needs Arafat's approval.)",
      "codex: missing (Not installed on this server.)",
      "openrouter: asked (Asked Arafat. Waiting for the answer.)",
    ]);

    const given = helperRows(
      status("openrouter", [
        { ...server[0], allowed: false, requested: false },
        { ...server[1], allowed: false, requested: false },
        { ...server[2], allowed: true, requested: false },
      ], "Arafat"),
      "reader",
    );
    expect(summary(given)).toEqual([
      "claude: ask (Needs Arafat's approval.)",
      "codex: missing (Not installed on this server.)",
      "openrouter: selected (Shared with you by Arafat.)",
    ]);
    // Without a name to give (an older server), it is still the admin.
    expect(summary(helperRows(status("claude", [{ ...server[0], allowed: true }]), "reader"))).toEqual(["claude: selected (Shared with you by the admin.)"]);
  });

  it("should say where the API model is set up for whoever is looking, when it is not", () => {
    const off = [{ id: "openrouter", name: "API Model", installed: false, detail: "needs an API key" } as const];
    expect(summary(helperRows(status(null, off.map((p) => ({ ...p, allowed: true }))), "admin"))).toEqual(["openrouter: missing (Not set up yet: needs an API key. Set it up on the admin page.)"]);
    expect(summary(helperRows(status(null, off), "single"))).toEqual(["openrouter: missing (Not set up: add OPENROUTER_API_KEY and OPENROUTER_MODEL to .env.)"]);
    expect(summary(helperRows(status(null, off.map((p) => ({ ...p, allowed: false })), "Arafat"), "reader"))).toEqual(["openrouter: missing (Arafat has not set it up yet.)"]);
  });
});
