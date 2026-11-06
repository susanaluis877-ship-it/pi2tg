import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { loadConfig, type Config } from "./core.ts";

/** Bound to the trusted Pi session cwd, never tool cwd or inherited credentials. */
export function readConfig(cwd: string, trusted: boolean): Config | undefined {
  if (!trusted) return;
  let contents: string;
  try {
    contents = readFileSync(join(cwd, ".pi", "pi2tg.env"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  return loadConfig(parseEnv(contents));
}
