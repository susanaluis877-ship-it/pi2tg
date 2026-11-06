import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { acquireBotLock } from "../src/lock.ts";

test("trusted session config is isolated, reread on reload, no environment fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi2tg-"));
  try {
    assert.equal(readConfig(dir, true), undefined);
    mkdirSync(join(dir, ".pi"));
    const path = join(dir, ".pi", "pi2tg.env");
    writeFileSync(path, 'PI2TG_BOT_TOKEN="123:first"\nPI2TG_USER_ID=42\n');
    assert.equal(readConfig(dir, false), undefined);
    assert.deepEqual(readConfig(dir, true), { token: "123:first", userId: 42 });
    writeFileSync(path, 'PI2TG_BOT_TOKEN=123:second\nPI2TG_USER_ID=43\n');
    assert.deepEqual(readConfig(dir, true), { token: "123:second", userId: 43 });
    writeFileSync(path, 'PI2TG_BOT_TOKEN=$(echo unsafe)\nPI2TG_USER_ID=42\n');
    assert.throws(() => readConfig(dir, true));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("same bot cannot be locked twice, rotation does not bypass lock, release is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi2tg-lock-"));
  const release = await acquireBotLock("123:first", () => {}, dir);
  try {
    await assert.rejects(acquireBotLock("123:rotated", () => {}, dir), { code: "ELOCKED" });
    const other = await acquireBotLock("456:other", () => {}, dir);
    await other();
    await release();
    await release();
    const next = await acquireBotLock("123:rotated", () => {}, dir);
    await next();
  } finally { await release(); rmSync(dir, { recursive: true, force: true }); }
});
