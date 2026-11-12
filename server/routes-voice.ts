// The natural voice over HTTP: whether this server reads it, and a sentence of a book as an MP3. The sentence is made by
// the voice box (voice.ts) the first time anyone asks, and kept with the book, so every reader after that is sent the
// kept clip and the voice box is not asked again.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./app-env.ts";
import type { Accounts } from "./deps.ts";
import { apiError, bookNotFound, invalidBody, invalidId, readJsonObject } from "./http.ts";
import { bookHome } from "./routes-translation.ts";
import { isReadableBookId } from "./shares.ts";
import { VoiceUnavailable } from "./voice.ts";
import type { Voice } from "./voice.ts";

/** Named in every clip's key: a new voice or model changes it, and the clips of the old one are made again. */
const VOICE = "kokoro-82m/af_heart/1";
/** A sentence, with room for a long one: the reader sends one sentence at a time. */
const MAX_TEXT = 1200;
const BODY_HELP = 'send JSON like {"text": "A sentence of the book.", "speed": 1}, with speed from 0.5 to 2.';

/** The name a clip is kept under: the same sentence at the same speed is the same clip for every reader of the book. */
const clipKey = (text: string, speed: number): string => createHash("sha256").update(`${VOICE}\n${speed}\n${text}`).digest("hex");

export function voiceRoutes(deps: { voice?: Voice; accounts?: Accounts }): Hono<AppEnv> {
  const { voice, accounts } = deps;
  const routes = new Hono<AppEnv>();
  const jsonLimit = bodyLimit({ maxSize: 8 * 1024, onError: (c) => invalidBody(c, "the body is too large.") });
  // By library, then book and clip: two readers reaching the same sentence at once share one making of it.
  const making = new WeakMap<object, Map<string, Promise<Buffer>>>();

  routes.get("/voice", (c) => c.json({ server: voice !== undefined }));

  // Without a voice box the address is unknown, like any other.
  if (!voice) return routes;

  routes.post("/books/:id/voice", jsonLimit, async (c) => {
    const id = c.req.param("id");
    if (!isReadableBookId(id)) return invalidId(c);
    const body = await readJsonObject(c);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const speed = typeof body?.speed === "number" ? Math.round(body.speed * 100) / 100 : Number.NaN;
    if (!text || text.length > MAX_TEXT || !(speed >= 0.5 && speed <= 2)) return invalidBody(c, BODY_HELP);
    // Through the reader's shelf, like the chapter itself: a book that is not on it, or a share that has ended, is not found.
    if (!(await c.var.library.book(id))) return bookNotFound(c);

    // Kept with the book in its owner's library, so a shared book is read aloud once for the owner and everyone it is shared with.
    const home = bookHome(c, accounts, id);
    const key = clipKey(text, speed);
    const send = (clip: Buffer) => c.body(new Uint8Array(clip), 200, { "content-type": "audio/mpeg" });
    const kept = await home.library.readVoice(home.bookId, key);
    if (kept) return send(kept);

    const inLibrary = making.get(home.library) ?? new Map<string, Promise<Buffer>>();
    making.set(home.library, inLibrary);
    const name = `${home.bookId}\n${key}`;
    let clip = inLibrary.get(name);
    if (!clip) {
      const asked = voice.clip(text, speed);
      clip = asked;
      inLibrary.set(name, asked);
      // The reader gets the clip the moment the voice box answers, and it is kept with the book after that: storage may
      // be far from here (R2), and waiting on it added to every sentence's silence. Until it is kept, an ask for the same
      // sentence gets this one.
      void asked
        .then((made) => home.library.writeVoice(home.bookId, key, made))
        // A clip the voice box could not make is answered below, and there is nothing to keep.
        .catch(() => {})
        .finally(() => inLibrary.delete(name));
    }
    try {
      return send(await clip);
    } catch (error) {
      if (!(error instanceof VoiceUnavailable)) throw error;
      // Expected now and then: the voice box is another machine. The reader's device voice reads meanwhile; the log says why.
      console.warn(`natural voice unavailable: ${error.message}`);
      return apiError(c, 503, "voice_unavailable", "The natural voice cannot be reached just now.");
    }
  });

  return routes;
}
