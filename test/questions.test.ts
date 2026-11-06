import { test } from "node:test";
import assert from "node:assert/strict";
import { Questions } from "../src/questions.ts";
import type { Telegram } from "../src/telegram.ts";

function fixture() {
  let keyboard: any;
  const closed: string[] = [];
  const bot = {
    sendQuestion: async (_: string, k: any) => { keyboard = k; return { message_id: 123 }; },
    finishQuestion: (_: number, text: string) => closed.push(text),
  } as unknown as Telegram;
  return { bot, closed, key: (i = 0) => keyboard.inline_keyboard[i][0].callback_data as string };
}

test("single-choice question is single-use, concurrent asks rejected", async () => {
  const f = fixture(); const q = new Questions();
  const result = q.ask(f.bot, "选择", ["A", "B"], 300, undefined, () => {});
  await assert.rejects(q.ask(f.bot, "另一题", [], 300, undefined, () => {}));
  await Promise.resolve();
  assert.equal(q.answerButton("ask:forged:0"), false);
  assert.equal(q.answerButton(f.key(1)), true);
  assert.deepEqual(await result, { status: "answered", answer: "B" });
  assert.equal(q.answerButton(f.key(0)), false);
  assert.equal(f.closed.length, 1);
});

test("free text must reply to the matching message", async () => {
  const f = fixture(); const q = new Questions();
  const result = q.ask(f.bot, "请输入", [], 300, undefined, () => {});
  await Promise.resolve();
  assert.equal(q.answerText(999, "bad"), false);
  assert.equal(q.answerText(123, ""), false);
  assert.equal(q.answerText(123, "  hello  "), true);
  assert.deepEqual(await result, { status: "answered", answer: "hello" });
});

test("timed-out buttons submit a new instruction exactly once; full queue retains answerability", async () => {
  const f = fixture();
  const submissions: string[] = [];
  let accept = false;
  const q = new Questions((question, answer) => {
    if (!accept) return false;
    submissions.push(`${question}: ${answer}`); return true;
  });
  assert.deepEqual(await q.ask(f.bot, "选择", ["A", "B"], 0.001, undefined, () => {}), { status: "timeout" });
  assert.equal(q.active, false);
  assert.equal(q.answerButton(f.key(1)), false);
  accept = true;
  assert.equal(q.answerButton(f.key(1)), true);
  assert.equal(q.answerButton(f.key(1)), false);
  assert.deepEqual(submissions, ["选择: B"]);
});

test("late replies must match message ID and expire on stop, reload or TTL", async () => {
  const f = fixture();
  let now = 0;
  const submissions: string[] = [];
  const q = new Questions((_question, answer) => { submissions.push(answer); return true; }, () => now);
  await q.ask(f.bot, "text", [], 0.001, undefined, () => {});
  assert.equal(q.answerText(999, "wrong"), false);
  assert.equal(q.answerText(123, "correct"), true);
  assert.deepEqual(submissions, ["correct"]);
  await q.ask(f.bot, "stop", [], 0.001, undefined, () => {});
  q.cancel();
  assert.equal(q.answerText(123, "stale"), false);
  await q.ask(f.bot, "TTL", ["A"], 0.001, undefined, () => {});
  assert.equal(new Questions().answerButton(f.key()), false);
  now = 24 * 60 * 60_000;
  assert.equal(q.answerButton(f.key()), false);
  assert.deepEqual(submissions, ["correct"]);
});

test("abort, reload cancellation, timeout and failed delivery never imply consent", async () => {
  const f = fixture(); const q = new Questions();
  const controller = new AbortController();
  const result = q.ask(f.bot, "选择", [], 300, controller.signal, () => {});
  controller.abort();
  assert.deepEqual(await result, { status: "cancelled" });
  const next = q.ask(f.bot, "选择", [], 300, undefined, () => {});
  q.cancel();
  assert.deepEqual(await next, { status: "cancelled" });
  assert.deepEqual(await q.ask(f.bot, "选择", [], 0.001, undefined, () => {}), { status: "timeout" });
  const bad = { ...f.bot, sendQuestion: async () => { throw new Error("network"); } } as unknown as Telegram;
  assert.deepEqual(await q.ask(bad, "选择", [], 300, undefined, () => {}), { status: "failed" });
  assert.equal(q.active, false);
});
