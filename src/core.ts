import type { UserContent } from "./images.ts";

export interface Config { token: string; userId: number }

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.PI2TG_BOT_TOKEN?.trim() ?? "";
  const userId = Number(env.PI2TG_USER_ID);
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("请设置有效的 PI2TG_BOT_TOKEN");
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("请设置正整数 PI2TG_USER_ID");
  return { token, userId };
}

export interface Update {
  update_id: number;
  callback_query?: {
    id: string; from: { id: number; is_bot?: boolean }; data?: string;
    message?: { chat: { id: number; type: string } };
  };
  message?: {
    from?: { id: number; is_bot?: boolean }; chat: { id: number; type: string }; text?: string;
    caption?: string;
    photo?: { file_id: string; width: number; height: number; file_size?: number }[];
    document?: { file_id: string; mime_type?: string; file_size?: number; file_name?: string };
  };
}

export function authorized(update: Update, userId: number): boolean {
  const m = update.message;
  return !!m && m.chat.type === "private" && m.chat.id === userId && m.from?.id === userId && !m.from.is_bot;
}

/** Conservative UTF-16 limit; never split a surrogate pair. Plain text, no parse_mode. */
export function chunks(text: string, limit = 3800): string[] {
  if (limit < 2) throw new Error("limit must be >= 2");
  const parts: string[] = [];
  let part = "";
  for (const c of text) {
    if (part.length + c.length > limit) { parts.push(part); part = ""; }
    part += c;
  }
  if (part) parts.push(part);
  return parts;
}

export class Inbox {
  tasks: UserContent[] = [];
  steering: string[] = [];
  stopping = false;
  reserved = false;
  enqueue(text: string, steer: boolean): boolean {
    if (this.stopping || this.tasks.length + this.steering.length >= 50) return false;
    (steer ? this.steering : this.tasks).push(text);
    return true;
  }
  enqueueImage(content: UserContent): boolean {
    // Bound base64 memory separately from the text queue (maximum five images).
    if (this.stopping || this.tasks.length + this.steering.length >= 50 || this.tasks.filter(t => typeof t !== "string").length >= 5) return false;
    this.tasks.push(content);
    return true;
  }
  stop(): number {
    const n = this.tasks.length + this.steering.length;
    this.tasks = []; this.steering = []; this.stopping = true;
    return n;
  }
  takeTask(): UserContent | undefined {
    if (this.stopping || this.reserved) return;
    const task = this.tasks.shift();
    if (task !== undefined) this.reserved = true;
    return task;
  }
  takeSteering(): string[] {
    if (this.stopping) return [];
    return this.steering.splice(0);
  }
  settled() { this.reserved = false; this.stopping = false; }
}
