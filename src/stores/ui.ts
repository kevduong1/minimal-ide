import { create } from "zustand";
import { useWorkspacesStore } from "./workspaces";

export type SidebarTab = "explorer" | "scm";
/** Bottom-panel groups: per-workspace terminals vs the global agent dock. */
export type PanelGroup = "terminal" | "agent";

interface UiState {
  sidebarTab: SidebarTab;
  sidebarVisible: boolean;
  sidebarWidth: number;
  panelVisible: boolean;
  panelHeight: number;
  panelGroup: PanelGroup;
  /** Panel fills the whole center column (editor hidden). Transient view
      state: maximizing reveals the panel, hiding the panel clears it, and
      opening an editor tab clears it (stores/editor.ts) so the file is
      actually visible. */
  panelMaximized: boolean;

  setSidebarTab: (tab: SidebarTab) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  togglePanel: () => void;
  setPanelVisible: (v: boolean) => void;
  setPanelHeight: (h: number) => void;
  /** Selecting a group also reveals the panel. */
  setPanelGroup: (g: PanelGroup) => void;
  togglePanelMaximized: () => void;
  setPanelMaximized: (v: boolean) => void;
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export const useUiStore = create<UiState>((set) => ({
  sidebarTab: "scm",
  sidebarVisible: true,
  sidebarWidth: 320,
  panelVisible: true,
  panelHeight: 280,
  panelGroup: "terminal",
  panelMaximized: false,

  setSidebarTab: (tab) =>
    set((s) =>
      s.sidebarTab === tab && s.sidebarVisible
        ? { sidebarVisible: false }
        : { sidebarTab: tab, sidebarVisible: true },
    ),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, 200, 600) }),
  togglePanel: () =>
    set((s) => ({ panelVisible: !s.panelVisible, panelMaximized: false })),
  setPanelVisible: (v) =>
    set(v ? { panelVisible: true } : { panelVisible: false, panelMaximized: false }),
  setPanelHeight: (h) => set({ panelHeight: clamp(h, 100, 800) }),
  setPanelGroup: (g) => set({ panelGroup: g, panelVisible: true }),
  togglePanelMaximized: () =>
    set((s) =>
      s.panelMaximized
        ? { panelMaximized: false }
        : { panelMaximized: true, panelVisible: true },
    ),
  setPanelMaximized: (v) =>
    set(v ? { panelMaximized: true, panelVisible: true } : { panelMaximized: false }),
}));

/**
 * The panel group actually displayed: with no workspaces open, "terminal"
 * is meaningless (workspace terminals don't exist) and the agent group —
 * whose terminals outlive their projects — takes over. Pure derivation;
 * the user's panelGroup choice is untouched.
 */
export function useEffectivePanelGroup(): PanelGroup {
  const hasWorkspaces = useWorkspacesStore((s) => s.workspaces.length > 0);
  const group = useUiStore((s) => s.panelGroup);
  return hasWorkspaces ? group : "agent";
}
