import {
  SiPython, SiJavascript, SiTypescript, SiReact, SiNpm, SiYaml, SiMarkdown,
  SiCss, SiSass, SiHtml5, SiGnubash, SiGo, SiRust, SiKotlin,
  SiC, SiCplusplus, SiRuby, SiPhp, SiSwift, SiTerraform, SiDocker,
  SiSqlite, SiGit,
} from "react-icons/si";
import {
  VscJson, VscFile, VscFolder, VscFolderOpened, VscFilePdf, VscFileZip, VscFileMedia,
  VscDatabase, VscLock, VscOutput, VscSettingsGear, VscKey, VscMarkdown,
  VscFileCode, VscNewFolder,
} from "react-icons/vsc";
import type { IconType } from "react-icons";

void SiMarkdown; // kept for parity; preferred VscMarkdown wins for md/markdown

interface IconSpec { Icon: IconType; color: string; }

const FILE_SPECIAL: Record<string, IconSpec> = {
  "Makefile":        { Icon: VscSettingsGear, color: "var(--text-secondary)" },
  "Dockerfile":      { Icon: SiDocker,        color: "#2496ED" },
  ".gitignore":      { Icon: SiGit,           color: "#F05032" },
  ".env":            { Icon: VscKey,          color: "var(--accent-amber)" },
  "package.json":    { Icon: SiNpm,           color: "#CB3837" },
  "go.mod":          { Icon: SiGo,            color: "#00ADD8" },
  "Cargo.toml":      { Icon: SiRust,          color: "#DEA584" },
  "pyproject.toml":  { Icon: SiPython,        color: "#3776AB" },
};

const FILE_EXT: Record<string, IconSpec> = {
  py:    { Icon: SiPython,      color: "#3776AB" },
  js:    { Icon: SiJavascript,  color: "#F7DF1E" },
  ts:    { Icon: SiTypescript,  color: "#3178C6" },
  tsx:   { Icon: SiReact,       color: "#61DAFB" },
  jsx:   { Icon: SiReact,       color: "#61DAFB" },
  json:  { Icon: VscJson,       color: "var(--accent-amber)" },
  yaml:  { Icon: SiYaml,        color: "#CB171E" },
  yml:   { Icon: SiYaml,        color: "#CB171E" },
  toml:  { Icon: VscSettingsGear, color: "var(--text-secondary)" },
  md:    { Icon: VscMarkdown,   color: "var(--text-secondary)" },
  txt:   { Icon: VscFile,       color: "var(--text-secondary)" },
  csv:   { Icon: VscFileCode,   color: "#16A34A" },
  tsv:   { Icon: VscFileCode,   color: "#16A34A" },
  sql:   { Icon: VscDatabase,   color: "#0EA5E9" },
  css:   { Icon: SiCss,         color: "#1572B6" },
  scss:  { Icon: SiSass,        color: "#CC6699" },
  sass:  { Icon: SiSass,        color: "#CC6699" },
  html:  { Icon: SiHtml5,       color: "#E34F26" },
  htm:   { Icon: SiHtml5,       color: "#E34F26" },
  sh:    { Icon: SiGnubash,     color: "#4EAA25" },
  bash:  { Icon: SiGnubash,     color: "#4EAA25" },
  zsh:   { Icon: SiGnubash,     color: "#4EAA25" },
  go:    { Icon: SiGo,          color: "#00ADD8" },
  rs:    { Icon: SiRust,        color: "#DEA584" },
  java:  { Icon: VscFileCode,   color: "#E76F00" },
  kt:    { Icon: SiKotlin,      color: "#7F52FF" },
  c:     { Icon: SiC,           color: "#A8B9CC" },
  cpp:   { Icon: SiCplusplus,   color: "#00599C" },
  h:     { Icon: SiC,           color: "#A8B9CC" },
  rb:    { Icon: SiRuby,        color: "#CC342D" },
  php:   { Icon: SiPhp,         color: "#777BB4" },
  swift: { Icon: SiSwift,       color: "#FA7343" },
  tf:    { Icon: SiTerraform,   color: "#7B42BC" },
  dockerfile: { Icon: SiDocker, color: "#2496ED" },
  env:   { Icon: VscKey,        color: "var(--accent-amber)" },
  log:   { Icon: VscOutput,     color: "var(--text-secondary)" },
  lock:  { Icon: VscLock,       color: "var(--text-secondary)" },
  db:    { Icon: VscDatabase,   color: "#0EA5E9" },
  sqlite:  { Icon: SiSqlite,    color: "#88B7E0" },
  sqlite3: { Icon: SiSqlite,    color: "#88B7E0" },
  pdf:   { Icon: VscFilePdf,    color: "#DC2626" },
  zip:   { Icon: VscFileZip,    color: "var(--text-secondary)" },
  tar:   { Icon: VscFileZip,    color: "var(--text-secondary)" },
  gz:    { Icon: VscFileZip,    color: "var(--text-secondary)" },
  bz2:   { Icon: VscFileZip,    color: "var(--text-secondary)" },
  xz:    { Icon: VscFileZip,    color: "var(--text-secondary)" },
  tgz:   { Icon: VscFileZip,    color: "var(--text-secondary)" },
  tbz2:  { Icon: VscFileZip,    color: "var(--text-secondary)" },
  txz:   { Icon: VscFileZip,    color: "var(--text-secondary)" },
  png:   { Icon: VscFileMedia,  color: "#A78BFA" },
  jpg:   { Icon: VscFileMedia,  color: "#A78BFA" },
  jpeg:  { Icon: VscFileMedia,  color: "#A78BFA" },
  gif:   { Icon: VscFileMedia,  color: "#A78BFA" },
  webp:  { Icon: VscFileMedia,  color: "#A78BFA" },
  bmp:   { Icon: VscFileMedia,  color: "#A78BFA" },
  ico:   { Icon: VscFileMedia,  color: "#A78BFA" },
  avif:  { Icon: VscFileMedia,  color: "#A78BFA" },
  tiff:  { Icon: VscFileMedia,  color: "#A78BFA" },
  tif:   { Icon: VscFileMedia,  color: "#A78BFA" },
  svg:   { Icon: VscFileMedia,  color: "#A78BFA" },
};

const FILE_DEFAULT: IconSpec = { Icon: VscFile, color: "var(--text-secondary)" };
const FOLDER_SPEC: IconSpec   = { Icon: VscFolder, color: "var(--accent-blue)" };

export function FileIcon({
  name,
  isDir = false,
  isOpen = false,
  size = 14,
}: {
  name?: string;
  isDir?: boolean;
  isOpen?: boolean;
  size?: number;
}) {
  let spec: IconSpec;
  if (isDir) {
    spec = isOpen ? { Icon: VscFolderOpened, color: "var(--accent-blue)" } : FOLDER_SPEC;
  } else {
    const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
    spec = (name ? FILE_SPECIAL[name] : undefined) ?? FILE_EXT[ext] ?? FILE_DEFAULT;
  }
  const Icon = spec.Icon;
  return <Icon size={size} color={spec.color} style={{ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }} />;
}

export function NewFolderIcon({ size = 14, color = "var(--accent-blue)" }: { size?: number; color?: string }) {
  return <VscNewFolder size={size} color={color} style={{ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }} />;
}
