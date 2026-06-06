import { createStore, type StoreApi } from "zustand/vanilla";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { DiffKind, StatusCode } from "../lib/ipc";

export interface DiffRequest {
  repoPath: string;
  path: string;
  kind: DiffKind;
  /** Commit oid when kind === "commit". */
  oid?: string;
  /** Pre-rename path for status "R" — the diff's old side is read from it. */
  origPath?: string | null;
  /** Status letter for the tab icon, if known. */
  status?: StatusCode;
}

export type Tab =
  | { id: string; kind: "file"; path: string; title: string }
  | { id: string; kind: "diff"; title: string; diff: DiffRequest };

export interface EditorState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Tab ids with unsaved changes. */
  dirty: Record<string, boolean>;

  openFile: (path: string) => void;
  openDiff: (req: DiffRequest) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  markDirty: (id: string, dirty: boolean) => void;
}

export type EditorStore = StoreApi<EditorState>;

const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// repoPath is part of the id: the same file/kind in two repos is two tabs.
const diffTabId = (req: DiffRequest) =>
  `diff:${req.repoPath}:${req.kind}:${req.oid ?? ""}:${req.path}`;

/** Per-workspace editor-tab store; created by the workspaces store. */
export const createEditorStore = (): EditorStore =>
  createStore<EditorState>((set, get) => ({
    tabs: [],
    activeTabId: null,
    dirty: {},

    openFile: (path) => {
      const id = `file:${path}`;
      const { tabs } = get();
      if (!tabs.some((t) => t.id === id)) {
        set({
          tabs: [...tabs, { id, kind: "file", path, title: basename(path) }],
        });
      }
      set({ activeTabId: id });
    },

    openDiff: (req) => {
      const id = diffTabId(req);
      const { tabs } = get();
      if (!tabs.some((t) => t.id === id)) {
        const suffix =
          req.kind === "staged"
            ? " (staged)"
            : req.kind === "commit"
              ? ` (${(req.oid ?? "").slice(0, 7)})`
              : "";
        set({
          tabs: [
            ...tabs,
            { id, kind: "diff", title: `${basename(req.path)}${suffix}`, diff: req },
          ],
        });
      }
      set({ activeTabId: id });
    },

    closeTab: (id) => {
      const { tabs, activeTabId, dirty } = get();
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const next = tabs.filter((t) => t.id !== id);
      const { [id]: _removed, ...restDirty } = dirty;
      let nextActive = activeTabId;
      if (activeTabId === id) {
        nextActive = next.length ? next[Math.min(idx, next.length - 1)].id : null;
      }
      set({ tabs: next, activeTabId: nextActive, dirty: restDirty });
    },

    setActive: (id) => set({ activeTabId: id }),
    markDirty: (id, d) =>
      set((s) => (s.dirty[id] === d ? s : { dirty: { ...s.dirty, [id]: d } })),
  }));

/**
 * Close a tab, asking for confirmation first when it has unsaved changes.
 * Use this from UI close paths (close button, middle-click, ⌘W) instead of
 * calling closeTab directly.
 */
export async function closeTabSafely(
  editor: EditorStore,
  id: string,
): Promise<void> {
  const { dirty, tabs, closeTab } = editor.getState();
  if (dirty[id]) {
    const tab = tabs.find((t) => t.id === id);
    const ok = await confirm(
      `"${tab?.title ?? "This tab"}" has unsaved changes that will be lost.`,
      { title: "Discard changes?", kind: "warning" },
    );
    if (!ok) return;
  }
  closeTab(id);
}
