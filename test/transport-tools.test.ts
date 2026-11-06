import { test } from "node:test";
import assert from "node:assert/strict";
import { Telegram } from "../src/telegram.ts";

test("file upload is multipart and a confirmed API receipt is returned", async () => {
  const previous = globalThis.fetch;
  let captured: RequestInit | undefined;
  let method = "";
  globalThis.fetch = (async (url: any, init: RequestInit) => {
    captured = init; method = String(url).split("/").at(-1)!;
    return Response.json({ ok: true, result: { message_id: 55 } });
  }) as typeof fetch;
  const bot = new Telegram({ token: "123:test", userId: 42 }, () => {});
  try {
    const result = await bot.sendFile({ bytes: Buffer.from("report"), name: "report.md", mime: "text/plain" }, "交付物", false);
    assert.equal(result.message_id, 55);
    assert.equal(method, "sendDocument");
    const form = captured!.body as FormData;
    assert.equal(form.get("chat_id"), "42");
    assert.equal(form.get("caption"), "交付物");
    assert.equal(await (form.get("document") as Blob).text(), "report");
    assert.equal(captured!.headers, undefined, "fetch must generate the multipart boundary");
  } finally { await bot.close(); globalThis.fetch = previous; }
});

test("queued cancelled question is not sent; shutdown rejects pending tool requests", async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (_: any, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string).text);
    return Response.json({ ok: true, result: { message_id: 55 } });
  }) as typeof fetch;
  const bot = new Telegram({ token: "123:test", userId: 42 }, () => {});
  try {
    bot.send("occupy sender");
    const controller = new AbortController();
    const question = bot.sendQuestion("must not send", { inline_keyboard: [] }, controller.signal);
    const rejected = assert.rejects(question);
    controller.abort();
    await rejected;
    const pending = bot.sendQuestion("also must not send", { inline_keyboard: [] }, new AbortController().signal);
    const shutdownRejected = assert.rejects(pending);
    await bot.close();
    await shutdownRejected;
    assert.deepEqual(calls, ["occupy sender"]);
  } finally { await bot.close(); globalThis.fetch = previous; }
});

test("ambiguous upload failures reject without automatic duplicate upload", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("connection lost with secret URL"); }) as typeof fetch;
  const bot = new Telegram({ token: "123:test", userId: 42 }, () => {});
  try {
    await assert.rejects(bot.sendFile({ bytes: Buffer.from("x"), name: "a.txt", mime: "text/plain" }, "", false), /可能已送达/);
    assert.equal(calls, 1);
  } finally { await bot.close(); globalThis.fetch = previous; }
});
