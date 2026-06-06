/**
 * Workspace-dock glue between the session registry (lib/termSessions) and a
 * workspace's terminal store: plain shells spawned at the workspace root (no
 * activity tracking, no TERM_PROGRAM masquerade), with the close path
 * disposing the PTY before the structural removal. Used by the pane host in
 * components/TerminalPanel.tsx and by the task runner (lib/taskRunner.ts),
 * which needs the session before the new tab's pane has mounted.
 */
import {
  getOrCreateSession,
  disposeSession,
  type TermSession,
} from "./termSessions";
import type { TerminalStore } from "../stores/terminal";
import type { Workspace } from "../stores/workspaces";

/** The (possibly already-running) session for a workspace terminal. */
export function getOrCreateWorkspaceSession(
  ws: Workspace,
  id: string,
): TermSession {
  return getOrCreateSession({
    id,
    cwd: ws.path,
    agent: false,
    onExit: (_code, early) => {
      // Normal exit closes the tab; an early failure keeps the corpse
      // readable (spawn error, bad dotfiles) for the user to close.
      if (!early) closeWorkspaceTerminal(ws.terminal, id);
    },
  });
}

/** UI-facing close: kill the PTY first, then remove the tab from the layout. */
export function closeWorkspaceTerminal(store: TerminalStore, id: string): void {
  disposeSession(id);
  store.getState().closeTerminal(id);
}
