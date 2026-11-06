import { test } from "node:test";
import assert from "node:assert/strict";
import { Buttons } from "../src/buttons.ts";

test("opaque callbacks are bounded, single-use and bound to execution generation", () => {
  const buttons = new Buttons();
  const key = buttons.keyboard([[{ text: "model", command: "/model " + "x".repeat(200), generation: 1 }]]).inline_keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(key) <= 64);
  assert.equal(buttons.take(key, 2), undefined);
  const valid = buttons.keyboard([[{ text: "stop", command: "/stop", generation: 2, confirm: true }]]).inline_keyboard[0][0].callback_data;
  assert.equal(buttons.take(valid, 2)?.confirm, true);
  assert.equal(buttons.take(valid, 2), undefined);
});

test("cancel consumes confirmation and expired/reloaded buttons do not work", () => {
  let now = 0;
  const buttons = new Buttons(() => now);
  const row = buttons.keyboard([[{ text: "yes", command: "/stop" }, { text: "cancel", command: "/cancel-button" }]]).inline_keyboard[0];
  assert.equal(buttons.take(row[1].callback_data, 0)?.command, "/cancel-button");
  assert.equal(buttons.take(row[0].callback_data, 0), undefined);
  const key = buttons.keyboard([[{ text: "status", command: "/status" }]]).inline_keyboard[0][0].callback_data;
  assert.equal(new Buttons().take(key, 0), undefined);
  now = 16 * 60_000;
  assert.equal(buttons.take(key, 0), undefined);
});
