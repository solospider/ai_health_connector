import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  BASE_URL: z.string().url().default("http://localhost:8787"),
  DATABASE_URL: z.string().min(1),
  OURA_CLIENT_ID: z.string().min(1),
  OURA_CLIENT_SECRET: z.string().min(1),
  OURA_REDIRECT_URI: z.string().url().optional(),
  OURA_SCOPES: z.string().default("daily heartrate workout spo2"),
  TOKEN_ENCRYPTION_KEY_BASE64: z.string().min(1),
  DEV_USER_ID: z.string().uuid().default("00000000-0000-0000-0000-000000000001"),
  AUTH_REQUIRED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  REGISTRATION_INVITE_CODE: z.string().min(1).optional(),
  BACKGROUND_SYNC_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  BACKGROUND_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  BACKGROUND_SYNC_RECENT_DAYS: z.coerce.number().int().min(1).max(30).default(3),
  BACKGROUND_SYNC_STARTUP_DELAY_SECONDS: z.coerce.number().int().min(0).max(300).default(10)
});

const parsed = Env.parse(process.env);

export const env = {
  ...parsed,
  OURA_REDIRECT_URI:
    parsed.OURA_REDIRECT_URI ?? new URL("/auth/oura/callback", parsed.BASE_URL).toString()
};
