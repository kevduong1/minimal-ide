import { memo, useEffect, useRef } from "react";
import { Fragment } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  onPtyData,
  onPtyExit,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "../lib/ipc";
import { useTerminalStore, type TerminalTab } from "../stores/terminal";
import { useRepoStore } from "../stores/repo";
import { useUiStore } from "../stores/ui";
import {
  IcChevronDown,
  IcClose,
  IcPlus,
  IcSplit,
  IcTerminal,
  IcTrash,
} from "./icons";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

// ---------------------------------------------------------------------------
// XtermPane — one live xterm + PTY per pane id; mounts exactly once.
// ---------------------------------------------------------------------------

const XTERM_THEME = {
  background: "#15171c",
  foreground: "#d4d8e0",
  cursor: "#d4d8e0",
  selectionBackground: "rgba(47,129,247,0.35)",
  black: "#3b4048",
  red: "#e5534b",
  green: "#3fb950",
  yellow: "#e3b341",
  blue: "#2f81f7",
  magenta: "#a371f7",
  cyan: "#39c5cf",
  white: "#d4d8e0",
  brightBlack: "#6b7280",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#4a93f8",
  brightMagenta: "#bc8cff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

interface XtermPaneProps {
  tabId: string;
  paneId: string;
  focused: boolean;
}

const XtermPane = memo(function XtermPane({
  tabId,
  paneId,
  focused,
}: XtermPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  // tabId/paneId are stable for the lifetime of a mounted pane (keyed by
  // paneId), so a one-shot effect is correct here.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let spawnPromise: Promise<void> | null = null;
    let unData: UnlistenFn | null = null;
    let unExit: UnlistenFn | null = null;

    const term = new Terminal({
      fontFamily: "SF Mono, ui-monospace, Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: XTERM_THEME,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    // WebGL renderer with silent fallback to the DOM renderer.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable — xterm falls back to its default renderer.
    }

    fit.fit();

    const ptyId = crypto.randomUUID();

    const dataSub = term.onData((data) => {
      void ptyWrite(ptyId, data).catch(() => {});
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      void ptyResize(ptyId, cols, rows).catch(() => {});
    });

    // Attach listeners BEFORE spawning so no early output is lost; guard
    // every await against unmount-before-resolve.
    void (async () => {
      const u1 = await onPtyData(ptyId, (bytes) => term.write(bytes));
      if (disposed) {
        u1();
        return;
      }
      unData = u1;

      const u2 = await onPtyExit(ptyId, () => {
        useTerminalStore.getState().closePane(tabId, paneId);
      });
      if (disposed) {
        u2();
        return;
      }
      unExit = u2;

      const cwd = useRepoStore.getState().repoPath ?? "/";
      try {
        spawnPromise = ptySpawn(ptyId, cwd, term.cols, term.rows);
        await spawnPromise;
      } catch (e) {
        if (!disposed) {
          term.write(`\r\n\x1b[31mFailed to spawn shell: ${String(e)}\x1b[0m\r\n`);
        }
      }
    })();

    // Debounced refit whenever the pane resizes (splits added/removed, panel
    // drag-resized, tab shown after display:none, ...).
    let fitTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (fitTimer !== null) window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        fitTimer = null;
        fit.fit();
      }, 50);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      if (fitTimer !== null) window.clearTimeout(fitTimer);
      unData?.();
      unExit?.();
      dataSub.dispose();
      resizeSub.dispose();
      // Kill only once a dispatched spawn settles; a null spawnPromise means
      // the disposed guards above bailed before the spawn was ever sent.
      const p = spawnPromise;
      if (p) void p.catch(() => {}).then(() => ptyKill(ptyId)).catch(() => {});
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`terminal-pane ${focused ? "focused" : ""}`}
      onMouseDown={() => {
        useTerminalStore.getState().setActivePane(tabId, paneId);
        termRef.current?.focus();
      }}
    >
      <div className="terminal-xterm" ref={hostRef} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Tab strip item
// ---------------------------------------------------------------------------

function TabItem({ tab, active }: { tab: TerminalTab; active: boolean }) {
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const closeTab = useTerminalStore((s) => s.closeTab);

  return (
    <div
      className={`terminal-tab ${active ? "active" : ""}`}
      onMouseDown={() => setActiveTab(tab.id)}
      title={tab.title}
    >
      <IcTerminal />
      <span className="truncate">{tab.title}</span>
      <button
        className="terminal-tab-close"
        title="Close Terminal"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.id);
        }}
      >
        <IcClose />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TerminalPanel
// ---------------------------------------------------------------------------

export default function TerminalPanel() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const newTab = useTerminalStore((s) => s.newTab);
  const splitActivePane = useTerminalStore((s) => s.splitActivePane);
  const setTerminalVisible = useUiStore((s) => s.setTerminalVisible);

  // Auto-create the first terminal exactly once. The ref survives React 19
  // StrictMode's dev double-mount, so we never auto-spawn two tabs — and a
  // user closing the last tab intentionally is not overridden.
  const autoCreated = useRef(false);
  useEffect(() => {
    if (!autoCreated.current && useTerminalStore.getState().tabs.length === 0) {
      autoCreated.current = true;
      useTerminalStore.getState().newTab();
    }
  }, []);

  const killActivePane = () => {
    const { tabs, activeTabId, closePane } = useTerminalStore.getState();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) closePane(tab.id, tab.activePaneId);
  };

  const hasTabs = tabs.length > 0;

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <span className="terminal-header-label">Terminal</span>
        <div className="terminal-tabs">
          {tabs.map((tab) => (
            <TabItem key={tab.id} tab={tab} active={tab.id === activeTabId} />
          ))}
        </div>
        <div className="terminal-actions">
          <button className="icon-btn" title="New Terminal" onClick={newTab}>
            <IcPlus />
          </button>
          <button
            className="icon-btn"
            title="Split Terminal"
            onClick={splitActivePane}
            disabled={!hasTabs}
          >
            <IcSplit />
          </button>
          <button
            className="icon-btn"
            title="Kill Terminal"
            onClick={killActivePane}
            disabled={!hasTabs}
          >
            <IcTrash />
          </button>
          <button
            className="icon-btn"
            title="Hide Panel"
            onClick={() => setTerminalVisible(false)}
          >
            <IcChevronDown />
          </button>
        </div>
      </div>
      <div className="terminal-body">
        {hasTabs ? (
          // Render ALL tabs; hide inactive ones so shells keep running and
          // xterm buffers survive tab switches.
          tabs.map((tab) => (
            <div
              key={tab.id}
              className="terminal-tab-body"
              style={{ display: tab.id === activeTabId ? undefined : "none" }}
            >
              {tab.paneIds.map((paneId, i) => (
                <Fragment key={paneId}>
                  {i > 0 && <div className="terminal-pane-divider" />}
                  <XtermPane
                    tabId={tab.id}
                    paneId={paneId}
                    focused={paneId === tab.activePaneId}
                  />
                </Fragment>
              ))}
            </div>
          ))
        ) : (
          <div className="terminal-empty">
            <div className="terminal-empty-text">No terminals</div>
            <button className="primary-btn" onClick={newTab}>
              New Terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
