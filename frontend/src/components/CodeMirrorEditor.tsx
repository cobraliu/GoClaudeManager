import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search, openSearchPanel } from "@codemirror/search";
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, syntaxHighlighting, defaultHighlightStyle, StreamLanguage } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";

import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { vue } from "@codemirror/lang-vue";
import { graphql } from "cm6-graphql";

import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { dart, kotlin, scala, csharp } from "@codemirror/legacy-modes/mode/clike";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { r } from "@codemirror/legacy-modes/mode/r";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";

export interface CodeMirrorEditorHandle {
  focus: () => void;
  openSearch: () => void;
}

const rectCompartment = new Compartment();

function rectSelectionFor(columnMode: boolean) {
  return rectangularSelection({
    eventFilter: (e) => columnMode || e.altKey,
  });
}

function langFor(ext: string): Extension | null {
  const e = ext.toLowerCase();
  // JS/TS
  if (e === "js" || e === "mjs" || e === "cjs") return javascript();
  if (e === "ts") return javascript({ typescript: true });
  if (e === "tsx") return javascript({ typescript: true, jsx: true });
  if (e === "jsx") return javascript({ jsx: true });
  // Python
  if (e === "py" || e === "pyw") return python();
  // Data formats
  if (e === "json" || e === "jsonl") return json();
  if (e === "yaml" || e === "yml") return yaml();
  if (e === "toml") return StreamLanguage.define(toml);
  if (e === "ini" || e === "env" || e === "properties" || e === "conf" || e === "cfg") return StreamLanguage.define(properties);
  // Markup
  if (e === "html" || e === "htm" || e === "xml" || e === "svg") return html();
  if (e === "vue") return vue();
  if (e === "md" || e === "markdown") return markdown();
  // CSS family
  if (e === "css" || e === "scss" || e === "sass" || e === "less") return css();
  // SQL
  if (e === "sql") return sql();
  // Native / systems
  if (e === "rs") return rust();
  if (e === "go") return go();
  if (e === "c" || e === "cpp" || e === "cc" || e === "cxx" || e === "h" || e === "hpp" || e === "hxx") return cpp();
  if (e === "java") return java();
  if (e === "kt" || e === "kts") return StreamLanguage.define(kotlin);
  if (e === "scala" || e === "sc") return StreamLanguage.define(scala);
  if (e === "cs") return StreamLanguage.define(csharp);
  if (e === "swift") return StreamLanguage.define(swift);
  if (e === "dart") return StreamLanguage.define(dart);
  // Scripting
  if (e === "sh" || e === "bash" || e === "zsh" || e === "fish" || e === "ksh") return StreamLanguage.define(shell);
  if (e === "rb" || e === "rake" || e === "gemspec") return StreamLanguage.define(ruby);
  if (e === "php" || e === "phtml") return php();
  if (e === "lua") return StreamLanguage.define(lua);
  if (e === "pl" || e === "pm") return StreamLanguage.define(perl);
  if (e === "ps1" || e === "psm1") return StreamLanguage.define(powerShell);
  if (e === "groovy" || e === "gradle") return StreamLanguage.define(groovy);
  // Functional
  if (e === "hs") return StreamLanguage.define(haskell);
  if (e === "clj" || e === "cljs" || e === "edn") return StreamLanguage.define(clojure);
  // Data science
  if (e === "r") return StreamLanguage.define(r);
  // Schema / interface
  if (e === "proto") return StreamLanguage.define(protobuf);
  if (e === "graphql" || e === "gql") return graphql();
  // DevOps / build
  if (e === "dockerfile") return StreamLanguage.define(dockerFile);
  if (e === "nginx") return StreamLanguage.define(nginx);
  if (e === "makefile" || e === "mk") return StreamLanguage.define(shell); // approximation: Make has no CM6 mode
  return null;
}

export const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, {
  content: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  ext?: string;
  readOnly?: boolean;
  columnMode?: boolean;
}>(function CodeMirrorEditor({ content, onChange, onSave, ext = "", readOnly = false, columnMode = false }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    openSearch: () => { if (viewRef.current) openSearchPanel(viewRef.current); },
  }), []);

  // Mount editor once per (ext, readOnly) — re-mount when language changes
  useEffect(() => {
    if (!hostRef.current) return;
    const lang = langFor(ext);
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      drawSelection({ drawRangeCursor: true }),
      rectCompartment.of(rectSelectionFor(columnMode)),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      history(),
      bracketMatching(),
      indentOnInput(),
      search({ top: true }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => { onSaveRef.current?.(); return true; },
        },
      ]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((v) => {
        if (v.docChanged) onChangeRef.current(v.state.doc.toString());
      }),
      EditorView.theme({
        "&": { height: "100%", maxHeight: "100%" },
        ".cm-scroller": { overflow: "auto" },
        ".cm-content": { minHeight: "100%" },
      }),
      oneDark,
      EditorState.readOnly.of(readOnly),
      EditorState.allowMultipleSelections.of(true),
    ];
    if (lang) extensions.push(lang);

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ext, readOnly]);

  // Sync external content changes (e.g., reload from server)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== content) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: content },
      });
    }
  }, [content]);

  // Hot-swap rectangular selection behavior when columnMode toggles
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: rectCompartment.reconfigure(rectSelectionFor(columnMode)),
    });
  }, [columnMode]);

  return (
    <div
      ref={hostRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    />
  );
});
