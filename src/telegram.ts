import { setTimeout as delay } from "node:timers/promises";
import { chunks, type Config, type Update } from "./core.ts";
import { renderMarkdown, type RenderedMessage } from "./render.ts";
import { MAX_IMAGE_BYTES, readImage, type ImageContent } from "./images.ts";

import type { Keyboard } from "./buttons.ts";

const COMMANDS = [
  ["help", "帮助与控制按钮"], ["status", "查看执行状态"], ["models", "查看与选择模型"],
  ["model", "查看当前模型"], ["steer", "补充当前任务指令"], ["stop", "停止执行并清空待办"],
  ["reload", "空闲后重载插件"],
].map(([command, description]) => ({ command, description }));

class ApiError extends Error {
  constructor(public code: number, public retryAfter = 1, public notModified = false) { super(`Telegram API ${code}`); }
}

export interface Panel { id?: number; text: string; queued: boolean; disabled?: boolean }
type Message = RenderedMessage & { reply_markup?: Keyboard };
interface RequestJob { run: () => Promise<void>; cancel: () => void }
type Outgoing = Message | { panel: Panel } | RequestJob;

export class Telegram {
  private controller = new AbortController();
  private outbox: Outgoing[] = [];
  private sending = false;
  private polling?: Promise<void>;
  private sender?: Promise<void>;
  private offset = 0;
  constructor(private config: Config, private warn: (message: string) => void) {}

  private async call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.config.token}/${method}`, {
      method: "POST", ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(40_000), ...(signal ? [signal] : [])]),
    });
    const data = await response.json() as { ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number }; description?: string };
    if (!data.ok) throw new ApiError(data.error_code ?? response.status, data.parameters?.retry_after, data.description?.includes("message is not modified") ?? false);
    return data.result;
  }

  async start(onUpdate: (update: Update) => void): Promise<void> {
    await this.call("getMe", {});
    // Fail closed on a configured webhook rather than silently deleting it.
    const webhook = await this.call<{ url: string }>("getWebhookInfo", {});
    if (webhook.url) throw new Error("该 Bot 已设置 webhook；请先移除或使用专用 Bot");
    // Intentionally discard offline commands: never replay potentially destructive old work.
    const tail = await this.call<Update[]>("getUpdates", { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] });
    if (tail.length) this.offset = tail[tail.length - 1].update_id + 1;
    try {
      await this.call("setMyCommands", { commands: COMMANDS, scope: { type: "chat", chat_id: this.config.userId } });
      await this.call("setChatMenuButton", { chat_id: this.config.userId, menu_button: { type: "commands" } });
    } catch { this.warn("Telegram 命令菜单注册失败，文本命令仍可使用。"); }
    this.polling = this.poll(onUpdate);
  }

  async downloadImage(fileId: string, signal: AbortSignal): Promise<ImageContent> {
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    signal.throwIfAborted();
    if (!file.file_path || (file.file_size ?? 0) > MAX_IMAGE_BYTES) throw new Error("图片不可用或超过 10 MiB");
    const path = file.file_path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`https://api.telegram.org/file/bot${this.config.token}/${path}`, {
      signal: AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(30_000)]),
    });
    return readImage(response);
  }

  /** Tool requests share flood control with notifications. Never retry ambiguous sends. */
  private request<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    if (combined.aborted || this.outbox.length >= 500) return Promise.reject(new Error("发送已取消或队列已满"));
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, result?: T) => {
        if (done) return;
        done = true;
        combined.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve(result!);
      };
      const cancel = () => finish(new Error("发送已取消"));
      combined.addEventListener("abort", cancel, { once: true });
      this.outbox.push({ cancel, run: async () => {
        if (done) return;
        try {
          for (let attempt = 0; ; attempt++) {
            try { finish(undefined, await this.call<T>(method, body, combined)); break; }
            catch (error) {
              if (!(error instanceof ApiError) || error.code !== 429 || attempt >= 2) throw error;
              await delay(Math.min(60, error.retryAfter) * 1000, undefined, { signal: combined });
            }
          }
        } catch { finish(new Error("Telegram 发送失败或已取消；响应丢失时可能已送达，请勿盲目重试")); }
      }});
      if (!this.sending) this.sender = this.drain();
    });
  }

  sendQuestion(text: string, keyboard: Keyboard, signal: AbortSignal): Promise<{ message_id: number }> {
    return this.request("sendMessage", { chat_id: this.config.userId, text, reply_markup: keyboard }, signal);
  }

  finishQuestion(id: number, text: string, keyboard: Keyboard = { inline_keyboard: [] }): void {
    void this.request("editMessageText", { chat_id: this.config.userId, message_id: id, text, reply_markup: keyboard }).catch(() => {});
  }

  sendFile(file: { bytes: Uint8Array; name: string; mime: string }, caption: string, photo: boolean, signal?: AbortSignal): Promise<{ message_id: number }> {
    const form = new FormData();
    form.set("chat_id", String(this.config.userId));
    if (caption) form.set("caption", caption);
    form.set(photo ? "photo" : "document", new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
    return this.request(photo ? "sendPhoto" : "sendDocument", form, signal);
  }

  answerCallback(id: string, text: string): void {
    void this.call("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {});
  }

  send(text: string, markdown = false, keyboard?: Keyboard): void {
    if (this.controller.signal.aborted || !text.trim()) return;
    let parts: Message[];
    try {
      parts = markdown ? renderMarkdown(text) : chunks(text).map(text => ({ text }));
    } catch {
      parts = chunks(text).map(text => ({ text }));
    }
    if (this.outbox.length + parts.length > 500) {
      this.warn("Telegram 发送队列已满，部分通知未发送；请在终端查看完整结果。");
      return;
    }
    if (keyboard && parts.length) parts[parts.length - 1].reply_markup = keyboard;
    this.outbox.push(...parts);
    if (!this.sending) this.sender = this.drain();
  }

  updatePanel(panel: Panel, text: string): void {
    if (panel.disabled || this.controller.signal.aborted) return;
    panel.text = text;
    if (panel.queued) return; // Keep only the newest snapshot while network/limiter is busy.
    if (this.outbox.length >= 500) return;
    panel.queued = true;
    this.outbox.push({ panel });
    if (!this.sending) this.sender = this.drain();
  }

  private async pause(ms: number) {
    await delay(ms, undefined, { signal: this.controller.signal });
  }

  private async drain(): Promise<void> {
    this.sending = true;
    try {
      while (this.outbox.length && !this.controller.signal.aborted) {
        const job = this.outbox.shift()!;
        if ("run" in job) {
          await job.run();
          await this.pause(1100);
          continue;
        }
        const panel = "panel" in job ? job.panel : undefined;
        const message: RenderedMessage = panel ? { text: panel.text } : job as RenderedMessage;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            if (panel) {
              const result = await this.call<{ message_id: number }>(panel.id ? "editMessageText" : "sendMessage", {
                chat_id: this.config.userId, ...(panel.id ? { message_id: panel.id } : {}),
                text: message.text, link_preview_options: { is_disabled: true },
              });
              panel.id = result.message_id;
            } else try {
              await this.call("sendMessage", { chat_id: this.config.userId, ...message, link_preview_options: { is_disabled: true } });
            } catch (error) {
              if (!(error instanceof ApiError) || error.code !== 400 || !message.entities?.length) throw error;
              // Bad entity boundaries must never prevent the result from reaching the user.
              delete message.entities;
              await this.call("sendMessage", { chat_id: this.config.userId, ...message, link_preview_options: { is_disabled: true } });
            }
            break;
          } catch (error) {
            if (this.controller.signal.aborted) return;
            if (panel?.id && error instanceof ApiError && error.notModified) break;
            const permanent = error instanceof ApiError && error.code < 500 && error.code !== 429;
            if (permanent || attempt === 4) {
              if (panel) panel.disabled = true; // Do not create a new message on every failed edit.
              this.warn("Telegram 通知发送失败，请在终端查看结果或使用 /status。"); break;
            }
            await this.pause(error instanceof ApiError && error.code === 429 ? error.retryAfter * 1000 : 1000 * 2 ** attempt);
          }
        }
        if (panel) {
          panel.queued = false;
          if (panel.text !== message.text) this.updatePanel(panel, panel.text);
        }
        await this.pause(1100);
      }
    } catch { /* shutdown */ }
    finally { this.sending = false; }
  }

  private async poll(onUpdate: (update: Update) => void): Promise<void> {
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try {
        const updates = await this.call<Update[]>("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
        failures = 0;
        for (const update of updates) {
          if (this.controller.signal.aborted) return;
          if (update.update_id < this.offset) continue;
          this.offset = update.update_id + 1; // Claim before dispatch; handler failures never replay work.
          try { onUpdate(update); } catch { this.warn("Telegram 指令处理失败；未自动重试该指令。"); }
        }
      } catch (error) {
        if (this.controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403, 409].includes(error.code)) {
          this.warn(`Telegram 接收已停止（${error.code}），请检查 Token 或重复运行实例，然后 /reload。`);
          return;
        }
        if (failures++ === 0) this.warn("Telegram 接收暂时失败，正在重连。");
        try { await this.pause(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))); } catch { return; }
      }
    }
  }

  async close(): Promise<void> {
    this.controller.abort(); this.outbox = [];
    await Promise.allSettled([this.polling, this.sender]);
  }
}
