import crypto from "node:crypto";
import { promisify } from "node:util";
import { db } from "../db/pool.js";
import { env } from "../config.js";

const scrypt = promisify(crypto.scrypt);

export type AuthSession = {
  userId: string;
  token: string;
  expiresAt: string;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password: string) {
  return password.length >= 12 && password.length <= 256;
}

async function passwordHash(password: string) {
  const salt = crypto.randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function passwordMatches(password: string, encoded: string) {
  const [algorithm, saltEncoded, hashEncoded] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltEncoded || !hashEncoded) return false;
  const salt = Buffer.from(saltEncoded, "base64url");
  const expected = Buffer.from(hashEncoded, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sessionTokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createSession(userId: string): Promise<AuthSession> {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sessionTokenHash(token);
  const result = await db.query(
    `INSERT INTO sessions(user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 day'))
     RETURNING expires_at`,
    [userId, tokenHash, env.SESSION_TTL_DAYS]
  );
  const expiresAt = new Date(result.rows[0].expires_at).toISOString();
  return { userId, token, expiresAt };
}

export async function registerUser(emailInput: string, password: string, inviteCode?: string) {
  const email = normalizeEmail(emailInput);
  if (!validateEmail(email)) throw new Error("Invalid email address");
  if (!validatePassword(password)) throw new Error("Password must be 12-256 characters");
  if (env.REGISTRATION_INVITE_CODE && inviteCode !== env.REGISTRATION_INVITE_CODE) {
    throw new Error("Invalid registration invite code");
  }

  const hash = await passwordHash(password);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO users(id, email, password_hash, timezone)
       VALUES (gen_random_uuid(), $1, $2, 'UTC')
       RETURNING id, email, timezone, created_at`,
      [email, hash]
    );
    await client.query("COMMIT");
    const row = inserted.rows[0];
    const session = await createSession(String(row.id));
    return {
      user: {
        id: String(row.id),
        email: String(row.email),
        timezone: String(row.timezone),
        created_at: new Date(row.created_at).toISOString()
      },
      session
    };
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") throw new Error("Email is already registered");
    throw error;
  } finally {
    client.release();
  }
}

export async function loginUser(emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  const result = await db.query(
    `SELECT id, email, password_hash, timezone, created_at
       FROM users
      WHERE lower(email)=lower($1)
      LIMIT 1`,
    [email]
  );
  const row = result.rows[0];
  if (!row?.password_hash || !(await passwordMatches(password, String(row.password_hash)))) {
    throw new Error("Invalid email or password");
  }
  const session = await createSession(String(row.id));
  return {
    user: {
      id: String(row.id),
      email: String(row.email),
      timezone: String(row.timezone),
      created_at: new Date(row.created_at).toISOString()
    },
    session
  };
}

export async function authenticateSessionToken(token: string): Promise<string | null> {
  if (!token) return null;
  const result = await db.query(
    `UPDATE sessions
        SET last_used_at=now()
      WHERE token_hash=$1 AND expires_at > now()
      RETURNING user_id`,
    [sessionTokenHash(token)]
  );
  return result.rowCount === 1 ? String(result.rows[0].user_id) : null;
}

export async function revokeSessionToken(token: string) {
  if (!token) return;
  await db.query(`DELETE FROM sessions WHERE token_hash=$1`, [sessionTokenHash(token)]);
}
