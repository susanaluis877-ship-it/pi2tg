import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDelivery, MAX_DELIVERY_BYTES } from "../src/delivery.ts";

test("delivery accepts project artifacts and rejects sensitive/escaping/linked/oversize files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi2tg-delivery-"));
  try {
    await mkdir(join(root, "reports"));
    await writeFile(join(root, "reports", "result.md"), "# result");
    const file = await readDelivery(root, "reports/result.md");
    assert.equal(file.name, "result.md");
    assert.equal(file.bytes.toString(), "# result");
    await assert.rejects(readDelivery(root, "../escape"));
    await assert.rejects(readDelivery(root, "reports"));
    for (const name of [".env", ".env.local", "secret.key", "pi2tg.env", "credentials.json"]) {
      await writeFile(join(root, name), "secret");
      await assert.rejects(readDelivery(root, name));
    }
    await symlink(join(root, "reports"), join(root, "alias"));
    await assert.rejects(readDelivery(root, "alias/result.md"));
    await symlink(join(root, ".env"), join(root, "report.txt"));
    await assert.rejects(readDelivery(root, "report.txt"));
    await link(join(root, ".env"), join(root, "hard.txt"));
    await assert.rejects(readDelivery(root, "hard.txt"));
    await writeFile(join(root, "large"), Buffer.alloc(MAX_DELIVERY_BYTES + 1));
    await assert.rejects(readDelivery(root, "large"));
    await assert.rejects(readDelivery(root, "reports/result.md", AbortSignal.abort()));
  } finally { await rm(root, { recursive: true, force: true }); }
});
