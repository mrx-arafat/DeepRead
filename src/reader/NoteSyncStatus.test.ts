import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoteSyncStatus } from "./NoteSyncStatus.tsx";
import type { NoteSyncState } from "./noteSync.ts";

const render = (state: NoteSyncState): string => renderToStaticMarkup(createElement(NoteSyncStatus, { state, onRetry: () => {}, onDiscard: () => {} }));

describe("NoteSyncStatus", () => {
  it("should distinguish server acknowledgement from browser-held and page-only recovery", () => {
    expect(render({ phase: "saved", pending: 0, durable: true })).toContain("Notes saved");
    const waiting = render({ phase: "offline", pending: 1, durable: true });
    expect(waiting).toContain("Waiting for connection");
    expect(waiting).toContain("Kept in this browser");
    expect(waiting).toContain("Retry save");
    expect(waiting).not.toContain("Notes saved");
    const pageOnly = render({ phase: "storage-unavailable", pending: 1, durable: false });
    expect(pageOnly).toContain("Keep this page open");
    expect(pageOnly).not.toContain("Kept in this browser");
  });

  it("should expose explicit recovery for refused changes and expired sessions", () => {
    const refused = render({ phase: "rejected", pending: 2, durable: true });
    expect(refused).toContain("Retry save");
    expect(refused).toContain("Discard refused changes");
    expect(refused).toContain('aria-live="polite"');
    const signedOut = render({ phase: "offline", pending: 1, durable: true, reason: "sign-in" });
    expect(signedOut).toContain("Sign in again");
    expect(signedOut).not.toContain("Discard refused changes");
  });
});
