import crypto from "node:crypto";
import { env } from "./config.js";

function key(): Buffer {
  const buf = Buffer.from(env.TOKEN_ENCRYPTION_KEY_BASE64, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  return buf;
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((x) => x.toString("base64url")).join(".");
}

export function decryptSecret(value: string): string {
  const [ivRaw, tagRaw, ciphertextRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !ciphertextRaw) throw new Error("Malformed encrypted secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
