import { open as openDialog, message } from "@tauri-apps/plugin-dialog";
import { useRepoStore } from "../stores/repo";
import { IcBranch, IcFolder, IcFolderOpen, IcSync } from "./icons";
import "./Titlebar.css";

export default function Titlebar() {
  const repoPath = useRepoStore((s) => s.repoPath);
  const repoName = useRepoStore((s) => s.repoName);
  const status = useRepoStore((s) => s.status);
  const syncing = useRepoStore((s) => s.syncing);
  const fetch = useRepoStore((s) => s.fetch);
  const openRepo = useRepoStore((s) => s.openRepo);

  const branch = status?.branch ?? null;

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      await openRepo(dir);
    } catch (e) {
      await message(String(e), { title: "Open Repository", kind: "error" });
    }
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        {repoPath && (
          <span className="titlebar-repo" data-tauri-drag-region>
            <IcFolder />
            <span className="truncate">{repoName}</span>
          </span>
        )}
        {repoPath && branch && (
          <span className="titlebar-branch-pill" data-tauri-drag-region>
            <IcBranch />
            <span className="truncate">{branch.name}</span>
            {(branch.ahead > 0 || branch.behind > 0) && (
              <span className="titlebar-aheadbehind">
                {branch.ahead > 0 && <span>{branch.ahead}&#8593;</span>}
                {branch.behind > 0 && <span>{branch.behind}&#8595;</span>}
              </span>
            )}
          </span>
        )}
      </div>

      {!repoPath && <div className="titlebar-center">Minimal IDE</div>}

      <div className="titlebar-right">
        {repoPath && (
          <button
            className={`icon-btn ${syncing ? "titlebar-syncing" : ""}`}
            title="Fetch from remote"
            disabled={syncing}
            onClick={() => void fetch()}
          >
            <IcSync />
          </button>
        )}
        <button
          className="icon-btn"
          title="Open Folder…"
          onClick={() => void pickFolder()}
        >
          <IcFolderOpen />
        </button>
      </div>
    </div>
  );
}
