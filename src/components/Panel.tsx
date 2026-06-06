/**
 * Global bottom panel, hoisted out of the workspace trees so it can host two
 * groups: "Terminal" (the active workspace's tabbed terminals — every
 * workspace's body stays mounted, display:none, same survival rule as the
 * workspace views) and "Agent Terminals" (the global dock, mounted exactly
 * once so its terminals live across workspace switches).
 */
import {
  useActiveWorkspace,
  useWorkspacesStore,
  WorkspaceContext,
} from "../stores/workspaces";
import {
  useEffectivePanelGroup,
  useUiStore,
  type PanelGroup,
} from "../stores/ui";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import { aggregateActivity } from "../stores/terminal";
import { openAgentTerminal } from "../lib/agentSessions";
import TerminalPanel from "./TerminalPanel";
import AgentDock from "./AgentDock";
import { Resizer } from "./Resizer";
import {
  IcChevronDown,
  IcChevronsDown,
  IcChevronsUp,
  IcDot,
  IcPlus,
  IcSparkle,
  IcSplit,
} from "./icons";
import "./Panel.css";

function PanelHeader({ group }: { group: PanelGroup }) {
  const setPanelGroup = useUiStore((s) => s.setPanelGroup);
  const setPanelVisible = useUiStore((s) => s.setPanelVisible);
  const maximized = useUiStore((s) => s.panelMaximized);
  const togglePanelMaximized = useUiStore((s) => s.togglePanelMaximized);
  const hasWorkspaces = useWorkspacesStore((s) => s.workspaces.length > 0);
  const activeWs = useActiveWorkspace();
  // Surface a waiting agent even while the other group is in front.
  const agentAttention = useAgentTerminalsStore(
    (s) => aggregateActivity(s.paneActivity) === "attention",
  );

  return (
    <div
      className="panel-header"
      // VS Code-style: double-click the header (incl. group tabs) toggles
      // maximize — but not on the action buttons, where a fast double press
      // (e.g. New Terminal twice) is a legitimate gesture.
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".panel-actions")) return;
        togglePanelMaximized();
      }}
    >
      <button
        className={`panel-group-tab ${group === "agent" ? "active" : ""}`}
        onClick={() => setPanelGroup("agent")}
      >
        Agent Terminals
        {group !== "agent" && agentAttention && (
          <IcDot className="activity-attention panel-group-dot" />
        )}
      </button>
      {hasWorkspaces && (
        <button
          className={`panel-group-tab ${group === "terminal" ? "active" : ""}`}
          onClick={() => setPanelGroup("terminal")}
        >
          Terminal
        </button>
      )}

      <div className="panel-header-spacer" />

      <div className="panel-actions">
        {group === "terminal" && activeWs && (
          <>
            <button
              className="icon-btn"
              title="New Terminal"
              onClick={() => activeWs.terminal.getState().newTerminal()}
            >
              <IcPlus />
            </button>
            <button
              className="icon-btn"
              title="Split Terminal"
              onClick={() => activeWs.terminal.getState().splitActive()}
            >
              <IcSplit />
            </button>
          </>
        )}
        {group === "agent" && (
          <button
            className="icon-btn"
            title="New Agent Terminal"
            disabled={!activeWs}
            onClick={() => activeWs && openAgentTerminal(activeWs.path)}
          >
            <IcSparkle />
          </button>
        )}
        <button
          className="icon-btn"
          title={maximized ? "Restore Panel Size" : "Maximize Panel Size"}
          onClick={togglePanelMaximized}
        >
          {maximized ? <IcChevronsDown /> : <IcChevronsUp />}
        </button>
        <button
          className="icon-btn"
          title="Hide Panel"
          onClick={() => setPanelVisible(false)}
        >
          <IcChevronDown />
        </button>
      </div>
    </div>
  );
}

export default function Panel() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activePath = useWorkspacesStore((s) => s.activePath);
  const panelVisible = useUiStore((s) => s.panelVisible);
  const panelHeight = useUiStore((s) => s.panelHeight);
  const setPanelHeight = useUiStore((s) => s.setPanelHeight);
  const maximized = useUiStore((s) => s.panelMaximized);
  const group = useEffectivePanelGroup();
  const hasAgents = useAgentTerminalsStore((s) => s.root !== null);

  // With nothing to show (welcome screen, no agent terminals) the panel
  // disappears entirely; it is still MOUNTED either way — terminals hide
  // with display:none, never by unmounting (that would kill their PTYs).
  const shown = panelVisible && (workspaces.length > 0 || hasAgents);

  return (
    <div
      className="app-panel"
      style={{
        // Maximized = fill the center column (App.tsx hides the editor area).
        height: shown ? (maximized ? "100%" : panelHeight) : 0,
        display: shown ? undefined : "none",
      }}
    >
      {!maximized && (
        <Resizer
          direction="horizontal"
          onDelta={(d) => setPanelHeight(useUiStore.getState().panelHeight - d)}
        />
      )}
      <PanelHeader group={group} />
      <div className="panel-body">
        {workspaces.map((ws) => (
          <WorkspaceContext.Provider key={ws.path} value={ws}>
            <div
              className="panel-group-body"
              style={{
                display:
                  group === "terminal" && ws.path === activePath
                    ? undefined
                    : "none",
              }}
            >
              <TerminalPanel />
            </div>
          </WorkspaceContext.Provider>
        ))}
        <div
          className="panel-group-body"
          style={{ display: group === "agent" ? undefined : "none" }}
        >
          <AgentDock />
        </div>
      </div>
    </div>
  );
}
