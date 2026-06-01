import React from "react";
import type { ConfigFormat } from "../lib/configConvert";

const ALL: ("raw" | ConfigFormat)[] = ["raw", "json", "yaml", "toml"];

const LABEL: Record<"raw" | ConfigFormat, string> = {
  raw: "Raw",
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
};

export function ConfigFormatToggle({
  source, target, onChange, error, compact = false,
}: {
  source: ConfigFormat;
  target: "raw" | ConfigFormat;
  onChange: (next: "raw" | ConfigFormat) => void;
  error?: string | null;
  compact?: boolean;
}) {
  const padding = compact ? "2px 8px" : "3px 10px";
  const fontSize = compact ? 10 : 11;

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <div
        style={{
          display: "inline-flex",
          border: "1px solid var(--text-faintest)",
          borderRadius: 4,
          overflow: "hidden",
        }}
        title={source === target ? `Format ${LABEL[source]}` : `Preview as ${LABEL[target]}`}
      >
        {ALL.map((opt, i) => {
          const active = opt === target;
          const isSourceFormat = opt === source;
          const isError = active && opt !== "raw" && !!error;
          return (
            <button
              key={opt}
              onClick={() => onChange(opt)}
              style={{
                background: isError
                  ? "var(--accent-red)"
                  : active
                    ? "var(--accent-blue)"
                    : "var(--bg-hover)",
                color: active ? "#fff" : "var(--text-secondary)",
                fontSize,
                padding,
                border: "none",
                borderRight: i < ALL.length - 1 ? "1px solid var(--text-faintest)" : "none",
                cursor: "pointer",
                fontWeight: active ? 600 : 400,
              }}
              title={
                isError
                  ? error ?? undefined
                  : isSourceFormat && active
                    ? `Re-format ${LABEL[opt]}`
                    : undefined
              }
            >
              {LABEL[opt]}
            </button>
          );
        })}
      </div>
      {error && target !== "raw" && (
        <span style={{ fontSize: 10, color: "var(--accent-red)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
