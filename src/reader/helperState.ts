import { AI_PROVIDER_HELP } from "../../shared/types.ts";
import type { AiProviderId, AiStatus } from "../../shared/types.ts";

/** Who is looking: the admin, a reader whose admin decides what they may use, or the only reader of a library without profiles. */
export type Viewer = "admin" | "reader" | "single";

export type HelperRow = {
  id: AiProviderId;
  name: string;
  help: string;
  /**
   * selected / available: can be used, and is or is not the one answering.
   * ask / asked: installed, but the admin has not given it: not yet asked for, or asked and waiting.
   * missing: the server cannot answer with it.
   */
  state: "selected" | "available" | "ask" | "asked" | "missing";
  /** What to say beside it, if anything. */
  note: string | null;
};

/** Who the admin is to a reader: their name when the server gave it, so a gift is from someone. */
const whoGives = (status: AiStatus): string => status.owner ?? "the admin";

function missingNote(id: AiProviderId, detail: string | undefined, viewer: Viewer, owner: string): string {
  if (id === "openrouter") {
    if (viewer === "admin") return `Not set up yet: ${detail ?? "needs an API key"}. Set it up on the admin page.`;
    if (viewer === "single") return "Not set up: add OPENROUTER_API_KEY and OPENROUTER_MODEL to .env.";
    return `${owner[0]?.toUpperCase()}${owner.slice(1)} has not set it up yet.`;
  }
  return viewer === "reader" ? "Not installed on this server." : "Not installed on this computer.";
}

/** Every helper in the state it is in for this viewer, in the order the server lists them. */
export function helperRows(status: AiStatus, viewer: Viewer): HelperRow[] {
  const owner = whoGives(status);
  return status.providers.map((provider): HelperRow => {
    const { id, name } = provider;
    const help = AI_PROVIDER_HELP[id];
    if (!provider.installed) return { id, name, help, state: "missing", note: missingNote(id, provider.detail, viewer, owner) };
    if (provider.allowed === false) {
      return provider.requested
        ? { id, name, help, state: "asked", note: `Asked ${owner}. Waiting for the answer.` }
        : { id, name, help, state: "ask", note: `Needs ${owner}'s approval.` };
    }
    return { id, name, help, state: status.active === id ? "selected" : "available", note: viewer === "reader" ? `Shared with you by ${owner}.` : null };
  });
}
