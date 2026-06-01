// Time conversion helpers for the str-tools menu.
//
// Spec:
//   • timeStringToTimestamp: accept many human/ISO time formats. If the
//     string has no timezone marker (Z, ±HH:MM, GMT/UTC), interpret as
//     0 timezone (UTC). Returns four lines (s/ms/us/ns).
//   • timestampToDatetime: auto-detect timestamp unit by digit count
//     (≤10 → s, ≤13 → ms, ≤16 → µs, ≤19 → ns). Emits two blocks: UTC
//     and the host's local timezone.
//
// Both throw on unparseable input — the menu surfaces the error message
// in the result dialog.

// ── Detection helpers ───────────────────────────────────────────────────────
const TZ_TAIL = /(?:Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT)\b)\s*$/i;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function nsToIsoUtc(ns: bigint): string {
  const ms = Number(ns / 1_000_000n);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new Error("timestamp out of Date range");
  const subSec = ns % 1_000_000_000n;
  // Strip trailing zeros from the fractional part but keep at least 3 digits
  // (the ms portion) so the output looks like a valid ISO timestamp.
  let frac = String(subSec).padStart(9, "0");
  frac = frac.replace(/0+$/, "");
  if (frac.length < 3) frac = frac.padEnd(3, "0");
  return [
    d.getUTCFullYear(), "-",
    pad(d.getUTCMonth() + 1), "-",
    pad(d.getUTCDate()), "T",
    pad(d.getUTCHours()), ":",
    pad(d.getUTCMinutes()), ":",
    pad(d.getUTCSeconds()), ".",
    frac, "Z",
  ].join("");
}

function localIsoWithOffset(d: Date): string {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(offMin) / 60));
  const offM = pad(Math.abs(offMin) % 60);
  return [
    d.getFullYear(), "-",
    pad(d.getMonth() + 1), "-",
    pad(d.getDate()), "T",
    pad(d.getHours()), ":",
    pad(d.getMinutes()), ":",
    pad(d.getSeconds()), ".",
    pad(d.getMilliseconds(), 3),
    sign, offH, ":", offM,
  ].join("");
}

// ── Time string → nanoseconds (BigInt) ──────────────────────────────────────
export function timeStringToTimestamp(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("empty input");

  const hasTz = TZ_TAIL.test(trimmed);

  // Capture sub-second precision (up to 9 digits) before letting Date.parse
  // touch the string — Date only keeps milliseconds, anything beyond would
  // be truncated.
  const fracMatch = trimmed.match(/\.(\d{1,9})/);
  const fracNs = fracMatch
    ? BigInt(fracMatch[1].padEnd(9, "0").slice(0, 9))
    : 0n;

  // Drop the fractional seconds for Date.parse; we'll re-attach the precise
  // ns value below.
  let toParse = trimmed.replace(/\.\d+/, "");

  if (!hasTz) {
    // Normalize "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS" and force UTC
    // by appending "Z". Pure dates ("YYYY-MM-DD") are already UTC midnight
    // per the ISO spec, so no Z needed.
    toParse = toParse.replace(/^(\d{4}-\d{1,2}-\d{1,2})[ T](\d.*)$/, "$1T$2");
    if (/T\d/.test(toParse)) toParse += "Z";
  }

  let d = new Date(toParse);
  if (Number.isNaN(d.getTime())) {
    // Fall back to letting JS attempt the raw input (RFC 2822, locale forms).
    d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`unrecognized time format: "${input}"`);
    }
  }

  const secs = BigInt(Math.floor(d.getTime() / 1000));
  const ns = secs * 1_000_000_000n + fracNs;

  const seconds = ns / 1_000_000_000n;
  const millis = ns / 1_000_000n;
  const micros = ns / 1_000n;

  return [
    `Parsed (UTC):  ${nsToIsoUtc(ns)}`,
    ``,
    `seconds       ${seconds}`,
    `milliseconds  ${millis}`,
    `microseconds  ${micros}`,
    `nanoseconds   ${ns}`,
  ].join("\n");
}

// ── Numeric timestamp → formatted datetime (UTC + local) ────────────────────
type Unit = "s" | "ms" | "us" | "ns";

function detectUnit(intDigits: number): Unit {
  if (intDigits <= 10) return "s";
  if (intDigits <= 13) return "ms";
  if (intDigits <= 16) return "us";
  if (intDigits <= 19) return "ns";
  throw new Error(`integer too large (${intDigits} digits)`);
}

const NS_PER: Record<Unit, bigint> = {
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  ns: 1n,
};

export function timestampToDatetime(input: string): string {
  const cleaned = input.trim().replace(/[_,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`not a numeric timestamp: "${input}"`);
  }

  const isNeg = cleaned.startsWith("-");
  const abs = isNeg ? cleaned.slice(1) : cleaned;
  const [intPart, fracPart = ""] = abs.split(".");
  const unit = detectUnit(intPart.length);
  const nsPerUnit = NS_PER[unit];

  // ns = (intPart + fracPart / 10^len) * nsPerUnit, all in BigInt.
  const intNs = BigInt(intPart) * nsPerUnit;
  let fracNs = 0n;
  if (fracPart) {
    const tenPow = 10n ** BigInt(fracPart.length);
    fracNs = (BigInt(fracPart) * nsPerUnit) / tenPow;
  }
  const ns = (isNeg ? -1n : 1n) * (intNs + fracNs);

  const ms = Number(ns / 1_000_000n);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    throw new Error("timestamp out of representable Date range");
  }

  // Local timezone info
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(offMin) / 60));
  const offM = pad(Math.abs(offMin) % 60);
  const offLabel = `${sign}${offH}:${offM}`;

  return [
    `Detected unit: ${unit}  (raw: ${cleaned})`,
    ``,
    `─── UTC (offset +00:00) ───`,
    `ISO 8601    ${nsToIsoUtc(ns)}`,
    `Date        ${d.toISOString().slice(0, 10)}`,
    `Time        ${d.toISOString().slice(11, 19)}`,
    `RFC 2822    ${d.toUTCString()}`,
    `Unix s      ${ns / 1_000_000_000n}`,
    ``,
    `─── Local (${localTz}, ${offLabel}) ───`,
    `ISO 8601    ${localIsoWithOffset(d)}`,
    `Date        ${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `Time        ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    `Locale      ${d.toLocaleString()}`,
  ].join("\n");
}
