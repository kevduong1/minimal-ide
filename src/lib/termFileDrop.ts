/**
 * Native file drag-and-drop onto dock terminals (both flavors): dropping
 * files from Finder or the macOS screenshot thumbnail onto a terminal pane
 * pastes their shell-quoted paths at the cursor — Terminal.app/iTerm
 * behavior, and how agent CLIs ingest images (Claude Code recognizes a
 * pasted image path and attaches the file).
 *
 * Tauri's drag-drop interception (dragDropEnabled, default on) swallows
 * native drags before the DOM sees them — and WKWebView's HTML5 drop events
 * carry no real filesystem paths anyway — so this listens to the webview's
 * drag-drop event stream instead: convert the physical drag position to CSS
 * pixels, hit-test for the visible pane under it (lib/termSession tags each
 * .terminal-xterm wrapper with data-session-id), highlight it while hovered,
 * and paste on drop.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getSession } from "./termSessions";
import { currentZoom } from "./zoom";

/** Characters that survive a POSIX shell unquoted (conservative allowlist). */
const SHELL_SAFE = /^[A-Za-z0-9%+,./:=@_-]+$/;

const shellQuote = (path: string): string =>
  SHELL_SAFE.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

/** The pane currently wearing the .file-drop-target highlight. */
let hovered: HTMLElement | null = null;

const setHovered = (pane: HTMLElement | null) => {
  if (pane === hovered) return;
  hovered?.classList.remove("file-drop-target");
  pane?.classList.add("file-drop-target");
  hovered = pane;
};

/**
 * The terminal pane under a drag position. Hit-tests the .dock-pane, not the
 * wrapper, so drops on pane chrome above the xterm layers (the agent project
 * badge) still land in the terminal.
 *
 * GOTCHA: despite the PhysicalPosition type, on macOS the coordinates are
 * already LOGICAL (CSS) px — wry emits NSDraggingInfo.draggingLocation
 * (points, top-left-flipped) unscaled, and tauri-runtime-wry wraps the raw
 * values in PhysicalPosition without applying the scale factor (wry 0.55.1
 * wkwebview/drag_drop.rs / tauri-runtime-wry 2.11.2). Dividing by
 * devicePixelRatio would halve retina coordinates: drops land in the wrong
 * split pane and the top of every pane goes dead. Re-verify on Tauri
 * upgrades — if upstream starts scaling, this needs the division back.
 *
 * App zoom (lib/zoom.ts → WKWebView.pageZoom) DOES shift the mapping: the
 * CSS viewport that elementFromPoint addresses is points / pageZoom, so the
 * webview-point coordinates need that division.
 */
const paneAt = (pos: { x: number; y: number }): HTMLElement | null => {
  const z = currentZoom();
  const hit = document.elementFromPoint(pos.x / z, pos.y / z);
  return hit?.closest<HTMLElement>(".dock-pane") ?? null;
};

/**
 * Install the webview drag-drop listener (App-level, once). Returns a
 * disposer; like all Tauri listens it resolves after mount, so the disposer
 * guards the resolve-after-cleanup race.
 */
export function listenTermFileDrops(): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const e = event.payload;
      if (disposed || e.type === "leave") {
        setHovered(null);
        return;
      }
      const pane = paneAt(e.position);
      if (e.type !== "drop") {
        setHovered(pane);
        return;
      }
      setHovered(null);
      const id = pane?.querySelector<HTMLElement>(
        ".terminal-xterm[data-session-id]",
      )?.dataset.sessionId;
      const session = id ? getSession(id) : undefined;
      // Early-exit corpses stay attached but their PTY is gone — don't
      // paste into the void.
      if (!session || session.exited || e.paths.length === 0) return;
      // paste() (vs a raw PTY write) wraps the text in bracketed-paste when
      // the foreground app enabled it — Claude Code relies on that to
      // recognize dropped paths. Trailing space iTerm-style, ready to send.
      session.term.paste(e.paths.map(shellQuote).join(" ") + " ");
      // Engaging with the pane, like a click: clear attention, take focus.
      session.acknowledge();
      session.focus();
    })
    .then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
  return () => {
    disposed = true;
    unlisten?.();
    setHovered(null);
  };
}
