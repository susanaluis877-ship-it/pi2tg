import { randomBytes } from "node:crypto";
import type { Telegram } from "./telegram.ts";
import type { Keyboard } from "./buttons.ts";

export interface Answer { status: "answered" | "cancelled" | "timeout" | "failed"; answer?: string }
interface Pending {
  key: string; question: string; options: string[]; messageId?: number;
  finish: (answer: Answer) => void;
  close: (text: string) => void;
}
const LATE_TTL = 24 * 60 * 60_000;

export class Questions {
  private pending?: Pending;
  private late = new Map<string, { question: Pending; expires: number }>();
  constructor(private submitLate: (question: string, answer: string) => boolean = () => false, private now = () => Date.now()) {}
  get active() { return !!this.pending; }
  cancel() {
    this.pending?.finish({ status: "cancelled" });
    for (const { question } of this.late.values()) question.close("已取消，不再接受补答。");
    this.late.clear();
  }
  private prune() {
    for (const [key, item] of this.late) {
      if (item.expires <= this.now()) {
        this.late.delete(key);
        item.question.close("补答期限已过。");
      }
    }
  }
  private complete(p: Pending, answer: string): boolean {
    if (p === this.pending) p.finish({ status: "answered", answer });
    else {
      // Keep the question available if the task queue is full or stopping.
      if (!this.submitLate(p.question, answer)) return false;
      this.late.delete(p.key);
      p.close(`已接收补答并作为新的继续任务指令提交：${answer}`);
    }
    return true;
  }
  answerButton(data: string): boolean {
    this.prune();
    const key = data.slice(0, data.lastIndexOf(":"));
    const p = this.pending?.key === key ? this.pending : this.late.get(key)?.question;
    if (!p) return false;
    const choice = data.slice(key.length + 1);
    if (choice === "cancel") {
      if (p === this.pending) p.finish({ status: "cancelled" });
      else { this.late.delete(key); p.close("已取消，不再接受补答。"); }
      return true;
    }
    if (!/^\d+$/.test(choice) || !p.options[Number(choice)]) return false;
    return this.complete(p, p.options[Number(choice)]);
  }
  answerText(messageId: number, text: string): boolean {
    this.prune();
    const p = this.pending?.messageId === messageId ? this.pending : [...this.late.values()].find(item => item.question.messageId === messageId)?.question;
    return !!p && !!text.trim() && this.complete(p, text.trim());
  }
  async ask(bot: Telegram, question: string, options: string[], timeoutSeconds: number, signal: AbortSignal | undefined, changed: () => void): Promise<Answer> {
    if (this.pending) throw new Error("已有问题等待回答");
    if (signal?.aborted) return { status: "cancelled" };
    this.prune();
    const controller = new AbortController();
    const key = `ask:${randomBytes(10).toString("hex")}`;
    const keyboard: Keyboard = { inline_keyboard: [
      ...options.map((text, i) => [{ text, callback_data: `${key}:${i}` }]),
      [{ text: "取消回答", callback_data: `${key}:cancel` }],
    ] };
    return new Promise<Answer>(resolve => {
      let finished = false;
      let result: Answer;
      let closingText: string | undefined;
      const close = (text: string) => {
        closingText = text;
        if (pending.messageId !== undefined) bot.finishQuestion(pending.messageId, `问题：${question}\n\n${text}`.slice(0, 3800));
      };
      const renderEnd = () => {
        if (closingText) { close(closingText); return; }
        if (pending.messageId === undefined) return;
        if (result.status === "timeout" && this.late.has(key)) {
          bot.finishQuestion(pending.messageId, `问题：${question}\n\n等待已超时，未选择任何答案。\n仍可在 24 小时内点击选项或回复本消息补答；将作为新的继续任务指令提交。重载、切换会话或 /stop 后失效。`, keyboard);
        } else close(result.status === "answered" ? `已收到回答：${result.answer}` : `问题已关闭（${result.status}），未获得回答。`);
      };
      const cancel = () => finish({ status: "cancelled" });
      const finish = (answer: Answer) => {
        if (finished) return;
        finished = true;
        result = answer;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        controller.abort();
        this.pending = undefined;
        if (answer.status === "timeout") {
          while (this.late.size >= 20) {
            const oldest = this.late.keys().next().value!;
            this.late.get(oldest)!.question.close("补答记录已清理。");
            this.late.delete(oldest);
          }
          this.late.set(key, { question: pending, expires: this.now() + LATE_TTL });
        }
        renderEnd();
        changed();
        resolve(answer);
      };
      const pending: Pending = { key, question, options, finish, close };
      const timer = setTimeout(() => finish({ status: "timeout" }), timeoutSeconds * 1000);
      this.pending = pending;
      signal?.addEventListener("abort", cancel, { once: true });
      changed();
      void bot.sendQuestion(`❓ ${question}\n\n请选择一个选项，或使用 Telegram「回复」本消息输入答案。\n${timeoutSeconds} 秒后超时；这不是权限审批。`, keyboard, controller.signal).then(message => {
        pending.messageId = message.message_id;
        if (finished) renderEnd();
      }).catch(() => finish({ status: "failed" }));
    });
  }
}
