import { useCallback, useEffect, useState } from "react";

export type TabKind = "file" | "git" | "scratch";

export interface FileTab {
  id: string;
  kind: "file";
  path: string;
  viewMode: "full" | "diff" | "split";
  noDiff?: boolean;
}

export interface GitTab {
  id: string;
  kind: "git";
}

export interface ScratchTab {
  id: string;
  kind: "scratch";
  title: string;     // shown on the tab — e.g. "Untitled-1"
  content: string;   // in-memory editor buffer, persisted to localStorage
}

export type TabEntry = FileTab | GitTab | ScratchTab;

interface TabsState {
  tabs: TabEntry[];
  activeId: string | null;
}

const EMPTY: TabsState = { tabs: [], activeId: null };

function storageKey(sid: string) {
  return `cm_session_tabs_v1_${sid}`;
}

function load(sid: string): TabsState {
  try {
    const raw = localStorage.getItem(storageKey(sid));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tabs)) return EMPTY;
    // JSONL is no longer a viewer-column tab — it shares the Chat/TUI zone via
    // inlineView. Drop any persisted JSONL tabs so they don't render as ghosts.
    const tabs: TabEntry[] = parsed.tabs.filter((t: TabEntry) =>
      t && typeof t.id === "string" &&
      (t.kind === "file" || t.kind === "git" || t.kind === "scratch")
    );
    const activeId = typeof parsed.activeId === "string" && tabs.some(t => t.id === parsed.activeId)
      ? parsed.activeId
      : (tabs[0]?.id ?? null);
    return { tabs, activeId };
  } catch {
    return EMPTY;
  }
}

function save(sid: string, s: TabsState) {
  try {
    if (s.tabs.length === 0) {
      localStorage.removeItem(storageKey(sid));
    } else {
      localStorage.setItem(storageKey(sid), JSON.stringify(s));
    }
  } catch {
    // ignore quota / privacy errors — tabs just won't persist
  }
}

function genId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nextScratchTitle(tabs: TabEntry[]): string {
  let max = 0;
  for (const t of tabs) {
    if (t.kind === "scratch") {
      const m = /^Untitled-(\d+)$/.exec(t.title);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
  }
  return `Untitled-${max + 1}`;
}

export function useSessionTabs(sessionId: string | null) {
  const [state, setState] = useState<TabsState>(EMPTY);

  useEffect(() => {
    if (!sessionId) { setState(EMPTY); return; }
    setState(load(sessionId));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    save(sessionId, state);
  }, [sessionId, state]);

  const openFileTab = useCallback((path: string, viewMode: "full" | "diff" | "split", noDiff?: boolean) => {
    setState(prev => {
      const existing = prev.tabs.find(t => t.kind === "file" && t.path === path);
      if (existing) {
        const updated = prev.tabs.map(t =>
          t.id === existing.id && t.kind === "file" ? { ...t, viewMode, noDiff } : t
        );
        return { tabs: updated, activeId: existing.id };
      }
      const id = genId();
      const tab: FileTab = { id, kind: "file", path, viewMode, noDiff };
      return { tabs: [...prev.tabs, tab], activeId: id };
    });
  }, []);

  const openGitTab = useCallback(() => {
    setState(prev => {
      const existing = prev.tabs.find(t => t.kind === "git");
      if (existing) return { ...prev, activeId: existing.id };
      const id = genId();
      const tab: GitTab = { id, kind: "git" };
      return { tabs: [...prev.tabs, tab], activeId: id };
    });
  }, []);

  // Creates a fresh in-memory scratch tab. Title auto-increments per session
  // (Untitled-1, Untitled-2, …). Returns the new tab id so caller can focus.
  const openScratchTab = useCallback((): string => {
    const id = genId();
    setState(prev => {
      const tab: ScratchTab = {
        id,
        kind: "scratch",
        title: nextScratchTitle(prev.tabs),
        content: "",
      };
      return { tabs: [...prev.tabs, tab], activeId: id };
    });
    return id;
  }, []);

  // Updates the in-memory buffer of a scratch tab (called on every keystroke
  // by ScratchEditorPane). Cheap setState — only mutates the matching tab.
  const updateScratchContent = useCallback((id: string, content: string) => {
    setState(prev => {
      const t = prev.tabs.find(x => x.id === id);
      if (!t || t.kind !== "scratch" || t.content === content) return prev;
      return {
        ...prev,
        tabs: prev.tabs.map(x => x.id === id && x.kind === "scratch" ? { ...x, content } : x),
      };
    });
  }, []);

  // After a successful Save-As: convert the scratch tab to a real file tab
  // in-place (keeping the same id and position). If a file tab for the same
  // path already exists, drop the scratch and activate the existing tab.
  const promoteScratchToFile = useCallback((id: string, path: string) => {
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === id && t.kind === "scratch");
      if (idx < 0) return prev;
      const existingFile = prev.tabs.find(t => t.kind === "file" && t.path === path);
      if (existingFile) {
        return {
          tabs: prev.tabs.filter(t => t.id !== id),
          activeId: existingFile.id,
        };
      }
      const next = prev.tabs.slice();
      const newTab: FileTab = { id, kind: "file", path, viewMode: "full", noDiff: true };
      next[idx] = newTab;
      return { tabs: next, activeId: id };
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === id);
      if (idx === -1) return prev;
      const next = prev.tabs.filter(t => t.id !== id);
      let activeId = prev.activeId;
      if (activeId === id) {
        activeId = next.length === 0
          ? null
          : (next[Math.min(idx, next.length - 1)]?.id ?? null);
      }
      return { tabs: next, activeId };
    });
  }, []);

  const closeTabs = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setState(prev => {
      const closing = new Set(ids);
      const next = prev.tabs.filter(t => !closing.has(t.id));
      let activeId = prev.activeId;
      if (activeId && closing.has(activeId)) {
        if (next.length === 0) {
          activeId = null;
        } else {
          // Pick the closest surviving tab to the original active position.
          const origIdx = prev.tabs.findIndex(t => t.id === activeId);
          let pick: string | null = null;
          for (let i = origIdx + 1; i < prev.tabs.length; i++) {
            if (!closing.has(prev.tabs[i].id)) { pick = prev.tabs[i].id; break; }
          }
          if (!pick) {
            for (let i = origIdx - 1; i >= 0; i--) {
              if (!closing.has(prev.tabs[i].id)) { pick = prev.tabs[i].id; break; }
            }
          }
          activeId = pick ?? next[0].id;
        }
      }
      return { tabs: next, activeId };
    });
  }, []);

  const activate = useCallback((id: string) => {
    setState(prev => prev.activeId === id ? prev : { ...prev, activeId: id });
  }, []);

  const activeTab: TabEntry | null = state.tabs.find(t => t.id === state.activeId) ?? null;

  return {
    tabs: state.tabs,
    activeId: state.activeId,
    activeTab,
    openFileTab,
    openGitTab,
    openScratchTab,
    updateScratchContent,
    promoteScratchToFile,
    closeTab,
    closeTabs,
    activate,
  };
}
