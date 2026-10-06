// Optional encryption at rest (DEEPREAD_ENCRYPTION_KEY): every object is sealed before it reaches the data folder or the
// bucket, so a copy of either is no use without the key. Wraps any ObjectStore; library.ts never knows.
//
// An object is a header, then its content in chunks of CHUNK_BYTES, each sealed on its own, so a range of a PDF is read
// by fetching and opening only the chunks it touches.
//   header:  "\0DRENC", format version 1, a random 32-byte salt, a 16-byte check of the key
//   chunk i: AES-256-GCM ciphertext + 16-byte tag, under a key derived (HKDF-SHA256) from the master key and the salt,
//            nonce i, additional data: the header, whether this is the last chunk, and the object's key
// A new salt at every write gives each object its own key, so a nonce never repeats under one key. The object's key in
// every chunk stops one object being passed off as another, and the last-chunk flag shows an object cut short.
// An object without the header is plaintext from before encryption was turned on, and is read as it is.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ByteRange, ObjectStore, StoredObject } from "./storage.ts";

const SETTING = "DEEPREAD_ENCRYPTION_KEY";
// A NUL first: no JSON, PDF or image DeepRead stores starts with one.
const MAGIC = Buffer.from("\0DRENC", "latin1");
const VERSION = 1;
const SALT_BYTES = 32;
const CHECK_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + CHECK_BYTES;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const INFO = Buffer.from("deepread object v1");
/** Content bytes in each sealed chunk: the most a range read opens beyond what it asked for, at either end. */
export const CHUNK_BYTES = 64 * 1024;
const SEALED_CHUNK_BYTES = CHUNK_BYTES + TAG_BYTES;
// Headers looked at at once while listing: enough to hide a bucket's latency, few enough for any disk.
const PROBES = 16;

class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

const wrongKey = (key: string): Error =>
  new EncryptionError(`${key} was encrypted with a different ${SETTING}, so it cannot be opened. Set ${SETTING} back to the key it was encrypted with.`);
const damaged = (key: string): Error =>
  new EncryptionError(`${key} could not be decrypted with ${SETTING}: it was changed, cut short or moved after it was encrypted. Restore it from a copy.`);
const noKey = (key: string): Error =>
  new EncryptionError(`${key} is encrypted, but ${SETTING} is not set. Set it to the key the books were encrypted with.`);

/** Whether stored bytes are an encrypted object, read without the store that opens it. */
export const startsSealed = (bytes: Buffer): boolean => bytes.length >= MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC);

// ---- The format ----

type ObjectCipher = { key: string; header: Buffer; subkey: Buffer; aad: { last: Buffer; more: Buffer } };

function derive(master: Buffer, salt: Buffer): { subkey: Buffer; check: Buffer } {
  const bytes = Buffer.from(hkdfSync("sha256", master, salt, INFO, KEY_BYTES + CHECK_BYTES));
  return { subkey: bytes.subarray(0, KEY_BYTES), check: bytes.subarray(KEY_BYTES) };
}

function cipherOf(key: string, header: Buffer, subkey: Buffer): ObjectCipher {
  const name = Buffer.from(key, "utf8");
  const aad = (last: boolean): Buffer => Buffer.concat([header, Buffer.of(last ? 1 : 0), name]);
  return { key, header, subkey, aad: { last: aad(true), more: aad(false) } };
}

/** A new header and key for writing `key`. */
function newCipher(master: Buffer, key: string): ObjectCipher {
  const salt = randomBytes(SALT_BYTES);
  const { subkey, check } = derive(master, salt);
  return cipherOf(key, Buffer.concat([MAGIC, Buffer.of(VERSION), salt, check]), subkey);
}

/** The key that opens `key`, from the start of what is stored. The check tells a wrong key from a damaged object. */
function openCipher(master: Buffer, key: string, stored: Buffer): ObjectCipher {
  if (stored.length < HEADER_BYTES) throw damaged(key);
  const version = stored[MAGIC.length];
  if (version !== VERSION) {
    throw new EncryptionError(`${key} is in encryption format ${version}, which this DeepRead cannot open with ${SETTING}. Update DeepRead.`);
  }
  const header = stored.subarray(0, HEADER_BYTES);
  const { subkey, check } = derive(master, header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES));
  if (!timingSafeEqual(check, header.subarray(HEADER_BYTES - CHECK_BYTES))) throw wrongKey(key);
  return cipherOf(key, header, subkey);
}

function nonceOf(index: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
}

function sealChunk(cipher: ObjectCipher, index: number, last: boolean, content: Buffer): Buffer {
  const gcm = createCipheriv("aes-256-gcm", cipher.subkey, nonceOf(index));
  gcm.setAAD(last ? cipher.aad.last : cipher.aad.more);
  return Buffer.concat([gcm.update(content), gcm.final(), gcm.getAuthTag()]);
}

/** The chunk's content, released only once its tag checks out. */
function openChunk(cipher: ObjectCipher, index: number, last: boolean, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw damaged(cipher.key);
  const gcm = createDecipheriv("aes-256-gcm", cipher.subkey, nonceOf(index), { authTagLength: TAG_BYTES });
  gcm.setAAD(last ? cipher.aad.last : cipher.aad.more);
  gcm.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  const content = gcm.update(sealed.subarray(0, sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([content, gcm.final()]);
  } catch {
    throw damaged(cipher.key);
  }
}

/** Even empty content has one chunk, so its tag still proves it whole. */
const chunkCount = (content: number): number => Math.max(1, Math.ceil(content / CHUNK_BYTES));

/** The content bytes in a sealed object of `stored` bytes, or null when no sealed object has that size. */
function contentSize(stored: number): number | null {
  const body = stored - HEADER_BYTES;
  if (body < TAG_BYTES) return null;
  const full = Math.floor(body / SEALED_CHUNK_BYTES);
  const rest = body % SEALED_CHUNK_BYTES;
  if (rest === 0) return full * CHUNK_BYTES;
  // After full chunks, a last chunk holds at least one byte: content that fills its chunks exactly ends with a full one.
  if (full > 0 && rest <= TAG_BYTES) return null;
  return full * CHUNK_BYTES + rest - TAG_BYTES;
}

function sealAll(cipher: ObjectCipher, content: Buffer): Buffer {
  const count = chunkCount(content.length);
  const parts = [cipher.header];
  for (let index = 0; index < count; index += 1) {
    const piece = content.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    parts.push(sealChunk(cipher, index, index === count - 1, piece));
  }
  return Buffer.concat(parts);
}

function openAll(master: Buffer, key: string, stored: Buffer): Buffer {
  const cipher = openCipher(master, key, stored);
  const content = contentSize(stored.length);
  if (content === null) throw damaged(key);
  const count = chunkCount(content);
  const parts: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = HEADER_BYTES + index * SEALED_CHUNK_BYTES;
    parts.push(openChunk(cipher, index, index === count - 1, stored.subarray(start, start + SEALED_CHUNK_BYTES)));
  }
  return Buffer.concat(parts);
}

// ---- Streams ----

/** `source` cut into pieces of exactly `size` bytes but the last, which may be shorter or empty. */
async function* pieces(source: AsyncIterable<Buffer>, size: number): AsyncGenerator<{ piece: Buffer; last: boolean }> {
  let parts: Buffer[] = [];
  let length = 0;
  for await (const part of source) {
    parts.push(part);
    length += part.length;
    // More than a piece in hand, so the first is not the last.
    while (length > size) {
      const joined = parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
      yield { piece: joined.subarray(0, size), last: false };
      parts = [joined.subarray(size)];
      length -= size;
    }
  }
  yield { piece: Buffer.concat(parts, length), last: true };
}

async function* sealStream(cipher: ObjectCipher, source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  yield cipher.header;
  let index = 0;
  for await (const { piece, last } of pieces(source, CHUNK_BYTES)) {
    yield sealChunk(cipher, index, last, piece);
    index += 1;
  }
}

/** What to open of a run of chunks: its first and last, whether that last ends the object, and the content wanted, [from, to). */
type Window = { first: number; last: number; endsObject: boolean; from: number; to: number };

async function* openStream(cipher: ObjectCipher, source: AsyncIterable<Buffer>, window: Window): AsyncGenerator<Buffer> {
  let index = window.first;
  for await (const { piece } of pieces(source, SEALED_CHUNK_BYTES)) {
    if (index > window.last) throw damaged(cipher.key);
    const content = openChunk(cipher, index, window.endsObject && index === window.last, piece);
    const offset = index * CHUNK_BYTES;
    const wanted = content.subarray(Math.max(window.from - offset, 0), Math.max(Math.min(window.to - offset, content.length), 0));
    if (wanted.length > 0) yield wanted;
    index += 1;
  }
  // Fewer chunks than the object's size promised: it was cut short while it was being read.
  if (index <= window.last) throw damaged(cipher.key);
}

async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
  } finally {
    // Also when stopped early (an error, a reader gone away), so the file or the connection is let go.
    await reader.cancel().catch(() => {});
  }
}

function toWebStream(source: AsyncGenerator<Buffer>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await source.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await source.return(undefined);
    },
  });
}

/** Reads `source` until `bytes` are in hand or it ends, so they can be looked at first; `all` yields everything again. */
async function begin(source: AsyncGenerator<Buffer>, bytes: number): Promise<{ head: Buffer; all: AsyncGenerator<Buffer> }> {
  const taken: Buffer[] = [];
  let length = 0;
  let ended = false;
  while (length < bytes && !ended) {
    const next = await source.next();
    if (next.done) ended = true;
    else {
      taken.push(next.value);
      length += next.value.length;
    }
  }
  const head = Buffer.concat(taken, length);
  async function* all(): AsyncGenerator<Buffer> {
    try {
      if (head.length > 0) yield head;
      if (!ended) yield* source;
    } finally {
      await source.return(undefined);
    }
  }
  return { head, all: all() };
}

/** The first `bytes` of an object of at least one byte (fewer when it is shorter), or null when there is none. */
async function readHead(store: ObjectStore, key: string, bytes: number): Promise<Buffer | null> {
  const stream = await store.stream(key, { start: 0, end: bytes - 1 });
  if (!stream) return null;
  const parts: Buffer[] = [];
  for await (const part of chunksOf(stream)) parts.push(part);
  return Buffer.concat(parts);
}

async function fileHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path);
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const emptyStream = (): ReadableStream<Uint8Array> => new ReadableStream({ start: (controller) => controller.close() });

// ---- The stores ----

type Look = { sealed: false } | { sealed: true; header: Buffer };
const PLAIN: Look = { sealed: false };

/** `inner` with every object sealed under `master` (32 bytes) on the way in and opened on the way out. */
export function createEncryptedStore(inner: ObjectStore, master: Buffer): ObjectStore {
  if (master.length !== KEY_BYTES) throw new Error(`an encryption key is ${KEY_BYTES} bytes, not ${master.length}`);

  // What each object turned out to be, by the size it had then: a listing reads only objects it has not seen, and one
  // rewritten since (plaintext encrypted, say) has another size and is looked at again. Objects this store writes are
  // known from the start. Another program rewriting an object to the very same size while DeepRead runs is not caught
  // here, but GCM is: reading it fails with an error and never returns the wrong bytes.
  const seen = new Map<string, { stored: number; look: Look }>();

  /** Null when the object is gone. */
  async function lookAt(key: string, stored: number): Promise<Look | null> {
    // Too short to hold the marker, and nothing to fetch (R2 refuses a range of an empty object).
    if (stored < MAGIC.length) return PLAIN;
    const known = seen.get(key);
    if (known?.stored === stored) return known.look;
    const head = await readHead(inner, key, HEADER_BYTES);
    if (head === null) return null;
    const look: Look = startsSealed(head) ? { sealed: true, header: head } : PLAIN;
    seen.set(key, { stored, look });
    return look;
  }

  function forget(keys: string[]): void {
    for (const key of keys) seen.delete(key);
  }

  async function stream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const stored = await inner.size(key);
    const look = stored === null ? null : await lookAt(key, stored);
    if (stored === null || look === null) return null;
    if (!look.sealed) return inner.stream(key, range);
    const cipher = openCipher(master, key, look.header);
    const content = contentSize(stored);
    if (content === null) throw damaged(key);
    const from = range?.start ?? 0;
    const to = range ? Math.min(range.end + 1, content) : content;
    if (range && from >= to) return emptyStream();
    const lastChunk = chunkCount(content) - 1;
    const first = Math.floor(from / CHUNK_BYTES);
    // The whole of an empty object is still its one chunk, opened to prove it whole.
    const last = range ? Math.floor((to - 1) / CHUNK_BYTES) : lastChunk;
    const body = await inner.stream(key, {
      start: HEADER_BYTES + first * SEALED_CHUNK_BYTES,
      end: Math.min(HEADER_BYTES + (last + 1) * SEALED_CHUNK_BYTES, stored) - 1,
    });
    if (!body) return null;
    // The first chunk is opened before the stream is handed over: a damaged start fails here, not halfway through a response.
    const { all } = await begin(openStream(cipher, chunksOf(body), { first, last, endsObject: last === lastChunk, from, to }), 1);
    return toWebStream(all);
  }

  return {
    kind: inner.kind,

    async read(key) {
      const stored = await inner.read(key);
      return stored && startsSealed(stored) ? openAll(master, key, stored) : stored;
    },

    async size(key) {
      const stored = await inner.size(key);
      const look = stored === null ? null : await lookAt(key, stored);
      if (stored === null || look === null) return null;
      if (!look.sealed) return stored;
      const content = contentSize(stored);
      if (content === null) throw damaged(key);
      return content;
    },

    stream,

    async write(key, data) {
      const cipher = newCipher(master, key);
      const sealed = sealAll(cipher, typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      await inner.write(key, sealed);
      seen.set(key, { stored: sealed.length, look: { sealed: true, header: cipher.header } });
    },

    async putFile(key, path) {
      // A store takes a file whole, so the sealed copy is made first. It holds ciphertext only.
      const temp = join(tmpdir(), `deepread-sealing-${randomUUID()}`);
      try {
        const cipher = newCipher(master, key);
        await pipeline(createReadStream(path), (source: AsyncIterable<Buffer>) => sealStream(cipher, source), createWriteStream(temp));
        // Measured first: the local store moves the file rather than copying it.
        const { size } = await stat(temp);
        await inner.putFile(key, temp);
        seen.set(key, { stored: size, look: { sealed: true, header: cipher.header } });
      } finally {
        await rm(temp, { force: true });
      }
    },

    async download(key, path) {
      const content = await stream(key);
      if (!content) return false;
      try {
        await pipeline(chunksOf(content), createWriteStream(path));
      } catch (error) {
        // Never part of a book where the caller expects the whole of it.
        await rm(path, { force: true });
        throw error;
      }
      return true;
    },

    async list(prefix) {
      const objects = await inner.list(prefix);
      const sized: Array<StoredObject | null> = new Array(objects.length).fill(null);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (let at = next++; at < objects.length; at = next++) {
          const { key, size: stored } = objects[at]!;
          const look = await lookAt(key, stored);
          // Removed since it was listed. A damaged object keeps its stored size, so one bad file cannot hide the rest:
          // reading it says what is wrong.
          if (look) sized[at] = { key, size: look.sealed ? (contentSize(stored) ?? stored) : stored };
        }
      };
      await Promise.all(Array.from({ length: Math.min(PROBES, objects.length) }, worker));
      return sized.filter((object) => object !== null);
    },

    async remove(keys) {
      await inner.remove(keys);
      forget(keys);
    },

    async removeAll(prefix) {
      await inner.removeAll(prefix);
      forget([...seen.keys()].filter((key) => key.startsWith(prefix)));
    },
  };
}

/**
 * `inner` as it is, for when DEEPREAD_ENCRYPTION_KEY is not set, except that an encrypted object is refused with the
 * setting to check rather than served as a book. size() and list() still give an encrypted object's stored size: every
 * way to its content refuses it.
 */
export function refuseEncryptedObjects(inner: ObjectStore): ObjectStore {
  return {
    ...inner,

    async read(key) {
      const data = await inner.read(key);
      if (data && startsSealed(data)) throw noKey(key);
      return data;
    },

    async stream(key, range) {
      if (range && range.start > 0) {
        // The range leaves out the first bytes, so they are fetched beside it rather than before it: no extra wait.
        const [body, head] = await Promise.allSettled([inner.stream(key, range), readHead(inner, key, MAGIC.length)]);
        if (body.status === "rejected") throw body.reason;
        if (head.status === "rejected" || (head.value && startsSealed(head.value))) {
          await body.value?.cancel();
          throw head.status === "rejected" ? head.reason : noKey(key);
        }
        return body.value;
      }
      const body = await inner.stream(key, range);
      if (!body) return null;
      const source = chunksOf(body);
      const { head, all } = await begin(source, MAGIC.length);
      if (startsSealed(head)) {
        await source.return(undefined);
        throw noKey(key);
      }
      return toWebStream(all);
    },

    async download(key, path) {
      if (!(await inner.download(key, path))) return false;
      if (startsSealed(await fileHead(path, MAGIC.length))) {
        await rm(path, { force: true });
        throw noKey(key);
      }
      return true;
    },
  };
}

// ---- What DeepRead keeps in its store ----

// Named rather than found (library.ts, profiles.ts, shares.ts): the data folder also holds files that other parts of
// DeepRead read as they are (session-secret, settings.json, openrouter.json...). Anything not named here stays
// plaintext, which still reads: never broken, only less protected.
const PROFILES_KEY = "profiles.json";
const STORE_FOLDERS = ["books/", "profiles/"];
const STORE_FILES = [PROFILES_KEY, "shares.json"];

// A book's meta.json, at the root or in a profile's library.
const META_KEY = /^(profiles\/[^/]+\/)?books\/[^/]+\/meta\.json$/;
// The most objects a start looks at for the key: enough to get past what a library kept before encryption was turned on.
const KEY_SAMPLES = 50;

/**
 * Looks at the objects a start reads first (profiles.json, then the books' meta.json, up to KEY_SAMPLES of them) and,
 * when any is encrypted, throws if `key` is missing or opens none of the encrypted ones: the start stops with the
 * reason, rather than hiding the encrypted books and sealing new ones under a second key. Plaintext ones are passed
 * over, since a library part way to encrypted holds both. One damaged header among good ones never keeps DeepRead from
 * starting: reading that object reports it.
 */
export async function checkEncryptionKey(raw: ObjectStore, key: Buffer | null): Promise<void> {
  const profiles = await raw.size(PROFILES_KEY);
  const metas = (await Promise.all(STORE_FOLDERS.map((folder) => raw.list(folder)))).flat().filter((object) => META_KEY.test(object.key));
  const candidates = [...(profiles === null ? [] : [{ key: PROFILES_KEY, size: profiles }]), ...metas]
    .filter((object) => object.size >= HEADER_BYTES)
    .slice(0, KEY_SAMPLES);
  const heads = await Promise.all(candidates.map(async (object) => ({ name: object.key, head: await readHead(raw, object.key, HEADER_BYTES) })));
  const sealed = heads.filter((entry): entry is { name: string; head: Buffer } => entry.head !== null && startsSealed(entry.head));
  if (sealed.length === 0) return;
  if (!key) throw noKey(sealed[0]!.name);
  let refusal: unknown = null;
  for (const { name, head } of sealed) {
    try {
      openCipher(key, name, head);
      return;
    } catch (error) {
      refusal ??= error;
    }
  }
  throw refusal;
}

// ---- Encrypting a library that was kept in plaintext ----

export type EncryptOutcome = "encrypted" | "skipped";

export type EncryptOptions = {
  /** A folder on this computer the plaintext passes through, one object at a time. */
  tempDir: string;
  onObject?: (key: string, outcome: EncryptOutcome) => void;
};

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part as Buffer);
  return hash.digest("hex");
}

/**
 * Encrypts every plaintext object of the library in `raw` in place, through createEncryptedStore; objects already
 * encrypted are skipped. Each is replaced whole and read back before the next, so a run stopped at any moment leaves
 * every object readable, and running it again finishes the job. Run it while DeepRead is stopped: a change saved to an
 * object while it is being encrypted would be lost.
 */
export async function encryptInPlace(raw: ObjectStore, key: Buffer, options: EncryptOptions): Promise<Record<EncryptOutcome, number>> {
  const sealed = createEncryptedStore(raw, key);
  const files = await Promise.all(STORE_FILES.map(async (name) => ({ key: name, size: await raw.size(name) })));
  const objects = [
    ...files.filter((file): file is StoredObject => file.size !== null),
    ...(await Promise.all(STORE_FOLDERS.map((folder) => raw.list(folder)))).flat(),
  ];
  const counts: Record<EncryptOutcome, number> = { encrypted: 0, skipped: 0 };
  // SHORTCUT: one object at a time, a small pool of them if a big R2 library makes a run too slow.
  for (const object of objects) {
    const head = object.size < MAGIC.length ? Buffer.alloc(0) : await readHead(raw, object.key, MAGIC.length);
    // Removed since it was listed.
    if (head === null) continue;
    let outcome: EncryptOutcome = "skipped";
    if (!startsSealed(head)) {
      const plain = join(options.tempDir, randomUUID());
      const check = `${plain}.check`;
      try {
        if (!(await raw.download(object.key, plain))) continue;
        await sealed.putFile(object.key, plain);
        // The plaintext copy here is the only one left now, so it is kept until the stored object reads back the same:
        // through a store of its own, which fetches the header afresh instead of remembering the one just written.
        let failure: unknown = null;
        try {
          const found = await createEncryptedStore(raw, key).download(object.key, check);
          if (!found || (await digest(plain)) !== (await digest(check))) failure = new Error(`${object.key} read back different bytes`);
        } catch (error) {
          failure = error;
        }
        if (failure !== null) {
          await raw.putFile(object.key, plain);
          throw new Error(`${object.key} did not read back the same after encrypting, so it was put back unencrypted.`, { cause: failure });
        }
        outcome = "encrypted";
      } finally {
        await rm(plain, { force: true });
        await rm(check, { force: true });
      }
    }
    counts[outcome] += 1;
    options.onObject?.(object.key, outcome);
  }
  return counts;
}
