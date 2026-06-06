/**
 * Registry of live terminal sessions (both docks: workspace terminals and
 * agent terminals). React pane hosts get-or-create their session on mount
 * and detach on unmount; sessions die exclusively through disposeSession —
 * so dragging a terminal between dock groups (unmount + remount) never
 * touches its shell.
 */
import {
  createTermSession,
  type TermSession,
  type TermSessionOptions,
} from "./termSession";

export type { TermSession, TermSessionOptions };

const sessions = new Map<string, TermSession>();

/**
 * The session for a terminal, created (and its shell spawned, lazily on
 * first attach) if it doesn't exist yet. Idempotent: the synchronous
 * check-then-set means a StrictMode double mount shares one session.
 */
export function getOrCreateSession(opts: TermSessionOptions): TermSession {
  const existing = sessions.get(opts.id);
  if (existing) return existing;
  const session = createTermSession(opts);
  sessions.set(opts.id, session);
  return session;
}

export function getSession(id: string): TermSession | undefined {
  return sessions.get(id);
}

/**
 * Kill the PTY and forget the session. Idempotent, and safe for sessions
 * whose shell already exited (the inner ptyKill rejects into a swallowed
 * catch). Callers pair this with the owning store's structural removal.
 */
export function disposeSession(id: string): void {
  sessions.get(id)?.dispose();
  sessions.delete(id);
}
