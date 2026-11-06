import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

/** Per-user, machine-local lock; heartbeats allow recovery after a crashed process. */
export async function acquireBotLock(
  token: string,
  onCompromised: () => void,
  directory = join(homedir(), ".pi", "pi2tg-locks"),
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Use the stable bot ID: rotating credentials must not bypass an existing lock.
  const key = createHash("sha256").update(token.split(":")[0]).digest("hex");
  const release = await lockfile.lock(join(directory, key), {
    realpath: false, stale: 120_000, update: 10_000, retries: 0,
    onCompromised: () => onCompromised(),
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await release();
  };
}
