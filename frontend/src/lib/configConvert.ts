import * as yaml from "js-yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type ConfigFormat = "json" | "yaml" | "toml";

export function detectFormat(filename: string): ConfigFormat | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "json") return "json";
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext === "toml") return "toml";
  return null;
}

export function languageFor(fmt: ConfigFormat): string {
  return fmt === "toml" ? "ini" : fmt;
}

export function extFor(fmt: ConfigFormat): string {
  return fmt === "yaml" ? "yaml" : fmt;
}

function parse(content: string, fmt: ConfigFormat): unknown {
  if (fmt === "json") return JSON.parse(content);
  if (fmt === "yaml") return yaml.load(content);
  return parseToml(content);
}

function stringify(obj: unknown, fmt: ConfigFormat): string {
  if (fmt === "json") return JSON.stringify(obj, null, 2);
  if (fmt === "yaml") return yaml.dump(obj, { indent: 2, lineWidth: 120 });
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("TOML requires a top-level table (object), not an array or primitive");
  }
  return stringifyToml(obj as Record<string, unknown>);
}

export type ConvertResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export type ValidateResult =
  | { ok: true }
  | { ok: false; error: string; line?: number; column?: number };

function lineColFromPos(text: string, pos: number): { line: number; column: number } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { line++; lastNl = i; }
  }
  return { line, column: pos - lastNl };
}

export function validateConfig(content: string, fmt: ConfigFormat): ValidateResult {
  try {
    if (fmt === "json") {
      JSON.parse(content);
    } else if (fmt === "yaml") {
      yaml.load(content);
    } else {
      parseToml(content);
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (fmt === "json") {
      const m = msg.match(/position\s+(\d+)/i);
      if (m) {
        const pos = parseInt(m[1], 10);
        const { line, column } = lineColFromPos(content, pos);
        return { ok: false, error: msg, line, column };
      }
      const lm = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
      if (lm) return { ok: false, error: msg, line: parseInt(lm[1], 10), column: parseInt(lm[2], 10) };
    } else if (fmt === "yaml") {
      const mark = (e as { mark?: { line?: number; column?: number } }).mark;
      if (mark && typeof mark.line === "number") {
        return { ok: false, error: msg, line: mark.line + 1, column: (mark.column ?? 0) + 1 };
      }
    } else {
      const tomlErr = e as { line?: number; column?: number };
      if (typeof tomlErr.line === "number") {
        return { ok: false, error: msg, line: tomlErr.line, column: tomlErr.column };
      }
    }
    return { ok: false, error: msg };
  }
}

export function convert(
  content: string,
  from: ConfigFormat,
  to: ConfigFormat,
  opts?: { jsonRepair?: (s: string) => string }
): ConvertResult {
  try {
    const src = from === "json" && opts?.jsonRepair ? opts.jsonRepair(content) : content;
    const obj = parse(src, from);
    return { ok: true, content: stringify(obj, to) };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}
