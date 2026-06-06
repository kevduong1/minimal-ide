/**
 * VS Code-style find/replace widget for the CodeMirror editors, replacing
 * @codemirror/search's default bottom panel. The extension's theme collapses
 * the top panel strip to a zero-height overlay, so the widget floats over
 * the code in the top-right corner instead of pushing it down.
 *
 * One extension (`editorSearch`) is shared by Editor and DiffViewer; each
 * EditorView mounts its own widget instance via a dedicated React root.
 * CM → React flows through the panel's `update` hook (a per-panel `wire`
 * object); React → CM dispatches `setSearchQuery` / runs search commands.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createRoot } from "react-dom/client";
import type { EditorState, Extension } from "@codemirror/state";
import {
  EditorView,
  runScopeHandlers,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import {
  IcCaseSensitive,
  IcChevronDown,
  IcChevronRight,
  IcClose,
  IcPull as IcArrowDown,
  IcPush as IcArrowUp,
  IcRegex,
  IcReplace,
  IcReplaceAll,
  IcWholeWord,
} from "./icons";
import "./EditorSearch.css";

/** Match counting stops here — full counts on huge files buy nothing. */
const COUNT_CAP = 1000;

interface MatchCount {
  /** 1-based position of the currently selected match, 0 if none. */
  index: number;
  total: number;
  /** total hit COUNT_CAP — the real number may be higher. */
  capped: boolean;
}

/** Regex metachars to escape when counting a literal query as a regex. */
const RE_ESCAPE = /[\\^$.*+?()[\]{}|]/g;

/** One pass over the doc: total matches (capped) + the selected match's
    1-based index. Null when the query is empty or an invalid regexp.

    Literal queries are counted through an escaped-regex twin: RegExpCursor
    scans with native RegExp (~40x faster than the char-by-char string
    cursor on match-less multi-MB docs — measured 215ms → 6ms at 5 MB), and
    this reruns on every keystroke / selection move while the panel is open. */
export function countMatches(
  state: EditorState,
  query: SearchQuery,
): MatchCount | null {
  if (!query.valid) return null;
  const counter = query.regexp
    ? query
    : new SearchQuery({
        search: query.search.replace(RE_ESCAPE, "\\$&"),
        regexp: true,
        caseSensitive: query.caseSensitive,
        wholeWord: query.wholeWord,
      });
  const { from, to } = state.selection.main;
  const cursor = counter.getCursor(state);
  let total = 0;
  let index = 0;
  while (total < COUNT_CAP) {
    const r = cursor.next();
    if (r.done) break;
    total++;
    if (r.value.from === from && r.value.to === to) index = total;
  }
  return { index, total, capped: total === COUNT_CAP };
}

function countLabel(count: MatchCount | null): string {
  if (!count) return "";
  if (count.total === 0) return "No results";
  const total = `${count.total}${count.capped ? "+" : ""}`;
  return count.index > 0 ? `${count.index} of ${total}` : `${total} found`;
}

/** Mutable bridge: CM's panel `update` hook → the mounted React widget. */
interface Wire {
  onUpdate: ((u: ViewUpdate) => void) | null;
}

type QuerySpec = Partial<{
  search: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  replace: string;
}>;

/** Keep focus in the inputs when clicking widget buttons (VS Code-style:
    Enter keeps working after a mouse Next/Toggle). */
const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

function ToggleBtn({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`edfind-toggle ${active ? "active" : ""}`}
      title={title}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function FindWidget({ view, wire }: { view: EditorView; wire: Wire }) {
  const [query, setQuery] = useState(() => getSearchQuery(view.state));
  const [count, setCount] = useState(() =>
    countMatches(view.state, getSearchQuery(view.state)),
  );
  const [showReplace, setShowReplace] = useState(false);
  const [readOnly, setReadOnly] = useState(() => view.state.readOnly);
  const findRef = useRef<HTMLInputElement | null>(null);
  const replaceRef = useRef<HTMLInputElement | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const rafRef = useRef(0);

  // CM → React: sync external query changes (Mod-f reseeding from the
  // selection), and recount on doc/selection/query changes. The recount is
  // rAF-coalesced — replace-all lands doc + selection updates in one burst.
  useEffect(() => {
    wire.onUpdate = (u) => {
      let q: SearchQuery | null = null;
      for (const tr of u.transactions)
        for (const e of tr.effects) if (e.is(setSearchQuery)) q = e.value;
      if (q) setQuery(q);
      if (u.startState.readOnly !== u.state.readOnly)
        setReadOnly(u.state.readOnly);
      if (q || u.docChanged || u.selectionSet) {
        const next = q ?? queryRef.current;
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() =>
          setCount(countMatches(view.state, next)),
        );
      }
    };
    return () => {
      wire.onUpdate = null;
      cancelAnimationFrame(rafRef.current);
    };
  }, [view, wire]);

  // The panel DOM is attached synchronously during the CM update that
  // creates it; this effect runs after the React commit, so focus sticks.
  useEffect(() => {
    findRef.current?.focus();
    findRef.current?.select();
  }, []);

  const commit = useCallback(
    (spec: QuerySpec) => {
      const cur = queryRef.current;
      const q = new SearchQuery({
        search: cur.search,
        caseSensitive: cur.caseSensitive,
        wholeWord: cur.wholeWord,
        regexp: cur.regexp,
        replace: cur.replace,
        // VS Code semantics: find text is verbatim — \n etc. need regex mode
        literal: true,
        ...spec,
      });
      setQuery(q); // optimistic — keeps the controlled input snappy
      view.dispatch({ effects: setSearchQuery.of(q) });
    },
    [view],
  );

  // Defer to the search-panel-scoped keymap first (Escape close, Mod-f
  // reselect, F3/Mod-g next…), then our Enter behavior per input.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (runScopeHandlers(view, e.nativeEvent, "search-panel")) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Enter") return;
    if (e.target === findRef.current) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.target === replaceRef.current) {
      e.preventDefault();
      replaceNext(view);
    }
  };

  const invalid = query.regexp && query.search !== "" && !query.valid;
  const noResults =
    !invalid && query.search !== "" && count !== null && count.total === 0;

  return (
    <div className="edfind" onKeyDown={onKeyDown}>
      {!readOnly && (
        <button
          className="edfind-expand"
          title={showReplace ? "Hide replace" : "Show replace"}
          onMouseDown={keepFocus}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? <IcChevronDown /> : <IcChevronRight />}
        </button>
      )}
      <div className="edfind-body">
        <div className="edfind-row">
          <div className={`edfind-input-wrap ${invalid || noResults ? "danger" : ""}`}>
            <input
              // main-field: openSearchPanel focuses + reseeds this input
              ref={(el) => {
                findRef.current = el;
                el?.setAttribute("main-field", "true");
              }}
              className="edfind-input"
              placeholder="Find"
              value={query.search}
              onChange={(e) => commit({ search: e.target.value })}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
            <div className="edfind-toggles">
              <ToggleBtn
                active={query.caseSensitive}
                title="Match case"
                onClick={() => commit({ caseSensitive: !query.caseSensitive })}
              >
                <IcCaseSensitive />
              </ToggleBtn>
              <ToggleBtn
                active={query.wholeWord}
                title="Match whole word"
                onClick={() => commit({ wholeWord: !query.wholeWord })}
              >
                <IcWholeWord />
              </ToggleBtn>
              <ToggleBtn
                active={query.regexp}
                title="Use regular expression"
                onClick={() => commit({ regexp: !query.regexp })}
              >
                <IcRegex />
              </ToggleBtn>
            </div>
          </div>
          <span className={`edfind-count ${invalid || noResults ? "danger" : ""}`}>
            {invalid ? "Bad pattern" : countLabel(count)}
          </span>
          <button
            className="edfind-btn"
            title="Previous match (⇧Enter)"
            disabled={!query.search}
            onMouseDown={keepFocus}
            onClick={() => findPrevious(view)}
          >
            <IcArrowUp />
          </button>
          <button
            className="edfind-btn"
            title="Next match (Enter)"
            disabled={!query.search}
            onMouseDown={keepFocus}
            onClick={() => findNext(view)}
          >
            <IcArrowDown />
          </button>
          <button
            className="edfind-btn"
            title="Close (Esc)"
            onClick={() => closeSearchPanel(view)}
          >
            <IcClose />
          </button>
        </div>
        {showReplace && !readOnly && (
          <div className="edfind-row">
            <div className="edfind-input-wrap">
              <input
                ref={replaceRef}
                className="edfind-input"
                placeholder="Replace"
                value={query.replace}
                onChange={(e) => commit({ replace: e.target.value })}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
            </div>
            <button
              className="edfind-btn"
              title="Replace (Enter)"
              disabled={!query.search}
              onMouseDown={keepFocus}
              onClick={() => replaceNext(view)}
            >
              <IcReplace />
            </button>
            <button
              className="edfind-btn"
              title="Replace all"
              disabled={!query.search}
              onMouseDown={keepFocus}
              onClick={() => replaceAll(view)}
            >
              <IcReplaceAll />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "edfind-panel";
  const wire: Wire = { onUpdate: null };
  const root = createRoot(dom);
  root.render(<FindWidget view={view} wire={wire} />);
  return {
    dom,
    top: true,
    update: (u) => wire.onUpdate?.(u),
    // Deferred: destroy() runs inside a CM update which may itself be
    // inside a React event handler — never unmount a root synchronously.
    destroy: () => setTimeout(() => root.unmount(), 0),
  };
}

/** Collapse the top panel strip to a zero-height overlay (the widget
    positions itself absolutely inside it — EditorSearch.css). */
const overlayTheme = EditorView.theme({
  ".cm-panels.cm-panels-top": {
    position: "absolute",
    top: "0",
    left: "0",
    right: "0",
    height: "0",
    overflow: "visible",
    border: "none",
    backgroundColor: "transparent",
    pointerEvents: "none",
  },
});

/** Drop-in search extension: Mod-f (bound by basicSetup's searchKeymap)
    opens the floating find/replace widget. Shared by Editor + DiffViewer. */
export const editorSearch: Extension = [
  search({
    createPanel: createFindPanel,
    // Extra top margin so matches never land hidden under the widget.
    scrollToMatch: (range) =>
      EditorView.scrollIntoView(range, { y: "nearest", yMargin: 48 }),
  }),
  overlayTheme,
];
