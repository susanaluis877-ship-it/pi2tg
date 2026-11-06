import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../src/index.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("extension integration: queue, steer boundary, stop, auth and shutdown", async () => {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.PI2TG_BOT_TOKEN;
  const oldUser = process.env.PI2TG_USER_ID;
  process.env.PI2TG_BOT_TOKEN = "123:test";
  process.env.PI2TG_USER_ID = "42";
  const cwd = mkdtempSync(join(tmpdir(), "pi2tg-integration-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "pi2tg.env"), `PI2TG_BOT_TOKEN=${process.pid}:test\nPI2TG_USER_ID=42\n`);
  const handlers = new Map<string, (...args: any[]) => any>();
  const submitted: string[] = [];
  const commands = new Map<string, any>();
  let reloads = 0;
  const switched: string[] = [];
  const available = [{ provider: "test", id: "vision", input: ["text", "image"] }];
  let idle = true;
  let aborts = 0;
  let fileRequests = 0;
  let imageSubmitted: any;
  let holdFile = false;
  let releaseFile: (() => void) | undefined;
  let resolvePoll: ((value: Response) => void) | undefined;
  const ok = (result: unknown) => Response.json({ ok: true, result });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").at(-1);
    if (method === "getFile") {
      fileRequests++;
      if (holdFile) await new Promise<void>(resolve => { releaseFile = resolve; });
      return ok({ file_path: "photos/test.png" });
    }
    if (method === "test.png") return new Response(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]));
    if (method === "getWebhookInfo") return ok({ url: "" });
    if (method === "getUpdates") {
      const body = JSON.parse(init?.body as string);
      if (body.offset === -1) return ok([{ update_id: 100 }]);
      return new Promise<Response>((resolve, reject) => {
        resolvePoll = resolve;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return ok({});
  }) as typeof fetch;
  const context = {
    model: { provider: "test", id: "vision", input: ["text", "image"] },
    modelRegistry: { getAvailable: () => available },
    cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "test-session" },
    mode: "tui", isIdle: () => idle, hasPendingMessages: () => false,
    abort: () => { aborts++; }, ui: { notify() {}, setStatus() {} },
  };
  extension({
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
    setModel: async (model: any) => { switched.push(model.id); return true; },
    registerCommand: (name: string, command: any) => { commands.set(name, command); },
    sendUserMessage: (text: string, options?: any) => {
      if (Array.isArray(text)) { imageSubmitted = text; idle = false; return; }
      submitted.push(text);
      if (text === "/pi2tg-reload") {
        assert.equal(options.expandPromptTemplates, true);
        void commands.get("pi2tg-reload").handler("", {
          waitForIdle: async () => { assert.equal(idle, true); },
          reload: async () => { reloads++; },
        });
      } else idle = false;
    },
  } as unknown as ExtensionAPI);
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  let updateId = 101;
  const send = async (text: string, userId = 42) => {
    resolvePoll!(ok([{ update_id: updateId++, message: { from: { id: userId }, chat: { id: userId, type: "private" }, text } }]));
    await tick();
  };
  try {
    await handlers.get("session_start")!({}, context);
    await send("/model test/vision", 43);
    assert.deepEqual(switched, []);
    await send("/models");
    await send("/model missing");
    assert.deepEqual(switched, []);
    await send("/model test/vision");
    assert.deepEqual(switched, ["vision"]);
    idle = false;
    await send("/model test/vision");
    assert.deepEqual(switched, ["vision"], "busy model switches must be rejected");
    idle = true;
    const photo = (id: number) => ({ update_id: updateId++, message: { from: { id }, chat: { id, type: "private" }, caption: "检查截图", photo: [{ file_id: "image-id", width: 100, height: 100 }] } });
    resolvePoll!(ok([photo(43)]));
    await tick();
    assert.equal(fileRequests, 0);
    resolvePoll!(ok([photo(42)]));
    await tick();
    assert.equal(fileRequests, 1);
    assert.equal(imageSubmitted[0].text, "检查截图");
    assert.equal(imageSubmitted[1].mimeType, "image/png");
    handlers.get("agent_start")!({}, context);
    idle = true;
    handlers.get("agent_settled")!({ aborted: false }, context);
    await tick();
    imageSubmitted = undefined;
    holdFile = true;
    resolvePoll!(ok([photo(42)]));
    await tick();
    await send("/stop");
    releaseFile!();
    await tick();
    assert.equal(imageSubmitted, undefined, "cancelled downloads cannot submit after /stop");
    holdFile = false;
    aborts = 0;
    await send("unauthorized", 43);
    assert.deepEqual(submitted, []);
    await send("first");
    handlers.get("agent_start")!({}, context);
    await send("second");
    await send("/steer use existing library");
    const boundary = handlers.get("turn_end")!({ outcome: "completed", entries: [] });
    assert.equal(boundary.continue, true);
    assert.match(boundary.entries[0].content, /use existing library/);
    assert.deepEqual(submitted, ["first"]);
    await send("/steer must be cancelled");
    await send("/stop");
    assert.equal(aborts, 1);
    assert.equal(handlers.get("turn_end")!({ outcome: "completed", entries: [] }), undefined);
    idle = true;
    handlers.get("agent_settled")!({ aborted: true }, context);
    await tick();
    assert.deepEqual(submitted, ["first"]);
    await send("fresh task");
    assert.deepEqual(submitted, ["first", "fresh task"]);
    handlers.get("agent_start")!({}, context);
    await send("queued normally");
    idle = true;
    handlers.get("agent_settled")!({ aborted: false }, context);
    await tick();
    assert.deepEqual(submitted, ["first", "fresh task", "queued normally"]);
    handlers.get("agent_start")!({}, context);
    await send("must not run after reload");
    await send("/reload", 43);
    assert.equal(reloads, 0);
    await send("/reload");
    await send("/reload");
    await send("rejected while reload pending");
    assert.equal(reloads, 0);
    idle = true;
    handlers.get("agent_settled")!({ aborted: false }, context);
    await tick();
    assert.equal(reloads, 1);
    assert.deepEqual(submitted, ["first", "fresh task", "queued normally", "/pi2tg-reload"]);
  } finally {
    await handlers.get("session_shutdown")!();
    rmSync(cwd, { recursive: true, force: true });
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.PI2TG_BOT_TOKEN; else process.env.PI2TG_BOT_TOKEN = oldToken;
    if (oldUser === undefined) delete process.env.PI2TG_USER_ID; else process.env.PI2TG_USER_ID = oldUser;
  }
});
