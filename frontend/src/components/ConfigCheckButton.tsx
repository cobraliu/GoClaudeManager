import React, { useState } from "react";
import { validateConfig, type ConfigFormat } from "../lib/configConvert";

export function ConfigCheckButton({
  content, format, disabled, compact = false,
}: {
  content: string;
  format: ConfigFormat;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const handleClick = () => {
    const r = validateConfig(content, format);
    if (r.ok) {
      setResult({ ok: true, text: `✓ Valid ${format.toUpperCase()}` });
    } else {
      const loc = r.line ? ` (line ${r.line}${r.column ? `, col ${r.column}` : ""})` : "";
      setResult({ ok: false, text: `${r.error}${loc}` });
    }
    setTimeout(() => setResult(null), 5000);
  };

  const padding = compact ? "2px 8px" : "4px 10px";
  const fontSize = compact ? 10 : 11;

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={handleClick}
        disabled={disabled}
        title={disabled ? "Only available on Raw view" : `Validate ${format.toUpperCase()} syntax`}
        style={{
          background: disabled ? "var(--bg-hover)" : "var(--text-faintest)",
          color: disabled ? "var(--text-muted)" : "#fff",
          fontSize, padding,
          border: "none", borderRadius: 4,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        Check
      </button>
      {result && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 200,
            background: result.ok ? "rgba(46,160,67,0.95)" : "rgba(248,81,73,0.95)",
            color: "#fff", fontSize: 11, padding: "4px 8px", borderRadius: 4,
            maxWidth: 360, whiteSpace: "pre-wrap", wordBreak: "break-word",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          {result.text}
        </div>
      )}
    </div>
  );
}
