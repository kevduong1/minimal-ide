import { createStore, type StoreApi } from "zustand/vanilla";

/**
 * Pure UI-state model for the integrated terminal panel: tabs, and splits
 * (panes) within each tab. xterm/PTY lifecycle lives in the components,
 * keyed by pane id — this store never touches xterm or IPC.
 */
export interface TerminalTab {
  id: string;
  /** Display title, e.g. "Terminal 1". */
  title: string;
  /** Pane ids, left -> right. */
  paneIds: string[];
  activePaneId: string;
}

/** Live activity of one pane, reported by its tracker (lib/terminalActivity). */
export interface PaneActivity {
  busy: boolean;
  attention: boolean;
}

export type ActivityLevel = "idle" | "busy" | "attention";

/** attention > busy > idle over panes (all panes when paneIds is omitted). */
export const aggregateActivity = (
  paneActivity: Record<string, PaneActivity>,
  paneIds?: string[],
): ActivityLevel => {
  const all = paneIds
    ? paneIds.map((id) => paneActivity[id])
    : Object.values(paneActivity);
  let busy = false;
  for (const a of all) {
    if (a?.attention) return "attention";
    if (a?.busy) busy = true;
  }
  return busy ? "busy" : "idle";
};

/** Drop activity entries for removed panes (no-op when none are present). */
const pruneActivity = (
  paneActivity: Record<string, PaneActivity>,
  paneIds: string[],
): Record<string, PaneActivity> => {
  if (!paneIds.some((id) => id in paneActivity)) return paneActivity;
  const next = { ...paneActivity };
  for (const id of paneIds) delete next[id];
  return next;
};

export interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  /** Sparse per-pane activity — only panes that are busy / need attention. */
  paneActivity: Record<string, PaneActivity>;

  newTab: () => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  /** Inserts a new pane right after the active pane of the active tab. */
  splitActivePane: () => void;
  /**
   * Removes a pane. Removing the last pane of a tab closes the tab;
   * closing the last tab leaves an empty tab list.
   */
  closePane: (tabId: string, paneId: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  /** Reported by the pane's activity tracker; idle panes are dropped. */
  setPaneActivity: (paneId: string, activity: PaneActivity) => void;
}

export type TerminalStore = StoreApi<TerminalState>;

/** Lowest unused "Terminal N" number (resets once all tabs are closed). */
const nextTitleNumber = (tabs: TerminalTab[]): number =>
  tabs.reduce((max, t) => {
    const m = /^Terminal (\d+)$/.exec(t.title);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0) + 1;

/** Per-workspace terminal store; created by the workspaces store. */
export const createTerminalStore = (): TerminalStore =>
  createStore<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  paneActivity: {},

  newTab: () =>
    set((s) => {
      const paneId = crypto.randomUUID();
      const tab: TerminalTab = {
        id: crypto.randomUUID(),
        title: `Terminal ${nextTitleNumber(s.tabs)}`,
        paneIds: [paneId],
        activePaneId: paneId,
      };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    }),

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        activeTabId = tabs.length
          ? tabs[Math.min(idx, tabs.length - 1)].id
          : null;
      }
      return {
        tabs,
        activeTabId,
        paneActivity: pruneActivity(s.paneActivity, s.tabs[idx].paneIds),
      };
    }),

  setActiveTab: (id) =>
    set((s) => (s.tabs.some((t) => t.id === id) ? { activeTabId: id } : s)),

  splitActivePane: () =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      if (!tab) return s;
      const paneId = crypto.randomUUID();
      const paneIds = [...tab.paneIds];
      paneIds.splice(paneIds.indexOf(tab.activePaneId) + 1, 0, paneId);
      return {
        tabs: s.tabs.map((t) =>
          t.id === tab.id ? { ...t, paneIds, activePaneId: paneId } : t,
        ),
      };
    }),

  closePane: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || !tab.paneIds.includes(paneId)) return;
    if (tab.paneIds.length <= 1) {
      get().closeTab(tabId);
      return;
    }
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const idx = t.paneIds.indexOf(paneId);
        const paneIds = t.paneIds.filter((p) => p !== paneId);
        const activePaneId =
          t.activePaneId === paneId
            ? paneIds[Math.min(Math.max(idx - 1, 0), paneIds.length - 1)]
            : t.activePaneId;
        return { ...t, paneIds, activePaneId };
      }),
      paneActivity: pruneActivity(s.paneActivity, [paneId]),
    }));
  },

  setActivePane: (tabId, paneId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || !tab.paneIds.includes(paneId)) return s;
      return {
        activeTabId: tabId,
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, activePaneId: paneId } : t,
        ),
      };
    }),

  setPaneActivity: (paneId, activity) =>
    set((s) => {
      const keep = activity.busy || activity.attention;
      if (!keep && !(paneId in s.paneActivity)) return s;
      const paneActivity = { ...s.paneActivity };
      if (keep) paneActivity[paneId] = activity;
      else delete paneActivity[paneId];
      return { paneActivity };
    }),
  }));
