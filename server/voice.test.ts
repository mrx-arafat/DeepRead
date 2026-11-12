import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createVoice } from "./voice.ts";

const TOKEN = "t".repeat(32);

describe("the voice box's client", () => {
  let server: Server | null = null;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = null;
  });

  it("should ask again on a new connection when the box closed the kept one just as a sentence was sent on it", async () => {
    // Like a box that let the idle connection go: the second sentence on the same connection finds it closed.
    const sentOn = new Map<Socket, number>();
    const asked: string[] = [];
    server = createServer((request, response) => {
      const count = (sentOn.get(request.socket) ?? 0) + 1;
      sentOn.set(request.socket, count);
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        asked.push((JSON.parse(body) as { text: string }).text);
        if (count === 2) request.socket.destroy();
        else response.end(Buffer.from("mp3"));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const voice = createVoice({ url: new URL(`http://127.0.0.1:${port}`), token: TOKEN });

    expect((await voice.clip("The first sentence.", 1)).toString()).toBe("mp3");
    expect((await voice.clip("The second sentence.", 1)).toString()).toBe("mp3");
    expect(asked).toEqual(["The first sentence.", "The second sentence.", "The second sentence."]);
    expect(sentOn.size).toBe(2);
  });
});
