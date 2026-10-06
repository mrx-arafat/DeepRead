// Where the books are kept and how much room they may take, read from the environment (.env.local, see env.ts).
// .env.example explains each setting to the person filling it in.

export type StorageConfig =
  | { kind: "local"; limit: number | null; encryptionKey: Buffer | null }
  | {
      kind: "r2";
      limit: number | null;
      /** DEEPREAD_ENCRYPTION_KEY: 32 bytes that encrypt everything in the store (encrypted-store.ts), or null for none. */
      encryptionKey: Buffer | null;
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      /** The folder in the bucket DeepRead keeps to: "deepread/", or "" for the whole bucket. */
      prefix: string;
    };

/** A setting that cannot work. The message says which one and how to write it. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const UNIT_BYTES: Record<string, number> = {
  "": 1,
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 2 ** 10,
  mib: 2 ** 20,
  gib: 2 ** 30,
  tib: 2 ** 40,
};

/** "8GB", "1.5 TB", "2GiB" or a plain number of bytes. Null when it is not a size of at least one byte. */
export function parseBytes(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text.trim());
  const unit = match && UNIT_BYTES[match[2]!.toLowerCase()];
  if (!match || !unit) return null;
  const bytes = Math.floor(Number(match[1]) * unit);
  return bytes >= 1 ? bytes : null;
}

const R2_SETTINGS = {
  endpoint: "DEEPREAD_R2_ENDPOINT",
  bucket: "DEEPREAD_R2_BUCKET",
  accessKeyId: "DEEPREAD_R2_ACCESS_KEY_ID",
  secretAccessKey: "DEEPREAD_R2_SECRET_ACCESS_KEY",
} as const;

function readLimit(env: NodeJS.ProcessEnv): number | null {
  const text = env.DEEPREAD_STORAGE_LIMIT?.trim() ?? "";
  if (text === "") return null;
  const limit = parseBytes(text);
  if (limit === null) {
    throw new ConfigError(
      `DEEPREAD_STORAGE_LIMIT is "${text}", which is not a size. Write it like 8GB, 500MB or 1.5TB, or leave it empty for no limit.`,
    );
  }
  return limit;
}

const MAKE_KEY = "Make one with: openssl rand -hex 32";

/** 32 bytes as 64 hex characters or in base64, or null when unset. Its own random bytes, never derived from another secret. */
function readEncryptionKey(env: NodeJS.ProcessEnv): Buffer | null {
  const text = env.DEEPREAD_ENCRYPTION_KEY?.trim() ?? "";
  if (text === "") return null;
  if (/[<>]/.test(text)) {
    throw new ConfigError(`DEEPREAD_ENCRYPTION_KEY still has the example value from .env.example. ${MAKE_KEY}`);
  }
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  // 43 characters hold 32 bytes; `openssl rand -base64 32` pads them to 44 with "=".
  if (/^[A-Za-z0-9+/]{43}=?$/.test(text)) return Buffer.from(text, "base64");
  // The value is a secret, so the message gives its length and never the value.
  throw new ConfigError(
    `DEEPREAD_ENCRYPTION_KEY is not a key DeepRead can use (it has ${text.length} characters): it must be 32 random bytes, written as 64 hex characters or in base64. ${MAKE_KEY}`,
  );
}

/** Throws ConfigError when the settings cannot work. */
export function readStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const limit = readLimit(env);
  const encryptionKey = readEncryptionKey(env);
  const kind = (env.DEEPREAD_STORAGE?.trim() || "local").toLowerCase();
  if (kind === "local") return { kind, limit, encryptionKey };
  if (kind !== "r2") {
    throw new ConfigError(`DEEPREAD_STORAGE is "${env.DEEPREAD_STORAGE}". Set it to "local" or "r2".`);
  }

  const names = Object.values(R2_SETTINGS);
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
    throw new ConfigError(`DEEPREAD_STORAGE is r2, but ${list} ${missing.length === 1 ? "is" : "are"} not set.`);
  }
  const placeholder = names.find((name) => /[<>]/.test(env[name]!));
  if (placeholder) {
    throw new ConfigError(`${placeholder} still has the example value from .env.example. Put your own in .env.local.`);
  }
  const endpoint = env.DEEPREAD_R2_ENDPOINT!.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(endpoint)) {
    throw new ConfigError(
      `DEEPREAD_R2_ENDPOINT is "${endpoint}". Use the S3 endpoint Cloudflare shows for the bucket, like https://<account_id>.r2.cloudflarestorage.com`,
    );
  }

  const folder = (env.DEEPREAD_R2_PREFIX ?? "deepread/").trim().replace(/^\/+|\/+$/g, "");
  return {
    kind,
    limit,
    encryptionKey,
    endpoint,
    bucket: env.DEEPREAD_R2_BUCKET!.trim(),
    accessKeyId: env.DEEPREAD_R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.DEEPREAD_R2_SECRET_ACCESS_KEY!.trim(),
    prefix: folder === "" ? "" : `${folder}/`,
  };
}
