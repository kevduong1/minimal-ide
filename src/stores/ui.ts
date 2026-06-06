import { create } from "zustand";

export type SidebarTab = "explorer" | "scm";

interface UiState {
  sidebarTab: SidebarTab;
  sidebarVisible: boolean;
  sidebarWidth: number;
  terminalVisible: boolean;
  terminalHeight: number;

  setSidebarTab: (tab: SidebarTab) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (v: boolean) => void;
  setTerminalHeight: (h: number) => void;
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export const useUiStore = create<UiState>((set) => ({
  sidebarTab: "scm",
  sidebarVisible: true,
  sidebarWidth: 320,
  terminalVisible: true,
  terminalHeight: 280,

  setSidebarTab: (tab) =>
    set((s) =>
      s.sidebarTab === tab && s.sidebarVisible
        ? { sidebarVisible: false }
        : { sidebarTab: tab, sidebarVisible: true },
    ),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, 200, 600) }),
  toggleTerminal: () => set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (v) => set({ terminalVisible: v }),
  setTerminalHeight: (h) => set({ terminalHeight: clamp(h, 100, 800) }),
}));
