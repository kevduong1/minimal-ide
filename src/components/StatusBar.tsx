import { useRepoStore } from "../stores/repo";
import { useUiStore } from "../stores/ui";
import { IcBranch, IcSidebar, IcTerminal } from "./icons";
import "./StatusBar.css";

export default function StatusBar() {
  const repoPath = useRepoStore((s) => s.repoPath);
  const status = useRepoStore((s) => s.status);
  const syncing = useRepoStore((s) => s.syncing);
  const error = useRepoStore((s) => s.error);
  const refresh = useRepoStore((s) => s.refresh);
  const clearError = useRepoStore((s) => s.clearError);

  const terminalVisible = useUiStore((s) => s.terminalVisible);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  const branch = status?.branch ?? null;

  return (
    <div className="statusbar">
      {branch && (
        <button
          className="statusbar-item statusbar-clickable"
          title="Refresh repository status"
          onClick={() => void refresh()}
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
          onClick={clearError}
        >
          <span className="truncate">{error}</span>
        </button>
      )}

      <div className="statusbar-right">
        {repoPath && (
          <span className="truncate statusbar-path" title={repoPath}>
            {repoPath}
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
