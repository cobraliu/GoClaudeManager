// Shared icon set — semantic names mapped onto the Phosphor family from
// react-icons (already a dependency). Centralizing the mapping keeps one icon
// family, one visual language (Phosphor "regular"/outline weight) and lets us
// swap the underlying set in one place. react-icons components default to 1em,
// so they scale with surrounding text; pass `size` for fixed dimensions and
// they inherit `currentColor` for theming.
//
// These replace emoji used as STRUCTURAL UI icons (settings, files, actions).
// Typographic glyphs that live inside text — directional arrows (→ ← ↑ ↓),
// inline ✓/✕ marks — are intentionally left as text and are NOT mapped here.
export {
  PiSun as IconSun,
  PiMoon as IconMoon,
  PiGearSix as IconSettings,
  PiTrash as IconTrash,
  PiFloppyDisk as IconSave,
  PiMagnifyingGlass as IconSearch,
  PiPushPin as IconPin,
  PiClipboard as IconClipboard,
  PiCopy as IconCopy,
  PiLink as IconLink,
  PiChatCircle as IconChat,
  PiPaperclip as IconAttach,
  PiFile as IconFile,
  PiFolder as IconFolder,
  PiPencilSimple as IconEdit,
  PiUsers as IconUsers,
  PiWrench as IconWrench,
  PiGlobe as IconGlobe,
  PiPuzzlePiece as IconPuzzle,
  PiRobot as IconRobot,
  PiWarning as IconWarning,
  PiEye as IconEye,
  PiClock as IconClock,
  PiKey as IconKey,
  PiPackage as IconPackage,
  PiArrowsClockwise as IconRefresh,
  PiList as IconMenu,
  PiDownloadSimple as IconDownload,
  PiArchive as IconArchive,
} from "react-icons/pi";
