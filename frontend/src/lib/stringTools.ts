// String transform registry used by the text-selection right-click menu.
// Each tool takes the selected text and returns the transformed result.
// Async tools (e.g. crypto.subtle hashes, hash-wasm MD5 / xxhash3) return
// a Promise.

import { convert, validateConfig } from "./configConvert";
import { md5 as wasmMd5, xxhash3 as wasmXxh3, xxhash128 as wasmXxh3_128 } from "hash-wasm";
import { timeStringToTimestamp, timestampToDatetime } from "./timeConvert";

export type ToolCategory = "Encode" | "Format" | "Case" | "Lines" | "Hash" | "Time" | "Info";

export interface StringTool {
  id: string;
  label: string;
  category: ToolCategory;
  run: (input: string) => string | Promise<string>;
}

// ── Encode ───────────────────────────────────────────────────────────────────
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(s: string): string {
  const cleaned = s.replace(/\s+/g, "");
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function hexEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
function hexDecode(s: string): string {
  const cleaned = s.replace(/\s+/g, "").replace(/^0x/i, "");
  if (cleaned.length % 2 !== 0) throw new Error("hex string has odd length");
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error("invalid hex char at offset " + i * 2);
    bytes[i] = b;
  }
  return new TextDecoder().decode(bytes);
}

const HTML_ESC: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, c => HTML_ESC[c]);
}
function htmlUnescape(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ── Format ───────────────────────────────────────────────────────────────────
function jsonPretty(s: string): string {
  return JSON.stringify(JSON.parse(s), null, 2);
}
function jsonMinify(s: string): string {
  return JSON.stringify(JSON.parse(s));
}
function jsonValidate(s: string): string {
  const r = validateConfig(s, "json");
  if (r.ok) return "✓ valid JSON";
  return `✗ ${r.error}` + (r.line ? `\n  at line ${r.line}, column ${r.column}` : "");
}

function makeConvert(from: "json" | "yaml" | "toml", to: "json" | "yaml" | "toml") {
  return (s: string) => {
    const r = convert(s, from, to);
    if (!r.ok) throw new Error(r.error);
    return r.content;
  };
}

// ── Case ─────────────────────────────────────────────────────────────────────
function splitWords(s: string): string[] {
  return s
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-./]+/)
    .filter(Boolean);
}
function toCamel(s: string): string {
  const ws = splitWords(s).map(w => w.toLowerCase());
  if (ws.length === 0) return "";
  return ws[0] + ws.slice(1).map(w => w[0].toUpperCase() + w.slice(1)).join("");
}
function toPascal(s: string): string {
  return splitWords(s).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
}
function toSnake(s: string): string {
  return splitWords(s).map(w => w.toLowerCase()).join("_");
}
function toKebab(s: string): string {
  return splitWords(s).map(w => w.toLowerCase()).join("-");
}
function toConstant(s: string): string {
  return splitWords(s).map(w => w.toUpperCase()).join("_");
}
function toTitle(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

// ── Lines ────────────────────────────────────────────────────────────────────
function sortLines(s: string, dir: 1 | -1): string {
  return s.split(/\r?\n/).sort((a, b) => dir * a.localeCompare(b)).join("\n");
}
function uniqueLines(s: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ln of s.split(/\r?\n/)) {
    if (!seen.has(ln)) { seen.add(ln); out.push(ln); }
  }
  return out.join("\n");
}
function reverseLines(s: string): string {
  return s.split(/\r?\n/).reverse().join("\n");
}
function trimEachLine(s: string): string {
  return s.split(/\r?\n/).map(l => l.trimEnd()).join("\n");
}
function removeBlankLines(s: string): string {
  return s.split(/\r?\n/).filter(l => l.trim().length > 0).join("\n");
}
function numberLines(s: string): string {
  const lines = s.split(/\r?\n/);
  const w = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(w, " ")}  ${l}`).join("\n");
}

// ── Hash ─────────────────────────────────────────────────────────────────────
async function sha(input: string, algo: "SHA-1" | "SHA-256" | "SHA-512"): Promise<string> {
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

// ── Info ─────────────────────────────────────────────────────────────────────
function stats(s: string): string {
  const chars = s.length;
  const charsNoSpace = s.replace(/\s/g, "").length;
  const lines = s.split(/\r?\n/).length;
  const words = s.trim().length === 0 ? 0 : s.trim().split(/\s+/).length;
  const bytes = new TextEncoder().encode(s).length;
  return [
    `chars         ${chars}`,
    `chars (nospc) ${charsNoSpace}`,
    `words         ${words}`,
    `lines         ${lines}`,
    `bytes (utf-8) ${bytes}`,
  ].join("\n");
}

// ── Registry ─────────────────────────────────────────────────────────────────
export const STRING_TOOLS: StringTool[] = [
  { id: "b64-enc", label: "base64 encode", category: "Encode", run: b64encode },
  { id: "b64-dec", label: "base64 decode", category: "Encode", run: b64decode },
  { id: "url-enc", label: "URL encode", category: "Encode", run: encodeURIComponent },
  { id: "url-dec", label: "URL decode", category: "Encode", run: decodeURIComponent },
  { id: "hex-enc", label: "hex encode", category: "Encode", run: hexEncode },
  { id: "hex-dec", label: "hex decode", category: "Encode", run: hexDecode },
  { id: "html-esc", label: "HTML escape", category: "Encode", run: htmlEscape },
  { id: "html-uesc", label: "HTML unescape", category: "Encode", run: htmlUnescape },

  { id: "json-pretty", label: "JSON pretty", category: "Format", run: jsonPretty },
  { id: "json-min", label: "JSON minify", category: "Format", run: jsonMinify },
  { id: "json-val", label: "JSON validate", category: "Format", run: jsonValidate },
  { id: "json-yaml", label: "JSON → YAML", category: "Format", run: makeConvert("json", "yaml") },
  { id: "yaml-json", label: "YAML → JSON", category: "Format", run: makeConvert("yaml", "json") },
  { id: "json-toml", label: "JSON → TOML", category: "Format", run: makeConvert("json", "toml") },
  { id: "toml-json", label: "TOML → JSON", category: "Format", run: makeConvert("toml", "json") },

  { id: "case-upper", label: "UPPER", category: "Case", run: s => s.toUpperCase() },
  { id: "case-lower", label: "lower", category: "Case", run: s => s.toLowerCase() },
  { id: "case-title", label: "Title Case", category: "Case", run: toTitle },
  { id: "case-camel", label: "camelCase", category: "Case", run: toCamel },
  { id: "case-pascal", label: "PascalCase", category: "Case", run: toPascal },
  { id: "case-snake", label: "snake_case", category: "Case", run: toSnake },
  { id: "case-kebab", label: "kebab-case", category: "Case", run: toKebab },
  { id: "case-const", label: "CONSTANT_CASE", category: "Case", run: toConstant },

  { id: "lines-sort-az", label: "Sort A→Z", category: "Lines", run: s => sortLines(s, 1) },
  { id: "lines-sort-za", label: "Sort Z→A", category: "Lines", run: s => sortLines(s, -1) },
  { id: "lines-uniq", label: "Unique", category: "Lines", run: uniqueLines },
  { id: "lines-rev", label: "Reverse", category: "Lines", run: reverseLines },
  { id: "lines-trim", label: "Trim trailing", category: "Lines", run: trimEachLine },
  { id: "lines-noblank", label: "Strip blanks", category: "Lines", run: removeBlankLines },
  { id: "lines-num", label: "Number lines", category: "Lines", run: numberLines },

  { id: "md5", label: "MD5", category: "Hash", run: s => wasmMd5(s) },
  { id: "sha1", label: "SHA-1", category: "Hash", run: s => sha(s, "SHA-1") },
  { id: "sha256", label: "SHA-256", category: "Hash", run: s => sha(s, "SHA-256") },
  { id: "sha512", label: "SHA-512", category: "Hash", run: s => sha(s, "SHA-512") },
  { id: "xxh3-64", label: "xxhash3 (64)", category: "Hash", run: s => wasmXxh3(s) },
  { id: "xxh3-128", label: "xxhash3 (128)", category: "Hash", run: s => wasmXxh3_128(s) },

  { id: "time-to-ts", label: "→ Timestamp", category: "Time", run: timeStringToTimestamp },
  { id: "ts-to-time", label: "→ Datetime", category: "Time", run: timestampToDatetime },

  { id: "info-stats", label: "Stats", category: "Info", run: stats },
];

export const CATEGORY_ORDER: ToolCategory[] = ["Encode", "Format", "Case", "Lines", "Hash", "Time", "Info"];
