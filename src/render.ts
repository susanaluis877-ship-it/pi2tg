import { lexer, type Token } from "marked";
import { chunks } from "./core.ts";

export interface Entity {
  type: "bold" | "italic" | "strikethrough" | "code" | "pre" | "text_link";
  offset: number;
  length: number;
  url?: string;
  language?: string;
}
export interface RenderedMessage { text: string; entities?: Entity[] }

/** Use UTF-16 Telegram entities, not parse_mode: literal HTML and special characters stay safe. */
export function renderMarkdown(markdown: string): RenderedMessage[] {
  let text = "";
  const entities: Entity[] = [];
  const add = (value: string) => { text += value; };
  const style = (type: Entity["type"], render: () => void, extra: Partial<Entity> = {}) => {
    const offset = text.length;
    render();
    if (text.length > offset) entities.push({ type, offset, length: text.length - offset, ...extra });
  };
  const visit = (tokens: Token[] = []) => {
    for (const token of tokens) {
      switch (token.type) {
        case "checkbox": break; // Already rendered by the parent list item.
        case "space": break; // Block renderers already own paragraph spacing.
        case "heading": style("bold", () => visit(token.tokens)); add("\n\n"); break;
        case "paragraph": visit(token.tokens); add("\n\n"); break;
        case "text":
          if (token.tokens) visit(token.tokens); else add(token.text);
          break;
        case "strong": style("bold", () => visit(token.tokens)); break;
        case "em": style("italic", () => visit(token.tokens)); break;
        case "del": style("strikethrough", () => visit(token.tokens)); break;
        case "codespan": style("code", () => add(token.text)); break;
        case "code":
          style("pre", () => add(token.text), token.lang ? { language: token.lang.split(/\s+/)[0] } : {});
          add("\n\n"); break;
        case "link": {
          // Do not turn arbitrary schemes supplied by model output into clickable links.
          if (/^(https?:\/\/|mailto:|tg:\/\/)/i.test(token.href)) {
            style("text_link", () => visit(token.tokens), { url: token.href });
          } else { visit(token.tokens); add(` (${token.href})`); }
          break;
        }
        case "image": add(`[图片：${token.text || "image"}] (${token.href})`); break;
        case "br": add("\n"); break;
        case "hr": add("────────\n\n"); break;
        case "blockquote": add("▎ "); visit(token.tokens); break;
        case "list":
          token.items.forEach((item: any, index: number) => {
            add(token.ordered ? `${Number(token.start) + index}. ` : "• ");
            if (item.task) add(item.checked ? "☑ " : "☐ ");
            visit(item.tokens);
            add("\n");
          });
          add("\n"); break;
        case "table":
          // Telegram has no table entity; a code block keeps columns readable.
          style("pre", () => {
            add(token.header.map((cell: any) => cell.text).join(" | ") + "\n");
            for (const row of token.rows) add(row.map((cell: any) => cell.text).join(" | ") + "\n");
          });
          add("\n"); break;
        case "escape": case "html": add(token.text); break;
        default: add(token.raw);
      }
    }
  };
  visit(lexer(markdown));
  // Remove only layout whitespace, not whitespace belonging to a code block.
  const codeEnd = Math.max(0, ...entities.filter(e => e.type === "pre" || e.type === "code").map(e => e.offset + e.length));
  text = text.slice(0, Math.max(text.trimEnd().length, codeEnd));
  // Telegram disallows formatting entities overlapping code/pre. Prefer code styling.
  const code = entities.filter(e => e.type === "code" || e.type === "pre");
  const safe = entities.filter(e => code.includes(e) || !code.some(c => e.offset < c.offset + c.length && c.offset < e.offset + e.length));
  const parts: RenderedMessage[] = [];
  let start = 0;
  for (const part of chunks(text)) {
    const end = start + part.length;
    const clipped = safe.flatMap(e => {
      const left = Math.max(start, e.offset);
      const right = Math.min(end, e.offset + e.length);
      return left < right ? [{ ...e, offset: left - start, length: right - left }] : [];
    }).sort((a, b) => a.offset - b.offset || b.length - a.length);
    // Telegram has an entity count limit. Text remains intact if excessive formatting occurs.
    if (part.trim()) parts.push({ text: part, ...(clipped.length <= 100 ? { entities: clipped } : {}) });
    start = end;
  }
  return parts;
}
