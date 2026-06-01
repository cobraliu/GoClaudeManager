import { renderMarkdown } from "./markdown";
import { renderMermaidToHtml } from "./mermaid";
import { getAllRawMessages, type RawMessage, type RawContentBlock, type SessionMeta } from "../api/sessionApi";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function fmtTs(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function getBlocks(content: RawContentBlock[] | string | undefined): RawContentBlock[] {
  if (!content) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

function blockText(content: string | RawContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((c) => (typeof c === "string" ? c : (c.text ?? "")))
    .filter(Boolean)
    .join("\n");
}

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const v = (k: string): string => {
    const x = input[k];
    return typeof x === "string" ? x : "";
  };
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return v("file_path") || v("notebook_path");
    case "Bash":
      return v("command");
    case "Grep":
      return v("pattern") + (v("path") ? ` in ${v("path")}` : "");
    case "Glob":
      return v("pattern");
    case "WebFetch":
    case "WebSearch":
      return v("url") || v("query");
    case "Task":
    case "Agent":
      return v("description") || v("subagent_type") || "";
    case "TodoWrite": {
      const todos = input["todos"];
      if (Array.isArray(todos)) return `${todos.length} todo(s)`;
      return "";
    }
    case "AskUserQuestion": {
      const qs = input["questions"];
      if (Array.isArray(qs) && qs.length > 0) {
        const first = qs[0] as { question?: string };
        return first?.question || "";
      }
      return "";
    }
    case "ExitPlanMode":
      return "plan approval";
    default:
      return Object.keys(input).slice(0, 2).map((k) => `${k}=${String(input[k]).slice(0, 40)}`).join(", ");
  }
}

function renderJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

// ── Line-level LCS diff (mirrors ConversationPane.lcsLineDiff) ───────────────

type DiffLine = { type: "removed" | "added" | "unchanged"; text: string };

function lcsLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 250_000) {
    return [
      ...oldLines.map((t) => ({ type: "removed" as const, text: t })),
      ...newLines.map((t) => ({ type: "added" as const, text: t })),
    ];
  }
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      out.push({ type: "unchanged", text: oldLines[i++] });
      j++;
    } else if (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1])) {
      out.push({ type: "removed", text: oldLines[i++] });
    } else {
      out.push({ type: "added", text: newLines[j++] });
    }
  }
  return out;
}

function renderDiffTable(oldStr: string, newStr: string, context = 3): string {
  const raw = lcsLineDiff(oldStr.split("\n"), newStr.split("\n"));
  let oldNo = 1, newNo = 1;
  const numbered = raw.map((l) => {
    if (l.type === "removed") return { ...l, oldNo: oldNo++ } as DiffLine & { oldNo?: number; newNo?: number };
    if (l.type === "added") return { ...l, newNo: newNo++ } as DiffLine & { oldNo?: number; newNo?: number };
    return { ...l, oldNo: oldNo++, newNo: newNo++ } as DiffLine & { oldNo?: number; newNo?: number };
  });
  // Show changed lines + context around them; collapse longer runs of unchanged.
  const show = new Uint8Array(numbered.length);
  for (let k = 0; k < numbered.length; k++) {
    if (numbered[k].type !== "unchanged") {
      const lo = Math.max(0, k - context);
      const hi = Math.min(numbered.length - 1, k + context);
      for (let p = lo; p <= hi; p++) show[p] = 1;
    }
  }
  const rows: string[] = [];
  let k = 0;
  while (k < numbered.length) {
    if (!show[k]) {
      let cnt = 0;
      while (k < numbered.length && !show[k]) { cnt++; k++; }
      rows.push(`<tr class="diff-skip"><td colspan="3">··· ${cnt} unchanged ···</td></tr>`);
      continue;
    }
    const l = numbered[k++];
    const cls = l.type === "added" ? "diff-add" : l.type === "removed" ? "diff-del" : "diff-ctx";
    const sign = l.type === "added" ? "+" : l.type === "removed" ? "−" : " ";
    const ln = l.type === "added"
      ? `<td class="diff-ln"></td><td class="diff-ln">${l.newNo ?? ""}</td>`
      : l.type === "removed"
      ? `<td class="diff-ln">${l.oldNo ?? ""}</td><td class="diff-ln"></td>`
      : `<td class="diff-ln">${l.oldNo ?? ""}</td><td class="diff-ln">${l.newNo ?? ""}</td>`;
    rows.push(`<tr class="${cls}">${ln}<td class="diff-text"><span class="diff-sign">${sign}</span>${escapeHtml(l.text)}</td></tr>`);
  }
  return `<table class="diff-table"><tbody>${rows.join("")}</tbody></table>`;
}

function renderEditDiff(filePath: string, oldStr: string, newStr: string, label?: string): string {
  return `<div class="diff-block">
    <div class="diff-header">
      ${label ? `<span class="diff-label">${escapeHtml(label)}</span>` : ""}
      ${filePath ? `<span class="diff-path">${escapeHtml(filePath)}</span>` : ""}
      <button class="copy-btn" data-copy-source="diff">Copy patch</button>
    </div>
    ${renderDiffTable(oldStr, newStr)}
  </div>`;
}

function renderWriteContent(filePath: string, content: string): string {
  return `<div class="diff-block">
    <div class="diff-header">
      <span class="diff-label">NEW FILE</span>
      ${filePath ? `<span class="diff-path">${escapeHtml(filePath)}</span>` : ""}
      <button class="copy-btn" data-copy-source="next-pre">Copy</button>
    </div>
    <pre class="tool-pre">${escapeHtml(content)}</pre>
  </div>`;
}

// cat -n style numbered output (Read results, `cat -n`): "   42\tcontent".
// Mirrors ConversationPane's NumberedLines so the viewer shows a distinct
// line-number gutter instead of cramming the number against the code.
const CAT_N_RE = /^ *\d+\t/;
function isNumberedOutput(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.length > 0).slice(0, 5);
  return lines.length >= 2 && lines.every((l) => CAT_N_RE.test(l));
}

function renderToolResultPre(text: string): string {
  if (!isNumberedOutput(text)) {
    return `<pre class="tool-pre">${escapeHtml(text)}</pre>`;
  }
  const lines = text.split("\n");
  let gutter = 4;
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab !== -1) gutter = Math.max(gutter, line.slice(0, tab).trim().length);
  }
  const rows = lines.map((line) => {
    const tab = line.indexOf("\t");
    if (tab === -1) {
      return `<div class="num-row"><span class="num-ln"></span><span class="num-code">${escapeHtml(line) || "&nbsp;"}</span></div>`;
    }
    const num = line.slice(0, tab).trim();
    const code = line.slice(tab + 1);
    return `<div class="num-row"><span class="num-ln">${escapeHtml(num)}</span><span class="num-code">${escapeHtml(code) || "&nbsp;"}</span></div>`;
  });
  return `<pre class="tool-pre numbered" style="--num-gutter:${gutter}ch">${rows.join("")}</pre>`;
}

async function renderAssistantText(text: string): Promise<string> {
  return `<div class="md">${await renderMermaidToHtml(renderMarkdown(text))}</div>`;
}

function renderToolInputBody(name: string, input: Record<string, unknown> | undefined): string {
  const inp = input ?? {};
  // Edit: side-by-side diff
  if (name === "Edit" && typeof inp.old_string === "string" && typeof inp.new_string === "string") {
    return renderEditDiff(String(inp.file_path ?? ""), inp.old_string, inp.new_string);
  }
  // MultiEdit: one diff per edit
  if (name === "MultiEdit" && Array.isArray(inp.edits)) {
    const fp = String(inp.file_path ?? "");
    const parts = (inp.edits as Array<{ old_string?: string; new_string?: string }>).map((e, idx) =>
      renderEditDiff(fp, String(e.old_string ?? ""), String(e.new_string ?? ""), `Edit ${idx + 1}`),
    );
    return parts.join("");
  }
  // Write: full content as a "new file" block
  if (name === "Write" && typeof inp.content === "string") {
    return renderWriteContent(String(inp.file_path ?? ""), inp.content);
  }
  // Bash: command + (description if present)
  if (name === "Bash" && typeof inp.command === "string") {
    const desc = typeof inp.description === "string" && inp.description ? `<div class="bash-desc">${escapeHtml(inp.description)}</div>` : "";
    return `${desc}<pre class="tool-pre tool-bash">${escapeHtml(inp.command)}</pre>`;
  }
  // Default: pretty JSON
  return `<pre class="tool-pre">${escapeHtml(renderJson(inp))}</pre>`;
}

function renderToolUseBlock(b: RawContentBlock, resultBlock: RawContentBlock | undefined): string {
  const name = b.name || "tool";
  const summary = summarizeToolInput(name, b.input);
  const isDiffTool = name === "Edit" || name === "MultiEdit";
  const inputLabel = isDiffTool ? "DIFF" : name === "Write" ? "CONTENT" : name === "Bash" ? "COMMAND" : "INPUT";

  const inputBody = renderToolInputBody(name, b.input);
  const inputHasOwnCopy = isDiffTool || name === "Write";
  const headerCopyBtn = inputHasOwnCopy ? "" : `<button class="copy-btn" data-copy-source="next-pre">Copy</button>`;

  // Tool result body
  let resultHtml = "";
  if (resultBlock) {
    const text = blockText(resultBlock.content);
    const isErr = resultBlock.is_error === true;
    resultHtml = `
    <div class="tool-result ${isErr ? "tool-error" : ""}">
      <div class="tool-result-header">
        <span class="tool-result-label">${isErr ? "Error" : "Result"}</span>
        <button class="copy-btn" data-copy-source="next-pre">Copy</button>
      </div>
      ${renderToolResultPre(text)}
    </div>`;
  } else {
    resultHtml = `<div class="tool-result tool-result-pending"><span class="tool-result-label">No result</span></div>`;
  }

  // For diff tools, show the diff itself in the header preview when collapsed
  // by default-opening the details if the diff is small enough? Keep collapsed.
  return `<details class="tool-use">
    <summary>
      <span class="tool-icon">⚙</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      ${summary ? `<span class="tool-summary">${escapeHtml(summary.slice(0, 160))}</span>` : ""}
    </summary>
    <div class="tool-body">
      <div class="tool-input">
        <div class="tool-input-header">
          <span class="tool-input-label">${inputLabel}</span>
          ${headerCopyBtn}
        </div>
        ${inputBody}
      </div>
      ${resultHtml}
    </div>
  </details>`;
}

function renderThinkingBlock(text: string): string {
  return `<details class="thinking">
    <summary>
      <span class="thinking-icon">💭</span>
      <span class="thinking-label">Thinking</span>
      <span class="thinking-meta">${text.length} chars</span>
    </summary>
    <div class="thinking-body"><pre class="thinking-pre">${escapeHtml(text)}</pre></div>
  </details>`;
}

function parseAuqAnswerMap(answerText: string): Map<string, string> {
  // Claude returns answers as: User has answered your questions: "<q>"="<a>", "<q>"="<a>", ...
  // Use a regex to pull each "key"="value" pair. Question/answer can contain
  // anything except an unescaped double-quote.
  const map = new Map<string, string>();
  const re = /"([^"]+)"="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answerText)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

function renderAuqDisplay(b: RawContentBlock, resultBlock: RawContentBlock | undefined): string {
  const input = (b.input ?? {}) as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label?: string; description?: string }> }> };
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answerText = resultBlock ? blockText(resultBlock.content) : "";
  const answerByQ = parseAuqAnswerMap(answerText);

  const parts: string[] = [];
  parts.push(`<div class="auq-card">`);
  parts.push(`<div class="auq-header"><span class="auq-icon">?</span><span class="auq-title">AskUserQuestion</span>${answerText ? `<span class="auq-status answered">Answered</span>` : `<span class="auq-status pending">Pending</span>`}</div>`);
  for (const q of questions) {
    parts.push(`<div class="auq-question">`);
    if (q.header) parts.push(`<div class="auq-qheader">${escapeHtml(q.header)}</div>`);
    if (q.question) parts.push(`<div class="auq-qtext">${escapeHtml(q.question)}</div>`);
    // Exact-match the chosen label against the parsed answer for this question.
    const given = q.question ? answerByQ.get(q.question) : undefined;
    const optionLabels = Array.isArray(q.options) ? q.options.map((o) => o.label || "") : [];
    const matchedExisting = given !== undefined && optionLabels.includes(given);
    if (Array.isArray(q.options) && q.options.length > 0) {
      parts.push(`<ul class="auq-options">`);
      for (const opt of q.options) {
        const label = opt.label || "";
        const chosen = given !== undefined && given === label;
        parts.push(`<li class="auq-option${chosen ? " chosen" : ""}">`);
        parts.push(`<span class="auq-bullet">${chosen ? "●" : "○"}</span>`);
        parts.push(`<span class="auq-label">${escapeHtml(label)}</span>`);
        if (opt.description) parts.push(`<div class="auq-desc">${escapeHtml(opt.description)}</div>`);
        parts.push(`</li>`);
      }
      parts.push(`</ul>`);
    }
    // Freeform / custom answer: not among options, show as a separate row.
    if (given !== undefined && !matchedExisting) {
      parts.push(`<div class="auq-freeform">`);
      parts.push(`<span class="auq-bullet">●</span>`);
      parts.push(`<span class="auq-label">${escapeHtml(given)}</span>`);
      parts.push(`<span class="auq-freeform-tag">custom</span>`);
      parts.push(`</div>`);
    }
    parts.push(`</div>`);
  }
  if (answerText) {
    parts.push(`<div class="auq-answer"><span class="auq-answer-label">Answer:</span> ${escapeHtml(answerText)}</div>`);
  }
  parts.push(`</div>`);
  return parts.join("");
}

function renderExitPlanMode(b: RawContentBlock): string {
  const input = (b.input ?? {}) as { plan?: string };
  const planText = input.plan || "";
  return `<details class="plan-card" open>
    <summary>
      <span class="plan-icon">📋</span>
      <span class="plan-title">ExitPlanMode — Plan</span>
      <button class="copy-btn" data-copy-source="next-md">Copy</button>
    </summary>
    <div class="plan-body md">${renderMarkdown(planText)}</div>
  </details>`;
}

function isCompactSummaryText(text: string): boolean {
  return text.trimStart().startsWith("This session is being continued from a previous conversation");
}

function getTextFromContent(content: RawContentBlock[] | string | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
}

function renderCompactBoundary(entry: RawMessage, summaryText: string | undefined): string {
  const meta = (entry as unknown as Record<string, unknown>).compactMetadata as {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
  } | undefined;
  const trigger = meta?.trigger === "manual" ? "manual" : "auto";
  const pre = meta?.preTokens ? meta.preTokens.toLocaleString() + " tok" : "";
  const post = meta?.postTokens ? "→" + meta.postTokens.toLocaleString() : "";
  const ts = fmtTs(entry.timestamp);
  const metaLine = [trigger, pre + post].filter(Boolean).join(" · ");
  const summaryHtml = summaryText ? renderMarkdown(summaryText) : "";
  return `<div class="compact-divider">
    <div class="compact-divider-line"></div>
    <details class="compact-card">
      <summary>
        <span class="compact-icon">⊞</span>
        <span class="compact-label">Compact</span>
        ${metaLine ? `<span class="compact-meta">${escapeHtml(metaLine)}</span>` : ""}
        ${ts ? `<span class="compact-ts">${escapeHtml(ts)}</span>` : ""}
        ${summaryText ? `<span class="compact-chevron">▾</span>` : ""}
      </summary>
      ${summaryText ? `<div class="compact-body md">${summaryHtml}</div>` : ""}
    </details>
    <div class="compact-divider-line"></div>
  </div>`;
}

async function renderEntry(
  entry: RawMessage,
  toolResults: Map<string, RawContentBlock>,
  compactSummaries: Map<string, string>,
  compactSummaryUuids: Set<string>,
): Promise<string> {
  // compact_boundary system entry → compact divider with summary
  if (entry.type === "system" && (entry as unknown as Record<string, unknown>).subtype === "compact_boundary") {
    const summary = compactSummaries.get(entry.uuid || "");
    return renderCompactBoundary(entry, summary);
  }
  // Suppress the user-message that carries the compact summary text — already
  // rendered inside the compact-boundary card.
  if (entry.uuid && compactSummaryUuids.has(entry.uuid)) return "";

  // Only assistant + user message entries from here on
  if (entry.type !== "assistant" && entry.type !== "user") return "";

  const role = entry.message?.role || entry.type || "system";
  const blocks = getBlocks(entry.message?.content);
  const ts = fmtTs(entry.timestamp);

  // Skip user entries that are pure tool_result containers — those are rendered
  // under their parent tool_use already.
  if (role === "user") {
    const onlyToolResult = blocks.length > 0 && blocks.every((b) => b.type === "tool_result");
    if (onlyToolResult) return "";
  }

  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      const text = b.text || "";
      if (!text.trim()) continue;
      if (role === "user") {
        parts.push(`<div class="text">${escapeHtml(text)}</div>`);
      } else {
        parts.push(await renderAssistantText(text));
      }
    } else if (b.type === "thinking") {
      const t = b.thinking || b.text || "";
      if (t.trim()) parts.push(renderThinkingBlock(t));
    } else if (b.type === "tool_use") {
      const result = b.id ? toolResults.get(b.id) : undefined;
      if (b.name === "AskUserQuestion") {
        parts.push(renderAuqDisplay(b, result));
      } else if (b.name === "ExitPlanMode") {
        parts.push(renderExitPlanMode(b));
      } else {
        parts.push(renderToolUseBlock(b, result));
      }
    } else if (b.type === "tool_result") {
      // Orphan tool result (no matching tool_use seen) — show inline
      const text = blockText(b.content);
      if (text.trim()) {
        parts.push(`<details class="tool-result orphan"><summary>Tool result</summary>${renderToolResultPre(text)}</details>`);
      }
    }
  }

  if (parts.length === 0) return "";
  return `<div class="row ${role === "user" ? "user" : "assistant"}">
    <div class="bubble">${parts.join("\n")}</div>
    ${ts ? `<div class="ts">${escapeHtml(ts)}</div>` : ""}
  </div>`;
}

function buildToolResultMap(messages: RawMessage[]): Map<string, RawContentBlock> {
  const map = new Map<string, RawContentBlock>();
  for (const m of messages) {
    if (m.message?.role !== "user") continue;
    const blocks = getBlocks(m.message.content);
    for (const b of blocks) {
      if (b.type === "tool_result" && b.tool_use_id) {
        map.set(b.tool_use_id, b);
      }
    }
  }
  return map;
}

function buildCompactMaps(messages: RawMessage[]): { compactSummaries: Map<string, string>; compactSummaryUuids: Set<string> } {
  const compactSummaries = new Map<string, string>();
  const compactSummaryUuids = new Set<string>();
  for (const m of messages) {
    if (m.type !== "user" || !m.message) continue;
    const text = getTextFromContent(m.message.content);
    if (isCompactSummaryText(text)) {
      if (m.parentUuid) compactSummaries.set(m.parentUuid, text);
      if (m.uuid) compactSummaryUuids.add(m.uuid);
    }
  }
  return { compactSummaries, compactSummaryUuids };
}

const LIGHT_BASE = `
:root { color-scheme: light dark; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
       max-width: 1080px; margin: 0 auto; padding: 24px 20px 60px; line-height: 1.6;
       background: #fafafa; color: #222; }
header { border-bottom: 1px solid #e5e5e5; margin-bottom: 20px; padding-bottom: 12px; }
h1 { font-size: 18px; margin: 0 0 4px; }
.meta { color: #888; font-size: 12px; }
.toolbar { display: flex; gap: 6px; margin: 10px 0 0; flex-wrap: wrap; }
.toolbar button { font-size: 12px; padding: 4px 10px; border: 1px solid #ccc;
                  background: #fff; color: #222; border-radius: 4px; cursor: pointer; }
.toolbar button:hover { background: #f0f0f0; }
.row { display: flex; flex-direction: column; margin-bottom: 14px; }
.row.user { align-items: flex-end; }
.row.assistant { align-items: flex-start; }
.bubble { max-width: 92%; padding: 10px 14px; font-size: 14px; min-width: 0; }
.row.user .bubble { background: #1a4a7a; color: #cce5ff; border-radius: 16px 16px 4px 16px; max-width: 80%; }
.row.assistant .bubble { background: #ececec; color: #222; border-radius: 16px 16px 16px 4px; }
.text { white-space: pre-wrap; word-break: break-word; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 8px; }
.md h1, .md h2, .md h3, .md h4 { margin: 12px 0 6px; line-height: 1.3; }
.md h1 { font-size: 18px; } .md h2 { font-size: 16px; } .md h3 { font-size: 15px; } .md h4 { font-size: 14px; }
.md ul, .md ol { margin: 4px 0 8px; padding-left: 22px; }
.md li { margin: 2px 0; }
.md blockquote { border-left: 3px solid #bbb; margin: 6px 0; padding: 2px 12px; color: #555; }
.md table { border-collapse: collapse; margin: 6px 0; font-size: 13px; }
.md th, .md td { border: 1px solid #ccc; padding: 4px 8px; }
.md a { color: #1a4a7a; }
.md pre.conv-code-block { background: #1e1e1e; color: #f8f8f2; padding: 10px 12px;
                           border-radius: 8px; overflow-x: auto; font-size: 12.5px; margin: 6px 0;
                           position: relative; }
.md pre.conv-code-block code { font-family: "Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace; }
.md code.conv-code-inline { background: rgba(0,0,0,0.08); padding: 1px 5px; border-radius: 4px;
                             font-size: 12.5px; font-family: "Cascadia Code", Menlo, Monaco, monospace; }
.md .mermaid-rendered { display: flex; justify-content: center; margin: 8px 0;
                        padding: 8px; background: #fff; border: 1px solid #e5e5e5; border-radius: 6px; overflow-x: auto; }
.md .mermaid-rendered svg { max-width: 100%; height: auto; }
.md .mermaid-error { background: #fee; color: #c00; border: 1px solid #fcc; border-radius: 4px;
                     padding: 8px; font-size: 12px; white-space: pre-wrap; overflow-x: auto; }
.ts { font-size: 10px; color: #999; margin-top: 2px; padding: 0 4px; }

/* Tool-use card */
.tool-use { margin: 6px 0; border: 1px solid #c8d4e0; border-radius: 6px; background: #f3f7fb; }
.tool-use > summary { padding: 6px 10px; cursor: pointer; display: flex; align-items: center; gap: 8px;
                      font-size: 12.5px; list-style: none; user-select: none; }
.tool-use > summary::-webkit-details-marker { display: none; }
.tool-use > summary::before { content: "▸"; color: #888; font-size: 10px; transition: transform 0.1s; }
.tool-use[open] > summary::before { transform: rotate(90deg); display: inline-block; }
.tool-icon { color: #4a7ab8; font-weight: bold; }
.tool-name { font-weight: 600; color: #1a4a7a; }
.tool-summary { color: #555; font-family: "Cascadia Code", Menlo, Monaco, monospace; font-size: 12px;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.tool-body { padding: 8px 10px 10px; border-top: 1px solid #d9e2ec; }
.tool-input, .tool-result { margin-top: 4px; }
.tool-input-header, .tool-result-header { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.tool-input-label, .tool-result-label { font-size: 10.5px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
.tool-pre { background: #1e1e1e; color: #f0f0f0; padding: 8px 10px; border-radius: 4px;
            font-family: "Cascadia Code", Menlo, Monaco, monospace; font-size: 12px;
            line-height: 1.45; overflow-x: auto; max-height: 480px; overflow-y: auto;
            white-space: pre-wrap; word-break: break-word; margin: 2px 0 0; }
.tool-error .tool-pre { background: #3a1212; color: #f8d7da; border: 1px solid #6a2020; }
.tool-result-pending { color: #888; font-size: 11px; padding: 2px 0; }
/* Numbered output (Read / cat -n): right-aligned line-number gutter, separated
   from the code column. .tool-pre stays dark in both themes, so no dark override. */
.tool-pre.numbered { padding: 6px 0; white-space: normal; }
.num-row { display: flex; }
.num-ln { flex-shrink: 0; min-width: var(--num-gutter, 4ch); padding: 0 10px 0 8px;
          text-align: right; color: #8a8a8a; user-select: none; white-space: nowrap;
          border-right: 1px solid rgba(255,255,255,0.08); }
.num-code { flex: 1 1 auto; min-width: 0; white-space: pre; padding: 0 8px; }

/* Thinking */
.thinking { margin: 4px 0; border: 1px dashed #d0c5e0; border-radius: 6px; background: #f9f6fc; }
.thinking > summary { padding: 5px 10px; cursor: pointer; display: flex; align-items: center; gap: 8px;
                      font-size: 12px; color: #5d4a85; list-style: none; user-select: none; }
.thinking > summary::-webkit-details-marker { display: none; }
.thinking > summary::before { content: "▸"; color: #888; font-size: 10px; }
.thinking[open] > summary::before { content: "▾"; }
.thinking-label { font-weight: 600; }
.thinking-meta { color: #888; font-size: 11px; }
.thinking-body { padding: 6px 10px 10px; border-top: 1px dashed #e0d5f0; }
.thinking-pre { font-family: "Cascadia Code", Menlo, Monaco, monospace; font-size: 12px;
                line-height: 1.45; white-space: pre-wrap; word-break: break-word; margin: 0;
                color: #4a3a6e; }

/* AUQ */
.auq-card { margin: 6px 0; border: 1px solid #d0d8e0; border-radius: 6px; background: #fff; padding: 8px 10px; }
.auq-header { display: flex; align-items: center; gap: 8px; padding-bottom: 4px; border-bottom: 1px solid #eee; margin-bottom: 6px; }
.auq-icon { color: #4a7ab8; font-weight: bold; }
.auq-title { font-weight: 600; color: #1a4a7a; font-size: 12.5px; flex: 1; }
.auq-status { font-size: 10.5px; padding: 1px 6px; border-radius: 3px; }
.auq-status.pending { background: #fff3cd; color: #856404; }
.auq-status.answered { background: #d4edda; color: #155724; }
.auq-qheader { font-size: 11px; color: #4a7ab8; font-weight: 600; margin-bottom: 2px; }
.auq-qtext { font-size: 13px; color: #222; margin-bottom: 6px; }
.auq-options { list-style: none; padding: 0; margin: 0 0 6px; }
.auq-option { padding: 3px 0 3px 4px; font-size: 12.5px; color: #555; }
.auq-option.chosen { color: #1a4a7a; font-weight: 600; }
.auq-bullet { display: inline-block; width: 16px; color: #888; }
.auq-desc { padding-left: 20px; font-size: 11.5px; color: #777; margin-top: 2px; font-weight: 400; }
.auq-answer { padding-top: 6px; border-top: 1px solid #eee; font-size: 12.5px; color: #1a4a7a; }
.auq-answer-label { font-weight: 600; color: #888; margin-right: 4px; }
.auq-freeform { display: flex; align-items: center; gap: 4px; padding: 3px 0 3px 4px;
                font-size: 12.5px; color: #1a4a7a; font-weight: 600; }
.auq-freeform-tag { font-size: 10px; padding: 1px 6px; border-radius: 3px;
                     background: #fff3cd; color: #856404; font-weight: 500; margin-left: 4px; }

/* Plan card */
.plan-card { margin: 6px 0; border: 1px solid #f0d180; border-radius: 6px; background: #fffbe6; }
.plan-card > summary { padding: 6px 10px; cursor: pointer; display: flex; align-items: center; gap: 8px;
                        font-size: 12.5px; list-style: none; user-select: none; }
.plan-card > summary::-webkit-details-marker { display: none; }
.plan-card > summary::before { content: "▸"; color: #888; font-size: 10px; }
.plan-card[open] > summary::before { content: "▾"; }
.plan-title { font-weight: 600; color: #8a6d20; flex: 1; }
.plan-body { padding: 8px 12px 10px; border-top: 1px solid #f0d180; background: #fff; }

/* Diff block (Edit / MultiEdit / Write) */
.diff-block { margin: 4px 0 6px; border: 1px solid #d9e2ec; border-radius: 4px; overflow: hidden; }
.diff-header { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: #eaf0f6; font-size: 11px; }
.diff-label { font-weight: 600; color: #1a4a7a; letter-spacing: 0.4px; text-transform: uppercase; font-size: 10.5px; }
.diff-path { color: #555; font-family: "Cascadia Code", Menlo, Monaco, monospace; font-size: 11.5px; flex: 1;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.diff-table { border-collapse: collapse; width: 100%; font-family: "Cascadia Code", Menlo, Monaco, monospace;
              font-size: 12px; line-height: 1.5; background: #fafafa; }
.diff-table td { padding: 0 6px; vertical-align: top; white-space: pre-wrap; word-break: break-word; }
.diff-table td.diff-ln { width: 40px; min-width: 40px; max-width: 40px; color: #999; text-align: right;
                          user-select: none; font-size: 10.5px; padding: 0 6px; background: #f0f0f0;
                          border-right: 1px solid #e0e0e0; }
.diff-table td.diff-text { padding: 0 8px; color: #222; }
.diff-table tr.diff-add { background: #e6ffec; }
.diff-table tr.diff-add td.diff-text { color: #054017; }
.diff-table tr.diff-add td.diff-ln { background: #cdf5d8; color: #2a7a3d; }
.diff-table tr.diff-del { background: #ffe9ec; }
.diff-table tr.diff-del td.diff-text { color: #5b0d18; }
.diff-table tr.diff-del td.diff-ln { background: #f8c8cf; color: #a52432; }
.diff-table tr.diff-ctx td.diff-text { color: #555; }
.diff-table tr.diff-skip td { text-align: center; color: #999; font-size: 10.5px; padding: 3px; background: #f0f0f0; }
.diff-sign { display: inline-block; width: 10px; user-select: none; color: inherit; opacity: 0.7; }
.tool-bash { background: #1e1e1e; }
.bash-desc { font-size: 11.5px; color: #555; font-style: italic; padding: 2px 2px 4px; }

/* Compact-boundary divider + card */
.compact-divider { display: flex; align-items: center; gap: 8px; padding: 10px 0; margin: 6px 0; }
.compact-divider-line { flex: 1; height: 1px; background: #d9d9d9; }
.compact-card { background: #fff; border: 1px solid #ccc; border-radius: 16px; flex-shrink: 0;
                 max-width: 70%; overflow: hidden; }
.compact-card > summary { padding: 4px 12px; cursor: pointer; display: inline-flex; align-items: center;
                          gap: 8px; font-size: 11.5px; color: #555; list-style: none; user-select: none;
                          white-space: nowrap; }
.compact-card > summary::-webkit-details-marker { display: none; }
.compact-icon { font-size: 13px; }
.compact-label { font-weight: 600; color: #1a4a7a; }
.compact-meta { color: #888; font-size: 10.5px; }
.compact-ts { color: #aaa; font-size: 10px; }
.compact-chevron { font-size: 9px; color: #888; transition: transform 0.1s; }
.compact-card[open] .compact-chevron { transform: rotate(180deg); display: inline-block; }
.compact-body { padding: 10px 14px; border-top: 1px solid #e5e5e5; font-size: 13px; line-height: 1.7;
                background: #fafafa; max-height: 480px; overflow-y: auto; }

/* Copy buttons */
.copy-btn { font-size: 10.5px; padding: 1px 8px; border: 1px solid #c0c0c0; background: #fff;
            border-radius: 3px; cursor: pointer; color: #444; }
.copy-btn:hover { background: #f0f0f0; }
.copy-btn.copied { background: #d4edda; border-color: #5cb85c; color: #155724; }

/* Narrow viewports (phones / tablets up to the 1080 content cap): the body is
   already full-width since max-width >= screen, so just trim the side padding
   to reclaim edge space. Bubble percentages are intentionally left alone to
   keep the chat left/right offset. */
@media (max-width: 1080px) {
  body { padding-left: 10px; padding-right: 10px; }
}
`;

/* Dark-theme color overrides. Shared by the static export's system-preference
 * media query (STYLE) and the share viewer's manual light/dark toggle (DARK_STYLE). */
const DARK_RULES = `
  body { background: #1a1a1a; color: #eaeaea; }
  header { border-bottom-color: #333; }
  .row.assistant .bubble { background: #2a2a2a; color: #eaeaea; }
  .md code.conv-code-inline { background: rgba(255,255,255,0.1); }
  .md blockquote { border-left-color: #555; color: #aaa; }
  .md th, .md td { border-color: #444; }
  .md a { color: #6ab0f3; }
  .md .mermaid-rendered { background: #f5f5f5; border-color: #444; }
  .tool-use { background: #1e2832; border-color: #2f4458; }
  .tool-body { border-top-color: #2f4458; }
  .tool-name { color: #6ab0f3; }
  .tool-summary { color: #aaa; }
  .thinking { background: #20192a; border-color: #4a3a6e; }
  .thinking > summary { color: #b3a6d0; }
  .thinking-pre { color: #c4b8e0; }
  .auq-card { background: #1e2530; border-color: #2f4458; }
  .auq-header { border-bottom-color: #333; }
  .auq-title, .auq-option.chosen, .auq-answer { color: #6ab0f3; }
  .auq-qtext { color: #eaeaea; }
  .auq-option { color: #c0c0c0; }
  .auq-desc { color: #999; }
  .auq-answer { border-top-color: #333; }
  .plan-card { background: #2a2210; border-color: #6a5520; }
  .plan-body { background: #1f1a0c; border-top-color: #6a5520; }
  .plan-title { color: #d4b85a; }
  .toolbar button { background: #2a2a2a; color: #eaeaea; border-color: #444; }
  .toolbar button:hover { background: #383838; }
  .copy-btn { background: #2a2a2a; color: #eaeaea; border-color: #444; }
  .copy-btn:hover { background: #383838; }

  .diff-block { border-color: #2f4458; }
  .diff-header { background: #1e2832; }
  .diff-label { color: #6ab0f3; }
  .diff-path { color: #aaa; }
  .diff-table { background: #1a1a1a; }
  .diff-table td.diff-ln { background: #222; color: #777; border-right-color: #333; }
  .diff-table td.diff-text { color: #d0d0d0; }
  .diff-table tr.diff-add { background: #102e1c; }
  .diff-table tr.diff-add td.diff-text { color: #a6e9b9; }
  .diff-table tr.diff-add td.diff-ln { background: #18432a; color: #6fcf8a; }
  .diff-table tr.diff-del { background: #321319; }
  .diff-table tr.diff-del td.diff-text { color: #f0a8b1; }
  .diff-table tr.diff-del td.diff-ln { background: #4a1822; color: #d96479; }
  .diff-table tr.diff-ctx td.diff-text { color: #aaa; }
  .diff-table tr.diff-skip td { background: #222; color: #777; }
  .bash-desc { color: #aaa; }

  .compact-divider-line { background: #333; }
  .compact-card { background: #1e2530; border-color: #2f4458; }
  .compact-card > summary { color: #aaa; }
  .compact-label { color: #6ab0f3; }
  .compact-meta { color: #888; }
  .compact-ts { color: #666; }
  .compact-body { background: #1a1a1a; border-top-color: #333; color: #eaeaea; }
`;

/* Static HTML export: light base that auto-flips to dark per system preference. */
export const STYLE = `${LIGHT_BASE}
@media (prefers-color-scheme: dark) {
${DARK_RULES}
}
`;

/* Share viewer — forced light theme (ignores system preference). */
export const LIGHT_STYLE = LIGHT_BASE;

/* Share viewer — forced dark theme (dark rules applied unconditionally). */
export const DARK_STYLE = `${LIGHT_BASE}
${DARK_RULES}
`;

const SCRIPT = `
(function() {
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(function() { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function flashCopied(btn) {
    var orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function() {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 1100);
  }
  function preText(pre) {
    if (!pre) return '';
    // Numbered output: copy the code column only, dropping the line-number gutter.
    if (pre.classList.contains('numbered')) {
      var codes = pre.querySelectorAll('.num-code');
      var out = [];
      codes.forEach(function(c) { out.push(c.innerText); });
      return out.join('\\n');
    }
    return pre.innerText;
  }
  function handleCopy(btn) {
    var src = btn.getAttribute('data-copy-source');
    var text = '';
    if (src === 'next-pre') {
      text = preText(btn.parentElement.parentElement.querySelector('pre'));
    } else if (src === 'next-md') {
      var md = btn.parentElement.parentElement.querySelector('.md, .plan-body');
      if (md) text = md.innerText;
    } else if (src === 'diff') {
      // Build unified-style patch text from the sibling diff-table
      var block = btn.closest('.diff-block');
      if (block) {
        var rows = block.querySelectorAll('.diff-table tr');
        var lines = [];
        rows.forEach(function(tr) {
          if (tr.classList.contains('diff-skip')) {
            lines.push('@@ ' + tr.textContent.trim() + ' @@');
            return;
          }
          var tdText = tr.querySelector('.diff-text');
          if (!tdText) return;
          var sign = tr.classList.contains('diff-add') ? '+' : tr.classList.contains('diff-del') ? '-' : ' ';
          var inner = tdText.textContent || '';
          // Strip the leading diff-sign character we rendered (+, −, or space)
          if (inner.length > 0) inner = inner.slice(1);
          lines.push(sign + inner);
        });
        text = lines.join('\n');
      }
    } else {
      text = preText(btn.closest('details, div').querySelector('pre'));
    }
    if (text) {
      copyText(text);
      flashCopied(btn);
    }
  }
  document.addEventListener('click', function(e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('copy-btn')) {
      e.preventDefault();
      e.stopPropagation();
      handleCopy(t);
    }
  });

  // Add copy buttons to all top-level code blocks
  document.querySelectorAll('pre.conv-code-block').forEach(function(pre) {
    if (pre.querySelector('.copy-btn')) return;
    var btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.style.position = 'absolute';
    btn.style.top = '4px';
    btn.style.right = '4px';
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var code = pre.querySelector('code');
      var text = code ? code.innerText : pre.innerText;
      copyText(text);
      flashCopied(btn);
    });
    pre.appendChild(btn);
  });

  // Toolbar: expand/collapse all
  var btnExpand = document.getElementById('btn-expand-all');
  var btnCollapse = document.getElementById('btn-collapse-all');
  if (btnExpand) {
    btnExpand.addEventListener('click', function() {
      document.querySelectorAll('details').forEach(function(d) { d.open = true; });
    });
  }
  if (btnCollapse) {
    btnCollapse.addEventListener('click', function() {
      document.querySelectorAll('details').forEach(function(d) { d.open = false; });
    });
  }
})();
`;

async function renderEntries(messages: RawMessage[]): Promise<string[]> {
  const toolResults = buildToolResultMap(messages);
  const { compactSummaries, compactSummaryUuids } = buildCompactMaps(messages);
  return (await Promise.all(messages.map((m) => renderEntry(m, toolResults, compactSummaries, compactSummaryUuids))))
    .filter((s) => s.length > 0);
}

/** Render conversation entries to an HTML body string (no <html> wrapper).
 *  Shared by the static export and the live share viewer. */
export async function renderConversationBody(messages: RawMessage[]): Promise<string> {
  return (await renderEntries(messages)).join("\n");
}

async function buildHtml(title: string, messages: RawMessage[]): Promise<string> {
  const rendered = await renderEntries(messages);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeAttr(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Exported ${escapeHtml(new Date().toLocaleString())} · ${messages.length} entries · ${rendered.length} rendered</div>
  <div class="toolbar">
    <button id="btn-expand-all" type="button">Expand all</button>
    <button id="btn-collapse-all" type="button">Collapse all</button>
  </div>
</header>
${rendered.join("\n")}
<script>${SCRIPT}</script>
</body>
</html>`;
}

function sanitizeFilename(s: string): string {
  return s.replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 120) || "session";
}

export async function downloadConversationHtml(s: SessionMeta): Promise<void> {
  const { messages } = await getAllRawMessages(s.id);
  if (messages.length === 0) {
    throw new Error("No conversation history to export.");
  }
  const title = `${s.name || s.id} — Chat`;
  const html = await buildHtml(title, messages);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFilename(s.name || s.id)}_chat.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
