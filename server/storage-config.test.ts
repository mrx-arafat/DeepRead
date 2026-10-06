import { describe, expect, it } from "vitest";
import { ConfigError, parseBytes, readStorageConfig } from "./storage-config.ts";

const R2 = {
  DEEPREAD_STORAGE: "r2",
  DEEPREAD_R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
  DEEPREAD_R2_BUCKET: "books",
  DEEPREAD_R2_ACCESS_KEY_ID: "key",
  DEEPREAD_R2_SECRET_ACCESS_KEY: "secret",
};

describe("parseBytes", () => {
  it("should read decimal and binary units, with or without a space", () => {
    expect(parseBytes("8GB")).toBe(8_000_000_000);
    expect(parseBytes("8 gb")).toBe(8_000_000_000);
    expect(parseBytes("1.5TB")).toBe(1_500_000_000_000);
    expect(parseBytes("500MB")).toBe(500_000_000);
    expect(parseBytes("2GiB")).toBe(2_147_483_648);
    expect(parseBytes("1024")).toBe(1024);
  });

  it("should refuse what is not a size", () => {
    for (const text of ["", "lots", "8 gigs", "-1GB", "0GB", "GB", "1e9"]) expect(parseBytes(text)).toBeNull();
  });
});

describe("readStorageConfig", () => {
  it("should keep books on this computer with no limit and no encryption when nothing is set", () => {
    expect(readStorageConfig({})).toEqual({ kind: "local", limit: null, encryptionKey: null });
  });

  it("should read the limit and the R2 bucket, keeping DeepRead in a folder of its own", () => {
    expect(readStorageConfig({ ...R2, DEEPREAD_STORAGE_LIMIT: "8GB" })).toEqual({
      kind: "r2",
      limit: 8_000_000_000,
      encryptionKey: null,
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "books",
      accessKeyId: "key",
      secretAccessKey: "secret",
      prefix: "deepread/",
    });
    expect(readStorageConfig({ ...R2, DEEPREAD_R2_PREFIX: "/me/deepread" })).toMatchObject({ prefix: "me/deepread/" });
  });

  it("should name what is wrong when the settings cannot work", () => {
    expect(() => readStorageConfig({ DEEPREAD_STORAGE_LIMIT: "a lot" })).toThrow(/DEEPREAD_STORAGE_LIMIT.*8GB/);
    expect(() => readStorageConfig({ DEEPREAD_STORAGE: "s3" })).toThrow(/"local" or "r2"/);
    expect(() => readStorageConfig({ ...R2, DEEPREAD_R2_BUCKET: "", DEEPREAD_R2_SECRET_ACCESS_KEY: " " })).toThrow(
      "DEEPREAD_STORAGE is r2, but DEEPREAD_R2_BUCKET and DEEPREAD_R2_SECRET_ACCESS_KEY are not set.",
    );
    expect(() => readStorageConfig({ ...R2, DEEPREAD_R2_BUCKET: "<bucket-name>" })).toThrow(/still has the example value/);
    expect(() => readStorageConfig({ ...R2, DEEPREAD_R2_ENDPOINT: "abc123.r2.cloudflarestorage.com" })).toThrow(/https:\/\//);
    expect(() => readStorageConfig({ DEEPREAD_STORAGE: "s3" })).toThrow(ConfigError);
  });
});

describe("DEEPREAD_ENCRYPTION_KEY", () => {
  const HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const KEY = Buffer.from(HEX, "hex");

  it("should read 32 bytes written as hex or base64, and no key when it is unset or empty", () => {
    expect(readStorageConfig({ DEEPREAD_ENCRYPTION_KEY: HEX }).encryptionKey).toEqual(KEY);
    expect(readStorageConfig({ DEEPREAD_ENCRYPTION_KEY: ` ${HEX.toUpperCase()} ` }).encryptionKey).toEqual(KEY);
    // What `openssl rand -base64 32` prints: 44 characters, the last one "=".
    expect(readStorageConfig({ DEEPREAD_ENCRYPTION_KEY: "ABEiM0RVZneImaq7zN3u/wARIjNEVWZ3iJmqu8zd7v8=" }).encryptionKey).toEqual(KEY);
    expect(readStorageConfig({ ...R2, DEEPREAD_ENCRYPTION_KEY: HEX })).toMatchObject({ kind: "r2", encryptionKey: KEY });
    expect(readStorageConfig({ DEEPREAD_ENCRYPTION_KEY: "  " }).encryptionKey).toBeNull();
  });

  it("should refuse what is not 32 bytes in hex or base64, saying how to make a key and never repeating the value", () => {
    const wrong = [
      HEX.slice(2), // 31 bytes
      "g".repeat(64), // the right length, not hex
      Buffer.alloc(16, 1).toString("base64"), // base64, but 16 bytes
      "correct horse battery staple",
      "<64 hex characters>",
    ];
    for (const value of wrong) {
      let message = "";
      try {
        readStorageConfig({ DEEPREAD_ENCRYPTION_KEY: value });
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/^DEEPREAD_ENCRYPTION_KEY .*openssl rand -hex 32/);
      expect(message).not.toContain(value);
    }
  });
});
