import { test } from "node:test";
import assert from "node:assert/strict";
import { Progress, toolLabel } from "../src/progress.ts";
import { Telegram, type Panel } from "../src/telegram.ts";

test("parallel tools, bounded history, elapsed time and terminal states", () => {
  const p = new Progress("测试任务\n第二行", "/project", 1000);
  p.start("a", "read", { path: "/project/src/a.ts" }, 2000);
  p.start("b", "bash", { command: "npm test --token=secret" }, 3000);
  assert.match(p.render(2, 10000), /2 个工具并行/);
  assert.match(p.render(2, 10000), /src\/a.ts/);
  assert.ok(!p.render(2, 10000).includes("secret"));
  p.end("b", "bash", true);
  assert.equal(p.active.size, 1);
  p.end("a", "read", false);
  assert.equal(p.recent.length, 3);
  assert.equal(p.errors, 1);
  p.finish(false, 12000);
  assert.match(p.render(0, 999999), /执行已结束 · 0分11秒/);
  assert.ok(!p.render(0).includes("当前："));
});

test("tool summaries hide external paths, command arguments and raw output", () => {
  assert.equal(toolLabel("read", { path: "/private/secret" }, "/project"), "read · [项目外路径]");
  assert.equal(toolLabel("bash", { command: "TOKEN=secret curl https://example.com" }, "/project"), "运行命令（参数已隐藏）");
  assert.equal(toolLabel("bash", { command: "git diff --password=secret" }, "/project"), "命令 · git diff");
});

test("panel creates once, coalesces pending snapshots, then edits the same message", async () => {
  const previous = globalThis.fetch;
  const calls: { method: string; body: any }[] = [];
  let release: (() => void) | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    const method = String(url).split("/").at(-1)!;
    calls.push({ method, body: JSON.parse(init.body) });
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ ok: true, result: { message_id: 123 } });
  }) as typeof fetch;
  const telegram = new Telegram({ token: "123:test", userId: 42 }, () => {});
  try {
    const panel: Panel = { text: "", queued: false };
    telegram.updatePanel(panel, "start");
    telegram.updatePanel(panel, "intermediate");
    telegram.updatePanel(panel, "finished");
    release!();
    await new Promise(resolve => setTimeout(resolve, 1250));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "sendMessage");
    assert.equal(calls[1].method, "editMessageText");
    assert.equal(calls[1].body.message_id, 123);
    assert.equal(calls[1].body.text, "finished");
  } finally { await telegram.close(); globalThis.fetch = previous; }
});
