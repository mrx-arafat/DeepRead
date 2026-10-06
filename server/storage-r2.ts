// The library in a Cloudflare R2 bucket, through R2's S3-compatible API.
// Every key lives under the configured prefix, so the bucket can hold other things: nothing outside it is ever
// listed, counted or removed. Loaded only when DEEPREAD_STORAGE=r2, so a library on this computer never loads the SDK.
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  paginateListObjectsV2,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { StorageConfig } from "./storage-config.ts";
import { isFolderPrefix } from "./storage.ts";
import type { ObjectStore, StoredObject } from "./storage.ts";

export type R2Config = Pick<
  Extract<StorageConfig, { kind: "r2" }>,
  "endpoint" | "bucket" | "accessKeyId" | "secretAccessKey" | "prefix"
>;

// The most keys one DeleteObjects request takes.
const DELETE_BATCH = 1000;

// Stored with a type, so a file opened from the Cloudflare dashboard shows as what it is.
const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
};

const contentType = (key: string): string => CONTENT_TYPES[extname(key)] ?? "application/octet-stream";

function status(error: unknown): number | undefined {
  return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
}

/** What went wrong reaching the bucket, in words that say which setting to check. */
function whyUnreachable(error: unknown, config: R2Config): string {
  const code = status(error);
  if (code === 401 || code === 403) {
    return `R2 refused the access key. Check DEEPREAD_R2_ACCESS_KEY_ID and DEEPREAD_R2_SECRET_ACCESS_KEY, and that the token may read and write the bucket "${config.bucket}".`;
  }
  if (code === 404) {
    return `There is no bucket "${config.bucket}" at ${config.endpoint}. Check DEEPREAD_R2_BUCKET, and use the jurisdiction endpoint (like https://<account_id>.eu.r2.cloudflarestorage.com) if the bucket has one.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not reach R2 at ${config.endpoint} (${detail}). Check DEEPREAD_R2_ENDPOINT and the internet connection.`;
}

/** Opens the bucket, checking first that it is there and the key may use it; throws with a sentence when not. */
export async function openR2Store(config: R2Config): Promise<ObjectStore> {
  const client = new S3Client({
    // R2 has no regions; the SDK insists on one.
    region: "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const Bucket = config.bucket;
  const full = (key: string): string => config.prefix + key;

  try {
    await client.send(new HeadBucketCommand({ Bucket }));
  } catch (error) {
    client.destroy();
    throw new Error(whyUnreachable(error, config), { cause: error });
  }

  /** Null for an object that is not there, any other failure thrown. */
  async function orNull<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (status(error) === 404) return null;
      throw error;
    }
  }

  async function list(prefix: string): Promise<StoredObject[]> {
    if (!isFolderPrefix(prefix)) throw new Error(`a folder prefix ends in "/": ${JSON.stringify(prefix)}`);
    const objects: StoredObject[] = [];
    for await (const page of paginateListObjectsV2({ client }, { Bucket, Prefix: full(prefix) })) {
      for (const object of page.Contents ?? []) {
        if (object.Key) objects.push({ key: object.Key.slice(config.prefix.length), size: object.Size ?? 0 });
      }
    }
    return objects;
  }

  async function remove(keys: string[]): Promise<void> {
    for (let at = 0; at < keys.length; at += DELETE_BATCH) {
      const batch = keys.slice(at, at + DELETE_BATCH).map((key) => ({ Key: full(key) }));
      const result = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch, Quiet: true } }));
      const failed = result.Errors?.[0];
      if (failed) throw new Error(`R2 could not remove ${failed.Key}: ${failed.Code} ${failed.Message}`);
    }
  }

  return {
    kind: "r2",

    read: (key) =>
      orNull(async () => {
        const object = await client.send(new GetObjectCommand({ Bucket, Key: full(key) }));
        return Buffer.from(await object.Body!.transformToByteArray());
      }),

    size: (key) =>
      orNull(async () => (await client.send(new HeadObjectCommand({ Bucket, Key: full(key) }))).ContentLength ?? 0),

    stream: (key, range) =>
      orNull(async () => {
        const Range = range && `bytes=${range.start}-${range.end}`;
        const object = await client.send(new GetObjectCommand({ Bucket, Key: full(key), Range }));
        return object.Body!.transformToWebStream() as ReadableStream<Uint8Array>;
      }),

    async write(key, data) {
      await client.send(new PutObjectCommand({ Bucket, Key: full(key), Body: data, ContentType: contentType(key) }));
    },

    async putFile(key, path) {
      // Streamed, so a 300 MB PDF is never held in memory; R2 takes up to 5 GB in one request.
      const { size } = await stat(path);
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: full(key),
          Body: createReadStream(path),
          ContentLength: size,
          ContentType: contentType(key),
        }),
      );
    },

    async download(key, path) {
      const object = await orNull(() => client.send(new GetObjectCommand({ Bucket, Key: full(key) })));
      if (!object) return false;
      await pipeline(object.Body as Readable, createWriteStream(path));
      return true;
    },

    list,
    remove,

    async removeAll(prefix) {
      await remove((await list(prefix)).map((object) => object.key));
    },
  };
}
