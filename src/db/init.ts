import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db } from "./pool.js";
import { env } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));
const sql = await readFile(join(here, "schema.sql"), "utf8");
await db.query(sql);
await db.query(
  `INSERT INTO users(id, timezone) VALUES ($1, 'America/Los_Angeles') ON CONFLICT (id) DO NOTHING`,
  [env.DEV_USER_ID]
);
console.log("database initialized");
await db.end();
