import path from "node:path";
import fs from "node:fs";

export const APP_ROOT = process.env.DSHQQ_ROOT || process.cwd();
export const DATA_ROOT = path.join(APP_ROOT, "dsh-data");
export const CONFIG_DIR = path.join(DATA_ROOT, "config");
export const CONFIG_FILE = path.join(CONFIG_DIR, "app.json");
export const FEED_DIR = path.join(DATA_ROOT, "feed");

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
