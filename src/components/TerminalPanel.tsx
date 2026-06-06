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
import { aggregateActivity, type TerminalTab } from "../stores/terminal";
import {
  useTerminal,
  useWorkspace,
  useWorkspacesStore,
} from "../stores/workspaces";
import { useUiStore } from "../stores/ui";
import { trackActivity, type ActivityTracker } from "../lib/terminalActivity";
import {
  ActivityGlyph,
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

/**
 * cols/rows of the most recent pane resize, used to seed terminals that
 * mount hidden (session restore opens background workspaces as display:none)
 * so their PTY doesn't start at xterm's 80×24 default and reflow the prompt
 * on first reveal. All panes share the same global panel geometry.
 */
let lastFitDims: { cols: number; rows: number } | null = null;

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
  // The workspace object (and its terminal store) is stable for the lifetime
  // of the workspace, so capturing it in the one-shot effect is safe.
  const ws = useWorkspace();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const trackerRef = useRef<ActivityTracker | null>(null);

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
      // A pane mounting into a hidden tree can't be measured yet; seed it
      // with the last known pane geometry instead of xterm's 80×24 default.
      ...(host.offsetParent === null && lastFitDims ? lastFitDims : null),
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

    // NEVER fit a hidden host: xterm 6 measures glyphs via OffscreenCanvas
    // even when unrendered, so FitAddon doesn't bail — it sizes the terminal
    // from a bogus computed height (~10×5). The seeded dims cover this case.
    if (host.offsetParent !== null) {
      fit.fit();
      // Seed here too (onResize isn't subscribed yet, and a no-change fit
      // emits no resize event) so hidden-mounting panes can pick this up.
      lastFitDims = { cols: term.cols, rows: term.rows };
    }

    const ptyId = crypto.randomUUID();

    const dataSub = term.onData((data) => {
      void ptyWrite(ptyId, data).catch(() => {});
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      lastFitDims = { cols, rows };
      void ptyResize(ptyId, cols, rows).catch(() => {});
    });

    // Busy/attention state for the tab strip and the titlebar workspace
    // tabs. The tracker only writes to the store on actual state changes.
    const tracker = trackActivity(
      term,
      () =>
        document.hasFocus() &&
        useUiStore.getState().terminalVisible &&
        useWorkspacesStore.getState().activePath === ws.path &&
        ws.terminal.getState().activeTabId === tabId,
      (activity) => ws.terminal.getState().setPaneActivity(paneId, activity),
    );
    trackerRef.current = tracker;

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
        ws.terminal.getState().closePane(tabId, paneId);
      });
      if (disposed) {
        u2();
        return;
      }
      unExit = u2;

      const cwd = ws.path;
      try {
        const spawnCols = term.cols;
        const spawnRows = term.rows;
        spawnPromise = ptySpawn(ptyId, cwd, spawnCols, spawnRows);
        await spawnPromise;
        // A refit while the spawn was in flight lost its ptyResize
        // ("unknown pty", swallowed) — re-sync the grids if they diverged.
        if (!disposed && (term.cols !== spawnCols || term.rows !== spawnRows)) {
          void ptyResize(ptyId, term.cols, term.rows).catch(() => {});
        }
      } catch (e) {
        if (!disposed) {
          term.write(`\r\n\x1b[31mFailed to spawn shell: ${String(e)}\x1b[0m\r\n`);
        }
      }
    })();

    // Refit when the pane resizes (splits added/removed, panel drag-resized)
    // behind a short debounce — but handle hidden→visible transitions
    // specially: on reveal, refit and repaint IMMEDIATELY. xterm's renderer
    // is paused while hidden and the WebGL canvas can come back blank, so
    // waiting out the debounce (and then for output / a cursor blink to
    // trigger a render) reads as flicker when switching workspaces. The
    // observer fires post-layout, so the eager path repaints on the same
    // frame as the reveal. While hidden, never fit (see the mount-time fit).
    let fitTimer: number | null = null;
    const clearFitTimer = () => {
      if (fitTimer !== null) {
        window.clearTimeout(fitTimer);
        fitTimer = null;
      }
    };
    let hidden = host.offsetParent === null;
    const ro = new ResizeObserver(() => {
      if (host.offsetParent === null) {
        hidden = true;
        clearFitTimer(); // a pending fit must not land on a hidden host
        return;
      }
      const revealed = hidden;
      hidden = false;
      clearFitTimer();
      // proposeDimensions() is undefined right after reveal on engines that
      // measure glyphs via the DOM — fall through to the debounce there.
      if (revealed && fit.proposeDimensions()) {
        fit.fit(); // no-op when geometry is unchanged — no canvas clear
        term.refresh(0, term.rows - 1);
        return;
      }
      fitTimer = window.setTimeout(() => {
        fitTimer = null;
        if (host.offsetParent !== null) fit.fit();
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
      tracker.dispose();
      trackerRef.current = null;
      // Drop any lingering indicator (no-op if the store already pruned it).
      ws.terminal
        .getState()
        .setPaneActivity(paneId, { busy: false, attention: false });
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
        ws.terminal.getState().setActivePane(tabId, paneId);
        trackerRef.current?.acknowledge();
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
  const setActiveTab = useTerminal((s) => s.setActiveTab);
  const closeTab = useTerminal((s) => s.closeTab);
  const activity = useTerminal((s) =>
    aggregateActivity(s.paneActivity, tab.paneIds),
  );

  return (
    <div
      className={`terminal-tab ${active ? "active" : ""}`}
      onMouseDown={() => setActiveTab(tab.id)}
      title={tab.title}
    >
      <ActivityGlyph activity={activity} idle={<IcTerminal />} />
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
  const ws = useWorkspace();
  const tabs = useTerminal((s) => s.tabs);
  const activeTabId = useTerminal((s) => s.activeTabId);
  const newTab = useTerminal((s) => s.newTab);
  const splitActivePane = useTerminal((s) => s.splitActivePane);
  const setTerminalVisible = useUiStore((s) => s.setTerminalVisible);

  // Auto-create the first terminal exactly once. The ref survives React 19
  // StrictMode's dev double-mount, so we never auto-spawn two tabs — and a
  // user closing the last tab intentionally is not overridden.
  const autoCreated = useRef(false);
  useEffect(() => {
    if (!autoCreated.current && ws.terminal.getState().tabs.length === 0) {
      autoCreated.current = true;
      ws.terminal.getState().newTab();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const killActivePane = () => {
    const { tabs, activeTabId, closePane } = ws.terminal.getState();
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
