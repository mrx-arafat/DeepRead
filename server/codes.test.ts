import { describe, expect, it } from "vitest";
import { hashCode, samePasskey, verifyCode } from "./codes.ts";

describe("profile codes", () => {
  it("should verify the code it hashed and refuse any other when checking a sign-in", async () => {
    const stored = await hashCode("4321");
    expect(stored).toMatch(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(stored).not.toContain("4321");
    // A fresh salt each time: two profiles with the same code do not share a hash.
    expect(await hashCode("4321")).not.toBe(stored);

    expect(await verifyCode("4321", stored)).toBe(true);
    expect(await verifyCode("4322", stored)).toBe(false);
    expect(await verifyCode("4321 ", stored)).toBe(false);
    expect(await verifyCode("", stored)).toBe(false);
  });

  it("should match nothing when the stored hash is damaged", async () => {
    const [, salt, hash] = (await hashCode("4321")).split("$");
    for (const damaged of ["", "4321", `bcrypt$${salt}$${hash}`, `scrypt$${salt}`, `scrypt$${salt}$${hash?.slice(4)}`, `scrypt$${salt}$${hash}$x`]) {
      expect(await verifyCode("4321", damaged)).toBe(false);
    }
  });

  it("should accept only the exact passkey when the admin signs in", () => {
    expect(samePasskey("correct horse battery", "correct horse battery")).toBe(true);
    expect(samePasskey("correct horse batter", "correct horse battery")).toBe(false);
    expect(samePasskey("", "correct horse battery")).toBe(false);
    // The same letters composed two ways (é as one character, or e plus an accent) are the same passkey.
    expect(samePasskey("café-passkey", "café-passkey")).toBe(true);
  });
});
