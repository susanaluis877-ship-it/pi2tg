import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/render.ts";

test("headings, inline formatting, lists and links become Telegram entities", () => {
  const [part] = renderMarkdown("# 标题\n\n**粗体** *斜体* ~~删除~~ `file_name.ts`\n\n- 项目\n\n[网站](https://example.com)");
  assert.match(part.text, /标题/);
  assert.match(part.text, /• 项目/);
  assert.ok(!part.text.includes("**"));
  assert.ok(!part.text.includes("`"));
  for (const type of ["bold", "italic", "strikethrough", "code", "text_link"]) {
    assert.ok(part.entities?.some(e => e.type === type), type);
  }
});

test("long code blocks preserve Unicode and code entities across message boundaries", () => {
  const code = "😀 <tag> & a_b **literal**\n".repeat(500);
  const parts = renderMarkdown("```ts\n" + code + "```\n");
  assert.ok(parts.length > 1);
  assert.equal(parts.map(p => p.text).join(""), code.trimEnd());
  for (const part of parts) {
    assert.ok(part.text.length <= 3800);
    assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));
    for (const e of part.entities ?? []) {
      assert.equal(e.type, "pre");
      assert.equal(e.language, "ts");
      assert.ok(e.offset >= 0 && e.offset + e.length <= part.text.length);
    }
  }
});

test("HTML is literal, dangerous links are not entities, code cannot overlap formatting", () => {
  const [part] = renderMarkdown('<b>literal</b>\n\n[bad](javascript:alert) **bold `code`**');
  assert.match(part.text, /<b>literal<\/b>/);
  assert.ok(!part.entities?.some(e => e.type === "text_link"));
  assert.ok(part.entities?.some(e => e.type === "code"));
  assert.ok(!part.entities?.some(e => e.type === "bold"));
});

test("paragraph spacing is not doubled, code whitespace stays intact", () => {
  const [part] = renderMarkdown('Pi 回复：\n\n第一段。\n\n第二段。\n\n```text\na\n\n\nb\n```\n\n最后一段。');
  assert.equal(part.text, 'Pi 回复：\n\n第一段。\n\n第二段。\n\na\n\n\nb\n\n最后一段。');
});

test("tables and task lists have readable fallbacks", () => {
  const parts = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo');
  assert.match(parts[0].text, /A \| B/);
  assert.match(parts[0].text, /☑ done/);
  assert.match(parts[0].text, /☐ todo/);
});
