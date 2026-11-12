// The voice box's HTTP side, with the voice and the MP3 encoder replaced by fakes (no model, no ffmpeg).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { voiceBoxHandler } from "./voice-box.ts";
import type { Speak } from "./voice-box.ts";

const TOKEN = "t".repeat(40);
const RATE = 1000;

describe("the voice box", () => {
  let close = () => {};
  afterEach(() => close());

  /** A voice box on a free port; each piece of text becomes `pieceLength` samples of sound with silence round them. */
  async function start(speak: Speak, maxQueue = 4) {
    const encoded: Float32Array[] = [];
    const server = createServer(
      voiceBoxHandler({
        token: TOKEN,
        speak,
        encode: async (audio) => (encoded.push(audio), Buffer.from(`MP3 of ${audio.length} samples`)),
        maxQueue,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const clip = (body: unknown, token = TOKEN) =>
      fetch(`${url}/clip`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { url, clip, encoded };
  }

  /** Sound for each piece: 100 ms of silence, then a sample per character, then 100 ms of silence. */
  const fakeVoice: Speak = async (text) => {
    const silence = new Float32Array(100);
    return { audio: Float32Array.from([...silence, ...Array.from(text, () => 0.5), ...silence]), sampleRate: RATE };
  };

  it("should read a sentence as one MP3, trimmed of the voice's silence, a long one in pieces with a breath between", async () => {
    const asked: string[] = [];
    const box = await start(async (text, speed) => (asked.push(`${speed}:${text}`), fakeVoice(text, speed)));
    const long = `${"A clause that runs on, ".repeat(10)}and ends here. ${"Another clause follows it, ".repeat(10)}and stops.`;

    const response = await box.clip({ text: long, speed: 1.25 });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.every((one) => one.startsWith("1.25:"))).toBe(true);
    expect(asked.map((one) => one.slice(5)).join(" ")).toBe(long);
    // Each piece keeps 50 ms either side of its sound, and pieces are 140 ms apart.
    const sound = asked.reduce((sum, one) => sum + one.length - 5, 0);
    expect(box.encoded[0]?.length).toBe(sound + asked.length * 100 + (asked.length - 1) * 140);
    expect(await response.text()).toBe(`MP3 of ${box.encoded[0]?.length} samples`);
  });

  it("should answer only DeepRead, with its token, and only a sentence it can read", async () => {
    const box = await start(fakeVoice);
    expect((await box.clip({ text: "Hello.", speed: 1 }, "w".repeat(40))).status).toBe(401);
    expect((await fetch(`${box.url}/clip`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await box.clip({ text: "", speed: 1 })).status).toBe(400);
    expect((await box.clip({ text: "x".repeat(1201), speed: 1 })).status).toBe(400);
    expect((await box.clip({ text: "Hello.", speed: 9 })).status).toBe(400);
    expect((await fetch(`${box.url}/health`)).status).toBe(200);
    expect(box.encoded).toEqual([]);
  });

  it("should say it is busy rather than keep a sentence waiting behind a full queue", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => void (release = resolve));
    const box = await start(async (text, speed) => (await held, fakeVoice(text, speed)), 1);

    const first = box.clip({ text: "First.", speed: 1 });
    // The first is being read; nothing more may wait.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await box.clip({ text: "Second.", speed: 1 })).status).toBe(503);
    release();
    expect((await first).status).toBe(200);
    expect((await box.clip({ text: "Third.", speed: 1 })).status).toBe(200);
  });
});
