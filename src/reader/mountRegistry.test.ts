import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpMounts, ensureMounted, mountVersion, pin, pinnedBlocks, pinnedChapters, registerWindow, subscribePins } from "./mountRegistry.ts";

describe("mountRegistry", () => {
  afterEach(() => {
    pin("player", []);
    pin("card", []);
    vi.unstubAllGlobals();
  });

  it("should replace an owner's pins and clear them with an empty list", () => {
    const changed = vi.fn();
    const stop = subscribePins(changed);
    pin("player", [{ chapterId: "c1", blockId: "c1-b1" }, { chapterId: "c2", blockId: "c2-b0" }]);
    pin("card", [{ chapterId: "c1", blockId: "c1-b7" }]);
    expect([...pinnedBlocks("c1")]).toEqual(["c1-b1", "c1-b7"]);
    expect([...pinnedChapters()]).toEqual(["c1", "c2"]);

    pin("player", [{ chapterId: "c3", blockId: "c3-b2" }]);
    expect([...pinnedBlocks("c1")]).toEqual(["c1-b7"]);
    expect([...pinnedChapters()]).toEqual(["c3", "c1"]);

    pin("card", []);
    pin("card", []);
    expect(pinnedBlocks("c1").size).toBe(0);
    // Three pins and one clear told the listener; the second clear changed nothing.
    expect(changed).toHaveBeenCalledTimes(4);
    stop();
  });

  it("should return null for a block that no chapter on the page can mount", () => {
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const mount = vi.fn(() => false);
    const unregister = registerWindow("c1", mount);
    expect(ensureMounted("c1", "c1-b99")).toBeNull();
    expect(mount).toHaveBeenCalledWith("c1-b99");
    expect(ensureMounted("c9", "c9-b0")).toBeNull();
    unregister();
    expect(ensureMounted("c1", "c1-b1")).toBeNull();
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it("should count each mount change", () => {
    const before = mountVersion();
    bumpMounts();
    bumpMounts();
    expect(mountVersion()).toBe(before + 2);
  });
});
