import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorized, Inbox, type Update } from "./core.ts";
import { readConfig } from "./config.ts";
import { acquireBotLock } from "./lock.ts";
import { basename } from "node:path";
import { Telegram, type Panel } from "./telegram.ts";
import { Progress } from "./progress.ts";
import { Buttons } from "./buttons.ts";
import { MAX_IMAGE_BYTES } from "./images.ts";

const HELP = `pi2tg：控制当前终端会话
普通文本：空闲时执行，忙碌时排队
/steer 内容：当前轮工具执行完后补充指令
/status：查看状态
/models：列出可用模型
/model：查看当前模型
/model provider/model-id：空闲时切换模型
/stop：请求中止，并取消未投递的 Telegram 消息
/reload：空闲后热加载插件，取消未投递待办
/help：使用说明
支持文本、照片和图片文件（≤10 MiB）；图片说明一起提交。
图片不支持 /steer，相册按单张处理。权限确认仍需在终端处理。`;

export default function (pi: ExtensionAPI) {
  const buttons = new Buttons();
  let generation = 0;
  const controls = () => buttons.keyboard([
    [{ text: "📊 状态", command: "/status" }, { text: "🤖 模型", command: "/models" }],
    [{ text: "⏹ 停止", command: "/stop", generation, confirm: true }, { text: "🔄 重载", command: "/reload", generation, confirm: true }],
  ]);
  let ctx: ExtensionContext | undefined;
  let bot: Telegram | undefined;
  let releaseLock: (() => Promise<void>) | undefined;
  let inbox = new Inbox();
  let waiting = false;
  let running = false;
  let startedAt = 0;
  let progress: Progress | undefined;
  let panel: Panel | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let lastPanelUpdate = 0;
  let dirty = false;
  let taskSummary = "当前会话任务";
  let tools = 0;
  let errors = 0;
  let userId = 0;
  let reloadRequested = false;
  let reloadDispatched = false;
  let switchingModel = false;
  const downloads = new Set<AbortController>();
  const cancelDownloads = () => {
    for (const controller of downloads) controller.abort();
    downloads.clear();
  };
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;

  const say = (text: string) => bot?.send(text);
  const warn = (text: string) => ctx?.ui.notify(text, "warning");
  const refreshPanel = (urgent = false) => {
    if (!progress || !panel || !bot) return;
    if (progress.ended === undefined) {
      progress.state = inbox.stopping ? "⏹ 正在停止" : waiting ? "⏸ 等待终端确认" : reloadRequested ? "⏳ 执行中 · 结束后重载" : "⏳ 正在执行";
    }
    const now = Date.now();
    if (!urgent && now - lastPanelUpdate < (dirty ? 4000 : 15000)) return;
    bot.updatePanel(panel, progress.render(inbox.tasks.length, now));
    lastPanelUpdate = now;
    dirty = false;
  };

  // Only a command context exposes reload(). Follow Pi's reload-runtime example.
  pi.registerCommand("pi2tg-reload", {
    description: "Reload Pi resources (used by Telegram /reload)",
    handler: async (_args, commandCtx) => {
      try {
        await commandCtx.waitForIdle();
        await commandCtx.reload();
        return; // The old runtime must not be used after replacement.
      } catch {
        reloadRequested = false;
        reloadDispatched = false;
        say("重载失败，请检查终端。可在终端执行 /reload 重试。");
      }
    },
  });

  // Called outside the settlement hook so ctx.isIdle() observes competing local input.
  const dispatch = () => {
    if (!ctx || !bot || waiting || switchingModel || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (reloadRequested) {
      if (!reloadDispatched && !inbox.reserved) {
        reloadDispatched = true;
        pi.sendUserMessage("/pi2tg-reload", { expandPromptTemplates: true });
      }
      return;
    }
    const task = inbox.takeTask();
    if (task === undefined) return;
    if (typeof task !== "string" && !ctx.model?.input.includes("image")) {
      inbox.reserved = false;
      say("图片任务未提交：当前模型不支持图片。请切换模型后重新发送。");
      dispatchTimer = setTimeout(dispatch, 0);
      return;
    }
    try {
      pi.sendUserMessage(task, { deliverAs: "followUp" });
      say("已提交 Telegram 任务。");
    } catch {
      inbox.reserved = false;
      say("任务提交失败，未自动重试。请检查终端后重新发送。");
    }
  };

  const receiveImage = (update: Update) => {
    const message = update.message!;
    const file = message.photo?.length ? message.photo.reduce((a, b) => a.width * a.height > b.width * b.height ? a : b) : message.document;
    if (!file || !bot || !ctx) return;
    if (reloadRequested || inbox.stopping || switchingModel) { say("正在停止、重载或切换模型，暂不接收图片。"); return; }
    if (!ctx.model?.input.includes("image")) { say("当前模型不支持图片，请在 Pi 中切换到支持视觉的模型后重发。"); return; }
    if ((file.file_size ?? 0) > MAX_IMAGE_BYTES) { say("图片超过 10 MiB，请压缩后重发。"); return; }
    if (downloads.size >= 3) { say("图片下载任务已满（3 张），请稍后重发。"); return; }
    if (message.caption?.trim().startsWith("/")) { say("图片说明请使用普通文字；控制命令请单独发送，图片暂不支持 /steer。"); return; }
    const controller = new AbortController();
    downloads.add(controller);
    say("正在接收图片，下载完成后提交或排队。");
    void bot.downloadImage(file.file_id, controller.signal).then(image => {
      if (controller.signal.aborted || !ctx || reloadRequested) return;
      if (!inbox.enqueueImage([
        { type: "text", text: message.caption?.trim() || "请查看这张图片，描述关键内容并指出值得注意的问题。" }, image,
      ])) { say("图片未入队：待办已满（最多 5 张图片）或正在停止，请稍后重发。"); return; }
      say("图片已接收，将按普通任务处理。");
      dispatch();
    }).catch(() => {
      if (!controller.signal.aborted) say("图片接收失败：请检查网络、文件是否为 PNG/JPEG/WebP/GIF，且不超过 10 MiB。可重新发送。");
    }).finally(() => downloads.delete(controller));
  };

  const handle = (update: Update) => {
    if (!ctx) return;
    const callback = update.callback_query;
    if (callback) {
      if (callback.from.id !== userId || callback.from.is_bot || callback.message?.chat.type !== "private" || callback.message.chat.id !== userId) {
        bot?.answerCallback(callback.id, "无权操作");
        return;
      }
      const action = buttons.take(callback.data ?? "", generation);
      if (!action) { bot?.answerCallback(callback.id, "按钮已使用、过期或执行状态已变化。请发送 /help 获取新按钮。"); return; }
      bot?.answerCallback(callback.id, action.confirm ? "请确认操作" : "已接收");
      if (action.confirm) {
        bot?.send(action.command === "/stop" ? "确认停止当前执行，并取消 Telegram 待办？已产生的修改不会回滚。" : "确认重载？将取消未投递的 Telegram 消息，等待当前执行结束后重载。", false,
          buttons.keyboard([[{ text: "确认", command: action.command, generation }, { text: "取消", command: "/cancel-button" }]]));
        return;
      }
      if (action.command === "/cancel-button") { say("已取消操作。"); return; }
      handle({ update_id: update.update_id, message: { from: { id: userId }, chat: { id: userId, type: "private" }, text: action.command } });
      return;
    }
    if (!authorized(update, userId)) return;
    if (update.message?.photo?.length || update.message?.document) { receiveImage(update); return; }
    const text = update.message?.text?.trim();
    if (!text) { say("支持文本、照片和 PNG/JPEG/WebP/GIF 图片文件。"); return; }
    const [command] = text.split(/\s+/);
    if (command === "/start" || command === "/help") { bot?.send(HELP, false, controls()); return; }
    if (command === "/models") {
      const models = ctx.modelRegistry.getAvailable();
      bot?.send(models.length ? "可用模型（依据 Pi 当前配置与认证）：\n\n" + models.map(m =>
        `${ctx?.model?.provider === m.provider && ctx.model.id === m.id ? "● " : "○ "}${m.provider}/${m.id}${m.input.includes("image") ? " [支持图片]" : " [仅文本]"}`,
      ).join("\n") + "\n\n切换：/model provider/model-id" : "Pi 当前没有可用模型，请在终端检查配置与认证。", false, buttons.keyboard(models.slice(0, 40).map(m => [{
        text: `${ctx?.model?.provider === m.provider && ctx.model.id === m.id ? "✓ " : ""}${m.id}`.slice(0, 60),
        command: `/model ${m.provider}/${m.id}`, generation,
      }])));
      // All models remain available through the text command, even beyond the button limit.
      return;
    }
    if (command === "/model") {
      const target = text.slice(command.length).trim();
      if (!target) {
        say(ctx.model ? `当前模型：${ctx.model.provider}/${ctx.model.id}\n图片输入：${ctx.model.input.includes("image") ? "支持（配置声明）" : "不支持（配置声明）"}` : "当前未选择模型。");
        return;
      }
      if (switchingModel || reloadRequested || inbox.stopping || waiting || !ctx.isIdle() || inbox.reserved || ctx.hasPendingMessages() || downloads.size > 0 || inbox.tasks.length > 0 || inbox.steering.length > 0) {
        say("暂不能切换：当前存在执行、下载、待办或重载操作。请等待结束，或 /stop 后重试。");
        return;
      }
      const models = ctx.modelRegistry.getAvailable();
      const matches = models.filter(m => `${m.provider}/${m.id}` === target || m.id === target);
      if (matches.length !== 1) {
        say(matches.length ? "模型名称不唯一，请使用完整 provider/model-id。" : "未找到可用模型。请用 /models 查看完整名称；新配置请先在 Pi 中加载。");
        return;
      }
      const model = matches[0];
      switchingModel = true;
      void pi.setModel(model).then(ok => {
        say(ok ? `已切换当前会话模型：${model.provider}/${model.id}\n图片输入：${model.input.includes("image") ? "支持（配置声明）" : "不支持（配置声明）"}` : "切换失败：该模型缺少可用认证，请在 Pi 终端检查。");
      }).catch(() => say("模型切换失败，请查看 Pi 终端。"))
        .finally(() => { switchingModel = false; dispatch(); });
      return;
    }
    if (command === "/status") {
      const state = waiting ? "等待终端操作" : inbox.stopping ? "正在停止" : ctx.isIdle() && !inbox.reserved ? "空闲" : "执行中";
      say(`状态：${state}\n模型：${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选择"}\n待重载：${reloadRequested ? "是" : "否"}\n图片下载：${downloads.size}\n待投递插话：${inbox.steering.length}\n\n${progress ? progress.render(inbox.tasks.length) : `Telegram 待办：${inbox.tasks.length}`}`);
      return;
    }
    if (command === "/reload") {
      if (switchingModel) { say("正在切换模型，请稍后重载。"); return; }
      if (reloadRequested) { say("重载已请求，正在等待 Pi 空闲。"); return; }
      reloadRequested = true;
      cancelDownloads();
      const count = inbox.tasks.length + inbox.steering.length;
      inbox.tasks = []; inbox.steering = [];
      refreshPanel(true);
      say(`已请求重载，取消 ${count} 条未投递消息。忙碌时等待当前执行结束；请等待新的连接通知。`);
      dispatch();
      return;
    }
    if (command === "/stop") {
      cancelDownloads();
      const count = inbox.stop();
      refreshPanel(true);
      say(`已取消 ${count} 条未投递的 Telegram 消息，并请求中止当前执行。已产生的修改不会回滚。`);
      if (ctx.isIdle() && !inbox.reserved) inbox.settled();
      else ctx.abort();
      return;
    }
    if (reloadRequested) { say("等待重载中，暂不接收新任务。请等待连接通知后重发。"); return; }
    const steer = command === "/steer";
    if (command.startsWith("/") && !steer) { say("未知命令。使用 /help 查看支持的指令。"); return; }
    const content = steer ? text.slice(6).trim() : text;
    if (!content) { say("用法：/steer 补充要求"); return; }
    const busy = !ctx.isIdle() || inbox.reserved;
    if (!inbox.enqueue(content, steer && busy)) {
      say("暂未接收：正在停止或待办已达 50 条上限。请稍后重发。"); return;
    }
    if (steer && busy) say("已保存插话，将在当前轮工具执行结束后投递；不会中断当前工具。");
    else if (busy || waiting) say(`已排队，当前 Telegram 待办 ${inbox.tasks.length} 条。`);
    dispatch();
  };

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    if (ctx.mode !== "tui") return;
    try {
      const config = readConfig(ctx.cwd, ctx.isProjectTrusted());
      if (!config) return;
      releaseLock = await acquireBotLock(config.token, () => {
        warn("pi2tg 实例锁失效，正在关闭 Telegram 连接。请排查重复实例后 /reload。");
        cancelDownloads();
        clearInterval(progressTimer);
        inbox.stop();
        const oldBot = bot;
        bot = undefined;
        void oldBot?.close();
        ctx?.ui.setStatus("pi2tg", "Telegram 已断开（实例锁失效）");
      });
      userId = config.userId;
      inbox = new Inbox();
      bot = new Telegram(config, warn);
      await bot.start(handle);
      ctx.ui.setStatus("pi2tg", "Telegram 已连接");
      bot.send(`Pi 会话已连接。\n项目：${basename(ctx.cwd)}\n会话：${ctx.sessionManager.getSessionId()}\n离线期间的旧消息已跳过；发送 /help 查看用法。终端和 Telegram 任务都会推送结果。`, false, controls());
    } catch (error) {
      await bot?.close(); bot = undefined;
      await releaseLock?.().catch(() => {}); releaseLock = undefined;
      warn((error as NodeJS.ErrnoException).code === "ELOCKED"
        ? "pi2tg 未启动：该 Bot 已由本机另一 Pi 实例占用。异常退出后最多等待两分钟再 /reload。"
        : "pi2tg 启动失败：请检查当前会话目录 .pi/pi2tg.env、网络和 webhook 配置。不会输出 Token。");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!running) taskSummary = event.messageType === "user" ? event.prompt : "扩展发起的任务";
  });

  pi.on("agent_start", (_event, context) => {
    ctx = context; inbox.reserved = false;
    if (!running) {
      generation++;
      running = true; startedAt = Date.now(); tools = 0; errors = 0;
      progress = new Progress(taskSummary, context.cwd, startedAt);
      panel = { text: "", queued: false };
      dirty = true;
      refreshPanel(true);
      clearInterval(progressTimer);
      if (bot) progressTimer = setInterval(() => refreshPanel(), 1000);
    }
  });

  pi.on("tool_execution_start", (event) => {
    tools++;
    progress?.start(event.toolCallId, event.toolName, event.args);
    dirty = true;
  });
  pi.on("tool_execution_end", (event) => {
    if (event.isError) errors++;
    progress?.end(event.toolCallId, event.toolName, event.isError);
    dirty = true;
  });

  pi.on("turn_end", (event) => {
    if (event.outcome !== "completed") return;
    const messages = inbox.takeSteering();
    if (!messages.length) return;
    say(`已在本轮边界投递 ${messages.length} 条插话。`);
    return {
      entries: [...event.entries, ...messages.map(content => ({
        type: "custom_message" as const, customType: "pi2tg-steer",
        content: `Telegram 用户补充指令：\n${content}`, display: true,
      }))],
      continue: true,
    };
  });

  // Forward only finalized textual replies without tool calls; never thinking or raw outputs.
  pi.on("message_end", (event) => {
    const m = event.message;
    if (m.role !== "assistant") return;
    if (m.stopReason === "error") {
      progress?.record("⚠ 模型请求失败，可能自动重试");
      if (progress) progress.activity = "模型请求失败，等待重试或结束";
      dirty = true;
      refreshPanel(true);
      return;
    }
    if (m.stopReason === "aborted" || m.content.some(c => c.type === "toolCall")) return;
    const text = m.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (text.trim()) bot?.send(`Pi 回复：\n\n${text}`, true);
  });

  pi.on("ui_prompt_start", () => {
    waiting = true;
    if (progress && running) { progress.activity = "请回到终端处理确认，Telegram 不能代替权限确认"; refreshPanel(true); }
    else say("⏸ Pi 等待终端确认或输入，请回到终端处理。");
  });
  pi.on("ui_prompt_end", () => {
    waiting = false;
    if (progress) progress.activity = "等待模型响应或后续操作";
    if (running) refreshPanel(true);
    clearTimeout(dispatchTimer);
    dispatchTimer = setTimeout(dispatch, 0);
  });

  pi.on("agent_settled", (event, context) => {
    ctx = context;
    if (event.aborted) {
      cancelDownloads();
      const n = inbox.stop();
      if (n) say(`执行被中止，已取消 ${n} 条 Telegram 待办或插话。`);
    } else {
      // A late steering message may arrive after the last turn boundary.
      inbox.tasks.unshift(...inbox.takeSteering());
    }
    inbox.settled();
    generation++;
    if (running) {
      progress?.finish(event.aborted);
      refreshPanel(true);
    }
    clearInterval(progressTimer);
    running = false;
    clearTimeout(dispatchTimer);
    dispatchTimer = setTimeout(dispatch, 0);
  });

  pi.on("session_shutdown", async () => {
    cancelDownloads();
    clearInterval(progressTimer);
    clearTimeout(dispatchTimer);
    inbox.stop();
    await bot?.close(); bot = undefined;
    await releaseLock?.().catch(() => {}); releaseLock = undefined;
    ctx?.ui.setStatus("pi2tg", undefined);
    ctx = undefined;
  });
}
