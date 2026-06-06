/**
 * Per-workspace search store (the ⌘⇧F sidebar view). Lives on the Workspace
 * object like repo/editor/terminal, because the sidebar unmounts its content
 * on tab switches — query and results must survive both that and workspace
 * switching. Nothing to dispose: no listeners or IPC handles, just state.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { searchWorkspace, type SearchFileResult } from "../lib/ipc";

/** Type-ahead debounce; option toggles re-run immediately. */
const DEBOUNCE_MS = 250;

export type SearchToggle = "caseSensitive" | "wholeWord" | "useRegex";

export interface SearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;

  results: SearchFileResult[];
  totalMatches: number;
  /** A backend result cap was hit — there may be more matches. */
  truncated: boolean;
  searching: boolean;
  /** Backend failure (an invalid regex while typing) shown inline. */
  error: string | null;
  /** Collapsed file groups, keyed by relative path. */
  collapsed: Record<string, boolean>;

  setQuery: (q: string) => void;
  toggle: (k: SearchToggle) => void;
  toggleCollapsed: (file: string) => void;
}

export type SearchStore = StoreApi<SearchState>;

/** Created by the workspaces store, one per open repo. */
export const createSearchStore = (repoPath: string): SearchStore =>
  createStore<SearchState>((set, get) => {
    // Stale-result guard: only the latest issued request may commit its
    // results, so a slow search over a big repo can never clobber a newer
    // query's output. (No backend cancellation needed — responses are
    // capped, dropping one is cheap.)
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      const mySeq = ++seq;
      const { query, caseSensitive, wholeWord, useRegex } = get();
      if (!query) {
        set({
          results: [],
          totalMatches: 0,
          truncated: false,
          searching: false,
          error: null,
        });
        return;
      }
      set({ searching: true });
      try {
        const r = await searchWorkspace(
          repoPath,
          query,
          caseSensitive,
          wholeWord,
          useRegex,
        );
        if (mySeq !== seq) return; // superseded by a newer search
        set({
          results: r.files,
          totalMatches: r.totalMatches,
          truncated: r.truncated,
          searching: false,
          error: null,
          collapsed: {},
        });
      } catch (e) {
        if (mySeq !== seq) return;
        set({ searching: false, error: String(e) });
      }
    };

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), ms);
    };

    return {
      query: "",
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
      results: [],
      totalMatches: 0,
      truncated: false,
      searching: false,
      error: null,
      collapsed: {},

      setQuery: (q) => {
        set({ query: q });
        schedule(DEBOUNCE_MS);
      },
      toggle: (k) => {
        set({ [k]: !get()[k] } as Partial<SearchState>);
        schedule(0);
      },
      toggleCollapsed: (file) =>
        set((s) => ({
          collapsed: { ...s.collapsed, [file]: !s.collapsed[file] },
        })),
    };
  });
