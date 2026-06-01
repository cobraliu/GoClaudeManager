import React, { useState, useEffect, useMemo } from "react";
import { validateConfig, type ConfigFormat } from "../lib/configConvert";

export function ConfigValidationBanner({
  content, format, compact = false,
}: {
  content: string;
  format: ConfigFormat;
  compact?: boolean;
}) {
  const result = useMemo(() => validateConfig(content, format), [content, format]);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(false); }, [content, format]);

  if (result.ok || dismissed) return null;

  const padding = compact ? "4px 8px" : "6px 12px";
  const fontSize = compact ? 11 : 12;
  const loc = result.line ? ` · line ${result.line}${result.column ? `, col ${result.column}` : ""}` : "";

  return (
    <div
      style={{
        display: "flex", alignItems: "flex-start", gap: 8,
        background: "rgba(248,81,73,0.15)",
        borderLeft: "3px solid var(--accent-red)",
        color: "var(--text-primary)",
        padding,
        fontSize,
        fontFamily: "monospace",
        lineHeight: 1.5,
      }}
    >
      <span style={{ color: "var(--accent-red)", fontWeight: 600, flexShrink: 0 }}>
        ✗ {format.toUpperCase()} syntax error{loc}:
      </span>
      <span style={{ flex: 1, wordBreak: "break-word" }}>{result.error}</span>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background: "transparent", border: "none",
          color: "var(--text-muted)", cursor: "pointer",
          padding: 0, fontSize: 14, lineHeight: 1, flexShrink: 0,
        }}
        title="Dismiss"
      >×</button>
    </div>
  );
}
