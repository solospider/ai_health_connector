import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  BASE_URL: z.string().url().default("http://localhost:8787"),
  DATABASE_URL: z.string().min(1),
  OURA_CLIENT_ID: z.string().min(1),
  OURA_CLIENT_SECRET: z.string().min(1),
  OURA_REDIRECT_URI: z.string().url(),
  OURA_SCOPES: z.string().default("daily heartrate workout spo2"),
  TOKEN_ENCRYPTION_KEY_BASE64: z.string().min(1),
  DEV_USER_ID: z.string().uuid().default("00000000-0000-0000-0000-000000000001")
});

export const env = Env.parse(process.env);
