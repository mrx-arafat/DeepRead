// The voice box: another machine that turns a sentence into speech (voice-service/), so that readers' own devices,
// and this server, never run the voice model. DeepRead asks it over HTTPS with a token, and trusts the one certificate
// the voice box made for itself, since the sentence is the book's text and must not cross the network in the clear.
import { readFileSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent, request as httpsRequest } from "node:https";

/** The voice box is busy, down, or answered something that is not a clip. The reader's device voice reads instead. */
export class VoiceUnavailable extends Error {}

export type Voice = {
  /** An MP3 of `text` spoken at `speed` (1 is the voice's own pace). Throws VoiceUnavailable when it cannot be made. */
  clip(text: string, speed: number): Promise<Buffer>;
};

export type VoiceConfig = {
  url: URL;
  token: string;
  /** The voice box's own certificate (PEM), when it is not one a public authority signed. */
  certificate?: string;
};

/** How long one sentence may take, queue included, before the reader's device voice should read it instead. */
const TIMEOUT_MS = 20_000;
/** How long reaching the voice box may take: a box that is down should not keep a reader waiting a whole TIMEOUT_MS. */
const CONNECT_MS = 3_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Where the voice box is, from DEEPREAD_VOICE_URL, DEEPREAD_VOICE_TOKEN and DEEPREAD_VOICE_CERT (a file).
 * Null when no address is set: this server reads no natural voice. Throws, with what to change, when the settings
 * cannot be used.
 */
export function readVoiceConfig(env: Record<string, string | undefined>): VoiceConfig | null {
  const address = env.DEEPREAD_VOICE_URL?.trim();
  if (!address) return null;
  if (!URL.canParse(address)) throw new Error(`DEEPREAD_VOICE_URL is not a web address: ${address}`);
  const url = new URL(address);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("DEEPREAD_VOICE_URL must start with https:// (http:// only for a voice box on this computer): the book's text goes to it.");
  }
  const token = env.DEEPREAD_VOICE_TOKEN?.trim() ?? "";
  if (token.length < 32) throw new Error("DEEPREAD_VOICE_TOKEN must be the voice box's token (32 characters or more).");
  const file = env.DEEPREAD_VOICE_CERT?.trim();
  return { url, token, ...(file ? { certificate: readFileSync(file, "utf8") } : {}) };
}

export function createVoice(config: VoiceConfig): Voice {
  const secure = config.url.protocol === "https:";
  // One connection kept open: a sentence should not pay for a new handshake with a machine that may be far away.
  const agent = secure ? new Agent({ keepAlive: true, maxSockets: 4 }) : new HttpAgent({ keepAlive: true, maxSockets: 4 });
  const target = new URL("clip", config.url.href.endsWith("/") ? config.url : `${config.url.href}/`);

  return {
    clip(text, speed) {
      const body = JSON.stringify({ text, speed });
      const ask = (again: boolean): Promise<Buffer> =>
        new Promise<Buffer>((resolve, reject) => {
          const options = {
            method: "POST",
            headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
            timeout: TIMEOUT_MS,
          };
          const request = secure ? httpsRequest(target, { ...options, agent, ca: config.certificate }) : httpRequest(target, { ...options, agent });
          let answered = false;
          request.on("response", (response) => {
            answered = true;
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", (error) => reject(new VoiceUnavailable(`the voice box stopped answering: ${error.message}`)));
            response.on("end", () => {
              const data = Buffer.concat(chunks);
              if (response.statusCode === 200 && data.length > 0) resolve(data);
              else reject(new VoiceUnavailable(`the voice box answered ${response.statusCode}: ${data.toString("utf8", 0, 200)}`));
            });
          });
          request.on("timeout", () => request.destroy(new Error(`no answer in ${TIMEOUT_MS / 1000} s`)));
          request.on("socket", (socket) => {
            // A connection kept open from an earlier sentence is already there.
            if (!socket.connecting) return;
            const timer = setTimeout(() => request.destroy(new Error(`no connection in ${CONNECT_MS / 1000} s`)), CONNECT_MS);
            socket.once("connect", () => clearTimeout(timer));
            socket.once("close", () => clearTimeout(timer));
          });
          request.on("error", (error: NodeJS.ErrnoException) => {
            // The connection kept open from an earlier sentence was closed by the voice box just as this one was sent on it
            // (a box lets an idle connection go after a while): nothing was read, so the sentence is asked once more on a
            // new connection instead of the reader's device voice reading it.
            if (!again && !answered && request.reusedSocket && error.code === "ECONNRESET") resolve(ask(true));
            else reject(new VoiceUnavailable(`the voice box could not be reached: ${error.message}`));
          });
          request.end(body);
        });
      return ask(false);
    },
  };
}
