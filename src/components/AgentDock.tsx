/**
 * The Agent Terminals flavor of the generic Dock: panes attach registry
 * sessions spawned in their bound project's directory (TERM_PROGRAM
 * masquerade + activity tracking), wear a project badge (double-click to
 * rename — the badge and the tab share one title), highlight when their
 * project is the active workspace, and clicking them switches the app to
 * that project (reopening it if it was closed → "disconnected" ⊘ until
 * then).
 */
import { memo, useEffect, useRef, useState } from "react";
import {
  agentTitleBase,
  useAgentTerminalsStore,
  type AgentTerminal,
} from "../stores/agentTerminals";
import { aggregateActivity } from "../stores/terminal";
import { switchToProject, useWorkspacesStore } from "../stores/workspaces";
import {
  closeAgentTerminal,
  getOrCreateAgentSession,
  openAgentTerminal,
} from "../lib/agentSessions";
import { getSession } from "../lib/termSessions";
import { useProjectColorVar } from "../lib/projectColors";
import { Dock, type DockPaneProps } from "./Dock";
import { ActivityGlyph, IcDisconnected, IcSparkle } from "./icons";
import "./AgentDock.css";

const useConnected = (workspacePath: string): boolean =>
  useWorkspacesStore((s) => s.workspaces.some((w) => w.path === workspacePath));

// ---------------------------------------------------------------------------
// Badge overlay (project name / custom title; double-click to rename)
// ---------------------------------------------------------------------------

function AgentBadge({
  terminal,
  connected,
}: {
  terminal: AgentTerminal;
  connected: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const projectColor = useProjectColorVar(terminal.workspacePath);

  const commit = (value: string) => {
    // An emptied title reverts to the default (the project's basename).
    useAgentTerminalsStore
      .getState()
      .renameTerminal(
        terminal.id,
        value.trim() || agentTitleBase(terminal.workspacePath),
      );
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        className="agent-badge-input"
        defaultValue={terminal.title}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        // Keep edits out of the terminal: no pane focus/switch on click, no
        // keystrokes reaching xterm or the global shortcut handler.
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit(e.currentTarget.value);
          else if (e.key === "Escape") {
            cancelled.current = true;
            setEditing(false);
          }
        }}
        onBlur={(e) => {
          if (!cancelled.current) commit(e.currentTarget.value);
        }}
      />
    );
  }

  return (
    <div
      className="agent-badge"
      title={`${terminal.workspacePath}${connected ? "" : " — project not open"}`}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={() => {
        cancelled.current = false;
        setEditing(true);
      }}
    >
      <span className="agent-badge-dot" style={{ background: projectColor }} />
      {!connected && <IcDisconnected className="agent-badge-disconnected" />}
      <span className="truncate">{terminal.title}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dock flavor components
// ---------------------------------------------------------------------------

const AgentPane = memo(function AgentPane({
  terminal,
  groupId,
  visible,
  focused,
}: DockPaneProps<AgentTerminal>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const connected = useConnected(terminal.workspacePath);
  // Highlight every terminal of the project currently active up top.
  const activeProject = useWorkspacesStore(
    (s) => s.activePath === terminal.workspacePath,
  );

  // Mount = attach the (possibly already-running) session; unmount = detach
  // ONLY. Disposal happens exclusively through closeAgentTerminal — drag
  // survival depends on this. getOrCreate is idempotent, so StrictMode's
  // double mount shares one session/shell.
  useEffect(() => {
    const session = getOrCreateAgentSession(terminal);
    session.attach(hostRef.current!);
    return () => session.detach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  return (
    <div
      className={`dock-pane ${focused ? "focused" : ""} ${
        activeProject ? "active-project" : ""
      }`}
      style={{ display: visible ? undefined : "none" }}
      onMouseDown={() => {
        // Clicking an agent terminal pulls its project to the front
        // (reopening it when it was closed — fire-and-forget).
        void switchToProject(terminal.workspacePath);
        useAgentTerminalsStore.getState().setActiveTerminal(groupId, terminal.id);
        const session = getSession(terminal.id);
        session?.acknowledge();
        session?.focus();
      }}
    >
      <div className="dock-pane-host" ref={hostRef} />
      <AgentBadge terminal={terminal} connected={connected} />
    </div>
  );
});

function AgentTabIcon({ terminal }: { terminal: AgentTerminal }) {
  const activity = useAgentTerminalsStore((s) =>
    aggregateActivity(s.paneActivity, [terminal.id]),
  );
  const projectColor = useProjectColorVar(terminal.workspacePath);
  // Idle sparkle tinted in the project's color (matches the titlebar tab and
  // badge dot); busy/attention glyphs keep their semantic colors.
  return (
    <ActivityGlyph
      activity={activity}
      idle={<IcSparkle style={{ color: projectColor }} />}
    />
  );
}

function AgentTabBadge({ terminal }: { terminal: AgentTerminal }) {
  const connected = useConnected(terminal.workspacePath);
  return connected ? null : <IcDisconnected className="dock-tab-disconnected" />;
}

function AgentEmpty() {
  const activePath = useWorkspacesStore((s) => s.activePath);
  return (
    <div className="terminal-empty">
      <div className="terminal-empty-text">
        {activePath
          ? "No agent terminals"
          : "No agent terminals — open a project to create one"}
      </div>
      <button
        className="primary-btn"
        disabled={!activePath}
        onClick={() => activePath && openAgentTerminal(activePath)}
      >
        <IcSparkle /> New Agent Terminal
      </button>
    </div>
  );
}

export default function AgentDock() {
  return (
    <Dock
      store={useAgentTerminalsStore}
      Pane={AgentPane}
      TabIcon={AgentTabIcon}
      TabBadge={AgentTabBadge}
      Empty={AgentEmpty}
      tabTooltip={(t) => t.workspacePath}
      defaultTitle={(t) => agentTitleBase(t.workspacePath)}
      onSelectTerminal={(t) => void switchToProject(t.workspacePath)}
      closeTerminal={closeAgentTerminal}
    />
  );
}
