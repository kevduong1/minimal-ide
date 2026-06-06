/**
 * Framework-free xterm + PTY session, owned by lib/termSessions' registry
 * rather than a React component. Dock terminals are dragged between layout
 * groups, which reparents them in the React tree — an "unmount kills the
 * PTY" component lifecycle would murder the shell on every drop. Instead
 * the session owns its own DOM element: React hosts call attach()
 * (appendChild) on mount and detach() on unmount, and ONLY dispose() — an
 * explicit user/exit/workspace-close path — kills the PTY.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  onPtyData,
  onPtyExit,
  ptyAck,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "./ipc";
import { trackActivity, type ActivityTracker } from "./terminalActivity";
import type { PaneActivity } from "../stores/terminal";
import "@xterm/xterm/css/xterm.css";

/** Terminal colors, mirroring theme.css (sanctioned hardcoded-color site:
 *  xterm themes are JS objects, they can't read CSS variables). */
export const XTERM_THEME = {
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
 * cols/rows of the most recent dock-session resize, used to seed sessions
 * created hidden (session restore with the panel closed or another group
 * tab in front) so their PTY doesn't start at xterm's 80×24 default and
 * reflow the prompt on first reveal. Dock groups vary in size, so the seed
 * is approximate — cosmetic only, the reveal fit corrects it.
 */
let lastDockFitDims: { cols: number; rows: number } | null = null;

/**
 * A shell exiting non-zero this soon after spawn is treated as "failed to
 * start" (bad $SHELL, broken dotfiles, deleted cwd): the terminal stays open
 * showing the exit code instead of flashing and vanishing.
 */
const EARLY_EXIT_MS = 5000;

export interface TermSessionOptions {
  /** Terminal id; doubles as the PTY id. */
  id: string;
  /** Spawn directory (the bound project's root). */
  cwd: string;
  /** Agent sessions get the activity tracker + TERM_PROGRAM masquerade. */
  agent: boolean;
  /** State changes from the activity tracker (agent sessions only). */
  onActivity?: (activity: PaneActivity) => void;
  /** PTY exit. `early` = non-zero exit within EARLY_EXIT_MS of spawn (the
   *  corpse is kept readable; the caller should NOT remove the terminal). */
  onExit?: (code: number | null, early: boolean) => void;
}

export interface TermSession {
  readonly id: string;
  readonly term: Terminal;
  /**
   * (Re)parent the session into a React-owned host element. First call
   * opens xterm and spawns the shell; later calls just move the live DOM
   * (drag-and-drop between groups, structural rewraps).
   */
  attach(host: HTMLElement): void;
  /** Remove from the DOM WITHOUT disposing — buffer, PTY, listeners survive. */
  detach(): void;
  focus(): void;
  /** Clear the tracker's attention state (user clicked into the terminal). */
  acknowledge(): void;
  /** The ONLY path that kills the PTY. Idempotent. */
  dispose(): void;
}

export function createTermSession(opts: TermSessionOptions): TermSession {
  const { id, cwd, agent } = opts;

  // The session's own wrapper: xterm opens into this exactly once, and
  // reattachment moves the wrapper — term.element never moves relative to
  // it, so xterm itself never notices the reparenting. Reuses the host
  // styling from TerminalPanel.css (fill the pane, .xterm padding/viewport
  // fixes), which is always loaded via TerminalPanel's static import.
  const el = document.createElement("div");
  el.className = "terminal-xterm";

  let disposed = false;
  let spawnStarted = false;
  let spawnPromise: Promise<void> | null = null;
  let spawnedAt = 0;
  let opened = false;
  let unData: UnlistenFn | null = null;
  let unExit: UnlistenFn | null = null;
  let webglLost = false;
  let webglDead = false;

  const term = new Terminal({
    // Sessions are constructed detached and can't be measured yet; seed with
    // the last known dock geometry instead of xterm's 80×24 default.
    ...(lastDockFitDims ?? null),
    fontFamily: "SF Mono, ui-monospace, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: XTERM_THEME,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  // WebGL renderer with silent fallback to the DOM renderer. Unlike the
  // static panes, dock sessions get reparented, and moving a live canvas can
  // lose its GL context — onContextLoss marks it for recreation on the next
  // attach/reveal instead of silently degrading forever. A recreation that
  // throws retires WebGL for this session (DOM renderer from then on).
  const tryWebgl = () => {
    if (webglDead || disposed) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        webglLost = true;
        // A loss while still visible (the canvas was DOM-moved in place by a
        // keyed reorder — no detach, so no reveal is coming) would leave the
        // terminal blank; recreate right away. setTimeout avoids re-entering
        // the loss event, and the visibility guard keeps hidden sessions on
        // the attach/reveal recovery path.
        window.setTimeout(() => {
          if (!disposed && webglLost && el.offsetParent !== null) {
            tryWebgl();
            term.refresh(0, term.rows - 1);
          }
        }, 0);
      });
      term.loadAddon(webgl);
      webglLost = false;
    } catch {
      webglDead = true;
    }
  };

  const dataSub = term.onData((data) => {
    void ptyWrite(id, data).catch(() => {});
  });
  const resizeSub = term.onResize(({ cols, rows }) => {
    lastDockFitDims = { cols, rows };
    void ptyResize(id, cols, rows).catch(() => {});
  });

  // Busy/attention tracking. watched() is the DOM visibility oracle: the
  // wrapper has no offsetParent exactly when the panel is hidden, another
  // group tab is in front, or the session is detached mid-drag — no store
  // subscriptions needed, and it can't go stale.
  let tracker: ActivityTracker | null =
    agent && opts.onActivity
      ? trackActivity(
          term,
          () => document.hasFocus() && el.offsetParent !== null,
          opts.onActivity,
        )
      : null;

  // Attach listeners BEFORE spawning so no early output is lost; guard
  // every await against dispose-before-resolve (listen() resolves late).
  const spawnOnce = () => {
    if (spawnStarted || disposed) return;
    spawnStarted = true;
    void (async () => {
      const u1 = await onPtyData(id, (bytes) => {
        // Ack on parse completion: the Rust reader parks once too much
        // output is in flight, so a chatty child can't flood the webview.
        term.write(bytes, () => void ptyAck(id, bytes.length).catch(() => {}));
      });
      if (disposed) {
        u1();
        return;
      }
      unData = u1;

      const u2 = await onPtyExit(id, (code) => {
        // A shell dying non-zero right after spawn (bad $SHELL, deleted
        // project dir) would close the terminal and destroy its own error
        // output — keep the corpse readable instead.
        if (code && Date.now() - spawnedAt < EARLY_EXIT_MS) {
          // No more output is coming: retire the tracker now so a busy
          // indicator can't sit stuck until its 30s failsafe.
          tracker?.dispose();
          tracker = null;
          opts.onActivity?.({ busy: false, attention: false });
          term.write(`\r\n\x1b[31m[process exited with code ${code}]\x1b[0m\r\n`);
          opts.onExit?.(code, true);
          return;
        }
        opts.onExit?.(code, false);
      });
      if (disposed) {
        u2();
        return;
      }
      unExit = u2;

      try {
        const spawnCols = term.cols;
        const spawnRows = term.rows;
        spawnedAt = Date.now();
        spawnPromise = ptySpawn(id, cwd, spawnCols, spawnRows, agent);
        await spawnPromise;
        // A refit while the spawn was in flight lost its ptyResize
        // ("unknown pty", swallowed) — re-sync the grids if they diverged.
        if (!disposed && (term.cols !== spawnCols || term.rows !== spawnRows)) {
          void ptyResize(id, term.cols, term.rows).catch(() => {});
        }
      } catch (e) {
        if (!disposed) {
          term.write(`\r\n\x1b[31mFailed to spawn shell: ${String(e)}\x1b[0m\r\n`);
        }
      }
    })();
  };

  // Fit/visibility discipline: NEVER fit a hidden wrapper
  // (xterm 6 measures glyphs via OffscreenCanvas even unrendered, so FitAddon
  // would size the grid from a bogus ~10×5 computed height); on reveal, refit
  // and repaint IMMEDIATELY (the renderer is paused while hidden and a
  // debounced refit reads as flicker); plain resizes debounce 50ms. The
  // observer follows the wrapper through reparents, and detach/reattach size
  // changes (W → 0 → W) funnel through the same hidden/reveal paths.
  let fitTimer: number | null = null;
  const clearFitTimer = () => {
    if (fitTimer !== null) {
      window.clearTimeout(fitTimer);
      fitTimer = null;
    }
  };
  let hidden = true; // constructed detached
  const ro = new ResizeObserver(() => {
    if (el.offsetParent === null) {
      hidden = true;
      clearFitTimer(); // a pending fit must not land on a hidden wrapper
      return;
    }
    const revealed = hidden;
    hidden = false;
    clearFitTimer();
    if (revealed) {
      if (webglLost) tryWebgl();
      // proposeDimensions() is undefined right after reveal on engines that
      // measure glyphs via the DOM — fall through to the debounce there.
      if (fit.proposeDimensions()) {
        fit.fit(); // no-op when geometry is unchanged — no canvas clear
        term.refresh(0, term.rows - 1);
        return;
      }
    }
    fitTimer = window.setTimeout(() => {
      fitTimer = null;
      if (el.offsetParent !== null) fit.fit();
    }, 50);
  });
  ro.observe(el);

  return {
    id,
    term,

    attach(host) {
      if (disposed) return;
      host.appendChild(el);
      if (!opened) {
        opened = true;
        term.open(el); // exactly once, and only while el is in the DOM
        tryWebgl();
        if (el.offsetParent !== null) {
          fit.fit();
          // Seed here too (onResize fired before lastDockFitDims mattered,
          // and a no-change fit emits no resize event).
          lastDockFitDims = { cols: term.cols, rows: term.rows };
        }
        spawnOnce();
        return;
      }
      // Reattach (drop into another group, structural rewrap): a same-size
      // move doesn't fire the ResizeObserver, but the DOM move may have
      // cleared the canvas — repaint synchronously, guarded as always.
      if (webglLost) tryWebgl();
      if (el.offsetParent !== null && fit.proposeDimensions()) {
        fit.fit();
        term.refresh(0, term.rows - 1);
      }
    },

    detach() {
      el.remove();
    },

    focus() {
      if (!disposed) term.focus();
    },

    acknowledge() {
      tracker?.acknowledge();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      ro.disconnect();
      clearFitTimer();
      unData?.();
      unExit?.();
      dataSub.dispose();
      resizeSub.dispose();
      if (tracker) {
        tracker.dispose();
        tracker = null;
        // Drop any lingering indicator (no-op if already pruned).
        opts.onActivity?.({ busy: false, attention: false });
      }
      // Kill only once a dispatched spawn settles; a null spawnPromise means
      // the disposed guards above bailed before the spawn was ever sent.
      const p = spawnPromise;
      if (p) void p.catch(() => {}).then(() => ptyKill(id)).catch(() => {});
      term.dispose();
      el.remove();
    },
  };
}
