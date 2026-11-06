import { isAbsolute, relative } from "node:path";

const short = (s: string, n = 80) => s.replace(/[\r\n\t\x00-\x1f]/g, " ").slice(0, n);
export function toolLabel(name: string, args: unknown, cwd: string): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (["read", "write", "edit", "ls", "find", "grep"].includes(name)) {
    const path = typeof a.path === "string" ? a.path : "";
    const local = isAbsolute(path) ? relative(cwd, path) : path;
    return `${name}${local ? ` · ${local.startsWith("..") ? "[项目外路径]" : short(local)}` : ""}`;
  }
  // Never show arbitrary command arguments, URLs, environment assignments, or tool output.
  if (name === "bash" || name === "powershell") {
    const command = typeof a.command === "string" ? a.command.trim() : "";
    const safe = /^(npm test|npm run (?:test|typecheck|build)|git (?:diff|status))(?:\s|$)/.exec(command);
    return safe ? `命令 · ${safe[1]}` : "运行命令（参数已隐藏）";
  }
  return short(name);
}

export class Progress {
  started: number;
  ended?: number;
  state = "⏳ 正在执行";
  activity = "等待模型响应";
  total = 0;
  errors = 0;
  counts = { read: 0, change: 0, command: 0, other: 0 };
  active = new Map<string, { label: string; started: number }>();
  recent: string[] = [];
  constructor(public task: string, private cwd: string, now = Date.now()) { this.started = now; }
  start(id: string, name: string, args: unknown, now = Date.now()) {
    if (this.active.has(id)) return;
    const label = toolLabel(name, args, this.cwd);
    this.active.set(id, { label, started: now });
    this.total++;
    const category = ["read", "ls", "find", "grep"].includes(name) ? "read" : ["edit", "write"].includes(name) ? "change" : ["bash", "powershell"].includes(name) ? "command" : "other";
    this.counts[category]++;
    this.record(`→ ${label}`);
  }
  end(id: string, name: string, failed: boolean) {
    const item = this.active.get(id);
    this.active.delete(id);
    if (failed) this.errors++;
    this.record(`${failed ? "⚠" : "✓"} ${item?.label ?? short(name)}`);
    this.activity = "等待模型响应或后续操作";
  }
  record(line: string) { this.recent.push(line); this.recent = this.recent.slice(-3); }
  finish(aborted: boolean, now = Date.now()) {
    this.ended = now;
    this.state = aborted ? "⏹ 已中止" : "✅ 执行已结束";
    this.active.clear();
  }
  render(pending: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.floor(((this.ended ?? now) - this.started) / 1000));
    const elapsed = `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    const active = [...this.active.values()];
    const current = this.state.includes("等待终端") ? "请回到终端处理确认或输入" : active.length ? `${active.length > 1 ? `${active.length} 个工具并行\n` : ""}${active.slice(0, 2).map(t => `${t.label} · ${Math.max(0, Math.floor((now - t.started) / 1000))}秒`).join("\n")}` : this.activity;
    return `${this.state} · ${elapsed}\n任务：${short(this.task || "当前会话任务", 100)}\n\n${this.ended === undefined ? `当前：${current}\n\n` : ""}读取 ${this.counts.read}次 · 修改 ${this.counts.change}次 · 命令 ${this.counts.command}次 · 其他 ${this.counts.other}次\n工具调用 ${this.total}次 · 失败 ${this.errors}次\nTelegram 待办 ${pending}条${this.recent.length ? `\n\n最近活动\n${this.recent.join("\n")}` : ""}`;
  }
}
