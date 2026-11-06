import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { imageMime } from "./images.ts";

export const MAX_DELIVERY_BYTES = 10 * 1024 * 1024;
const denied = /^(?:\.env(?:\..*)?|.*\.env|\.git|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|pi2tg\.env|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;

export async function readDelivery(cwd: string, path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const root = await realpath(cwd);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("只能发送当前项目内的普通文件");
  let current = root;
  for (const part of rel.split(sep)) {
    if (denied.test(part)) throw new Error("禁止发送敏感路径");
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("不允许发送符号链接文件或穿过符号链接目录");
  }
  if (await realpath(target) !== target) throw new Error("文件路径发生变化");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("仅允许普通文件，不允许硬链接");
    if (stat.size === 0 || stat.size > MAX_DELIVERY_BYTES) throw new Error("文件必须非空且不超过 10 MiB");
    // Bounded read even if another process grows the file during reading.
    const buffer = Buffer.alloc(MAX_DELIVERY_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!size || size > MAX_DELIVERY_BYTES) throw new Error("文件必须非空且不超过 10 MiB");
    signal?.throwIfAborted();
    if (await realpath(target) !== target) throw new Error("文件路径发生变化");
    const after = await lstat(target);
    if (after.isSymbolicLink() || after.ino !== stat.ino || after.dev !== stat.dev || after.nlink !== 1) throw new Error("文件路径发生变化");
    const bytes = buffer.subarray(0, size);
    return { bytes, name: basename(target), mime: imageMime(bytes) ?? "application/octet-stream" };
  } finally { await file.close(); }
}
