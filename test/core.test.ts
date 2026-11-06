import { test } from "node:test";
import assert from "node:assert/strict";
import { authorized, chunks, Inbox, loadConfig } from "../src/core.ts";

test("configuration fails closed", () => {
  assert.throws(() => loadConfig({}));
  assert.throws(() => loadConfig({ PI2TG_BOT_TOKEN: "123:abc", PI2TG_USER_ID: "-1" }));
  assert.deepEqual(loadConfig({ PI2TG_BOT_TOKEN: "123:abc", PI2TG_USER_ID: "42" }), { token: "123:abc", userId: 42 });
});
test("only the configured user's private chat is authorized", () => {
  const update = { update_id: 1, message: { from: { id: 42 }, chat: { id: 42, type: "private" } } };
  assert.equal(authorized(update, 42), true);
  assert.equal(authorized(update, 43), false);
  assert.equal(authorized({ ...update, message: { ...update.message, chat: { id: 42, type: "group" } } }, 42), false);
  assert.equal(authorized({ update_id: 2 }, 42), false);
});
test("long Unicode results split losslessly within Telegram limits", () => {
  const text = "你好😀<>&_*\n".repeat(2000);
  const parts = chunks(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every(p => p.length <= 3800 && !/[\uD800-\uDBFF]$/.test(p)));
});
test("stop clears tasks and undelivered steering, blocks submissions until settlement", () => {
  const inbox = new Inbox();
  inbox.enqueue("first", false); inbox.enqueue("second", false); inbox.enqueue("correction", true);
  assert.equal(inbox.takeTask(), "first");
  assert.equal(inbox.takeTask(), undefined);
  assert.equal(inbox.stop(), 2);
  assert.equal(inbox.enqueue("late", false), false);
  assert.deepEqual(inbox.takeSteering(), []);
  inbox.settled();
  assert.equal(inbox.takeTask(), undefined);
  assert.equal(inbox.enqueue("new", false), true);
  assert.equal(inbox.takeTask(), "new");
});
test("steering drains once and queue is bounded", () => {
  const inbox = new Inbox();
  inbox.enqueue("correction", true);
  assert.deepEqual(inbox.takeSteering(), ["correction"]);
  assert.deepEqual(inbox.takeSteering(), []);
  for (let i = 0; i < 50; i++) assert.equal(inbox.enqueue(String(i), false), true);
  assert.equal(inbox.enqueue("overflow", true), false);
});
