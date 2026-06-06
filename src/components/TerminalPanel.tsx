/**
 * The workspace flavor of the generic Dock: plain shells spawned at the
 * workspace root — no activity tracking, no TERM_PROGRAM masquerade, no
 * project badge (every terminal here belongs to the surrounding workspace).
 * Same drag-and-drop grouping/splitting and double-click tab rename as the
 * agent dock; sessions live in the lib/termSessions registry so drops never
 * kill the shell. The workspaces store disposes a workspace's sessions when
 * the workspace closes.
 */
import { memo, useEffect, useRef } from "react";
import { type WorkspaceTerminal, type TerminalStore } from "../stores/terminal";
import { useWorkspace } from "../stores/workspaces";
import { disposeSession, getOrCreateSession, getSession } from "../lib/termSessions";
import { Dock, type DockPaneProps } from "./Dock";
import { IcTerminal } from "./icons";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

/** Close glue: kill the PTY first, then remove the tab from the layout. */
export function closeWorkspaceTerminal(store: TerminalStore, id: string): void {
  disposeSession(id);
  store.getState().closeTerminal(id);
}

const TerminalPane = memo(function TerminalPane({
  terminal,
  groupId,
  visible,
  focused,
}: DockPaneProps<WorkspaceTerminal>) {
  // The workspace object (and its terminal store) is stable for the
  // lifetime of the workspace, so capturing it in the one-shot effect is safe.
  const ws = useWorkspace();
  const hostRef = useRef<HTMLDivElement>(null);

  // Mount = attach the (possibly already-running) session; unmount = detach
  // ONLY — drag-and-drop survival depends on this. The PTY dies through
  // closeWorkspaceTerminal (tab ×, shell exit) or workspace close.
  useEffect(() => {
    const session = getOrCreateSession({
      id: terminal.id,
      cwd: ws.path,
      agent: false,
      onExit: (_code, early) => {
        // Normal exit closes the tab; an early failure keeps the corpse
        // readable (spawn error, bad dotfiles) for the user to close.
        if (!early) closeWorkspaceTerminal(ws.terminal, terminal.id);
      },
    });
    session.attach(hostRef.current!);
    return () => session.detach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  return (
    <div
      className={`dock-pane ${focused ? "focused" : ""}`}
      style={{ display: visible ? undefined : "none" }}
      onMouseDown={() => {
        ws.terminal.getState().setActiveTerminal(groupId, terminal.id);
        getSession(terminal.id)?.focus();
      }}
    >
      <div className="dock-pane-host" ref={hostRef} />
    </div>
  );
});

function TerminalTabIcon() {
  return <IcTerminal />;
}

function TerminalEmpty() {
  const ws = useWorkspace();
  return (
    <div className="terminal-empty">
      <div className="terminal-empty-text">No terminals</div>
      <button
        className="primary-btn"
        onClick={() => ws.terminal.getState().newTerminal()}
      >
        New Terminal
      </button>
    </div>
  );
}

/** One workspace's terminal dock (body only — the shared panel header with
 *  the group switcher lives in Panel.tsx). Stays mounted for the
 *  workspace's lifetime. */
export default function TerminalPanel() {
  const ws = useWorkspace();

  // Auto-create the first terminal exactly once. The ref survives React 19
  // StrictMode's dev double-mount, so we never auto-spawn two tabs — and a
  // user closing the last tab intentionally is not overridden.
  const autoCreated = useRef(false);
  useEffect(() => {
    if (
      !autoCreated.current &&
      Object.keys(ws.terminal.getState().terminals).length === 0
    ) {
      autoCreated.current = true;
      ws.terminal.getState().newTerminal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dock
      store={ws.terminal}
      Pane={TerminalPane}
      TabIcon={TerminalTabIcon}
      Empty={TerminalEmpty}
      closeTerminal={(id) => closeWorkspaceTerminal(ws.terminal, id)}
    />
  );
}
