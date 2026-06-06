/**
 * Agent-dock glue between the session registry (lib/termSessions) and the
 * agentTerminals store: agent sessions spawn in their bound project's
 * directory with the TERM_PROGRAM masquerade + activity tracking, and their
 * close path disposes the PTY before the structural removal.
 */
import { getOrCreateSession, disposeSession, type TermSession } from "./termSessions";
import {
  useAgentTerminalsStore,
  type AgentTerminal,
} from "../stores/agentTerminals";

/** The (possibly already-running) session for an agent terminal. */
export function getOrCreateAgentSession(t: AgentTerminal): TermSession {
  return getOrCreateSession({
    id: t.id,
    cwd: t.workspacePath,
    agent: true,
    onActivity: (activity) =>
      useAgentTerminalsStore.getState().setPaneActivity(t.id, activity),
    onTitle: (title) =>
      useAgentTerminalsStore.getState().setPaneTitle(t.id, title),
    onExit: (_code, early) => {
      // Normal exit closes the tab (like the workspace docks); an early
      // failure keeps the corpse readable and the user closes it manually.
      if (!early) closeAgentTerminal(t.id);
    },
  });
}

/** UI-facing close: kill the PTY first, then remove the tab from the layout. */
export function closeAgentTerminal(id: string): void {
  disposeSession(id);
  useAgentTerminalsStore.getState().closeTerminal(id);
}

/**
 * UI-facing create. Only places the tab — the session itself is created
 * when the new tab's host mounts, which is also how persisted layouts
 * respawn their shells after a restart.
 */
export function openAgentTerminal(
  workspacePath: string,
  opts?: { groupId?: string },
): string {
  return useAgentTerminalsStore.getState().newTerminal(workspacePath, opts);
}
