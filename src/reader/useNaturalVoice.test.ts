import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tier } from "../deviceTier.ts";

const device = vi.hoisted(() => ({ tier: "normal" as Tier, effects: [] as Array<() => void> }));
const natural = vi.hoisted(() => ({
  enableNatural: vi.fn(() => Promise.resolve()),
  disableNatural: vi.fn(),
  connectServerVoice: vi.fn(() => Promise.resolve()),
  setNaturalBook: vi.fn(),
}));

vi.mock("react", () => ({ useEffect: (effect: () => void) => void device.effects.push(effect) }));
vi.mock("../deviceTier.ts", async (original) => ({ ...(await original<typeof import("../deviceTier.ts")>()), useDeviceTier: () => device.tier }));
vi.mock("./natural.ts", () => natural);
vi.mock("./speech.ts", () => ({ setNaturalVoiceWanted: vi.fn() }));

async function openReader(tier: Tier) {
  device.tier = tier;
  device.effects = [];
  const { useNaturalVoice } = await import("./useNaturalVoice.ts");
  useNaturalVoice("natural", "heart-of-darkness-fb9585e9");
  for (const effect of device.effects) effect();
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useNaturalVoice", () => {
  it("should not load the natural voice when a book opens on a phone", async () => {
    await openReader("normal");
    expect(natural.enableNatural).not.toHaveBeenCalled();
    // Only the question of whether the server reads it: that costs nothing on the device, and makes it ready if so.
    expect(natural.connectServerVoice).toHaveBeenCalledOnce();
    expect(natural.setNaturalBook).toHaveBeenCalledWith("heart-of-darkness-fb9585e9");
  });

  it("should have the natural voice ready when a book opens on a computer", async () => {
    await openReader("desktop");
    expect(natural.enableNatural).toHaveBeenCalledOnce();
  });
});
