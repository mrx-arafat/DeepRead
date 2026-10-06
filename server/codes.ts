// The codes that open profiles. A profile's code is kept only as a salted scrypt hash in profiles.json, which may sit
// in an R2 bucket: whoever reads the bucket still has to guess each code. The admin's code is ADMIN_PASSKEY itself.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCHEME = "scrypt";

function derive(code: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFC, so the same code typed on two keyboards that compose letters differently still matches.
    scrypt(code.normalize("NFC"), salt, KEY_BYTES, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** `scrypt$<salt>$<hash>`, both base64, with a fresh random salt each time. */
export async function hashCode(code: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  return `${SCHEME}$${salt.toString("base64")}$${(await derive(code, salt)).toString("base64")}`;
}

/** Whether `code` is the one `stored` was made from. A damaged hash matches nothing. */
export async function verifyCode(code: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash, extra] = stored.split("$");
  if (scheme !== SCHEME || !salt || !hash || extra !== undefined) return false;
  const expected = Buffer.from(hash, "base64");
  if (expected.length !== KEY_BYTES) return false;
  return timingSafeEqual(await derive(code, Buffer.from(salt, "base64")), expected);
}

/** Whether `given` is the admin's passkey. Compared as digests, so the time taken says nothing about its length. */
export function samePasskey(given: string, passkey: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text.normalize("NFC")).digest();
  return timingSafeEqual(digest(given), digest(passkey));
}
