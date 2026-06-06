import { useStore } from "zustand";
import { useActiveWorkspace, type Workspace } from "../stores/workspaces";
import { useUiStore } from "../stores/ui";
import { IcBranch, IcSidebar, IcTerminal } from "./icons";
import "./StatusBar.css";

/** Branch / sync / error readout for the active workspace. */
function RepoStatus({ ws }: { ws: Workspace }) {
  const status = useStore(ws.repo, (s) => s.status);
  const syncing = useStore(ws.repo, (s) => s.syncing);
  const error = useStore(ws.repo, (s) => s.error);

  const branch = status?.branch ?? null;

  return (
    <>
      {branch && (
        <button
          className="statusbar-item statusbar-clickable"
          title="Refresh repository status"
          onClick={() => void ws.repo.getState().refresh()}
        >
          <IcBranch />
          <span className="truncate statusbar-branch-name">{branch.name}</span>
        </button>
      )}
      {branch && (branch.ahead > 0 || branch.behind > 0) && (
        <span className="statusbar-item">
          {branch.ahead > 0 && <span>&#8593;{branch.ahead}</span>}
          {branch.behind > 0 && <span>&#8595;{branch.behind}</span>}
        </span>
      )}
      {syncing && (
        <span className="statusbar-item">
          <span className="statusbar-spinner" />
          Syncing
        </span>
      )}
      {error && (
        <button
          className="statusbar-item statusbar-clickable statusbar-error"
          title="Click to dismiss"
          onClick={() => ws.repo.getState().clearError()}
        >
          <span className="truncate">{error}</span>
        </button>
      )}
    </>
  );
}

export default function StatusBar() {
  const ws = useActiveWorkspace();

  const terminalVisible = useUiStore((s) => s.terminalVisible);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  return (
    <div className="statusbar">
      {ws && <RepoStatus key={ws.path} ws={ws} />}

      <div className="statusbar-right">
        {ws && (
          <span className="truncate statusbar-path" title={ws.path}>
            {ws.path}
          </span>
        )}
        <span className="statusbar-divider" />
        <button
          className={`icon-btn statusbar-toggle ${terminalVisible ? "active" : ""}`}
          title="Toggle terminal panel"
          onClick={toggleTerminal}
        >
          <IcTerminal />
        </button>
        <button
          className={`icon-btn statusbar-toggle ${sidebarVisible ? "active" : ""}`}
          title="Toggle sidebar"
          onClick={toggleSidebar}
        >
          <IcSidebar />
        </button>
      </div>
    </div>
  );
}
