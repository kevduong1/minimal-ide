import { useEffect, useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import { message, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  getRecentRepos,
  restoreSession,
  useActiveWorkspace,
  useWorkspacesStore,
  WorkspaceContext,
  type Workspace,
} from "./stores/workspaces";
import { useUiStore } from "./stores/ui";
import { closeTabSafely } from "./stores/editor";
import { projectColorVar } from "./lib/projectColors";
import Titlebar from "./components/Titlebar";
import StatusBar from "./components/StatusBar";
import FileExplorer from "./components/FileExplorer";
import SourceControl from "./components/SourceControl";
import EditorArea from "./components/EditorArea";
import Panel from "./components/Panel";
import { Resizer } from "./components/Resizer";
import { IcBranch, IcFile } from "./components/icons";

/** Slim far-left icon strip for switching sidebar panels. */
function ActivityBar() {
  const ws = useActiveWorkspace();
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const setSidebarTab = useUiStore((s) => s.setSidebarTab);
  const active = (tab: string) => sidebarVisible && sidebarTab === tab;

  return (
    <div className="activity-bar">
      <button
        className={`activity-btn ${active("explorer") ? "active" : ""}`}
        title="Explorer"
        onClick={() => setSidebarTab("explorer")}
      >
        <IcFile />
      </button>
      <button
        className={`activity-btn ${active("scm") ? "active" : ""}`}
        title="Source Control"
        onClick={() => setSidebarTab("scm")}
      >
        <IcBranch />
        {ws && <ChangeCountBadge ws={ws} />}
      </button>
    </div>
  );
}

/** Uncommitted-change count of the active workspace. */
function ChangeCountBadge({ ws }: { ws: Workspace }) {
  const changeCount = useStore(
    ws.repo,
    (s) => (s.status?.staged.length ?? 0) + (s.status?.unstaged.length ?? 0),
  );
  if (changeCount === 0) return null;
  return <span className="badge">{changeCount}</span>;
}

function Welcome() {
  const openWorkspace = useWorkspacesStore((s) => s.openWorkspace);
  const [recent] = useState(getRecentRepos);

  // window.alert is a silent no-op in WKWebView — use the dialog plugin.
  const showOpenError = (e: unknown) =>
    void message(`Not a git repository:\n${e}`, {
      title: "Cannot open folder",
      kind: "error",
    });

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === "string") {
      try {
        await openWorkspace(dir);
      } catch (e) {
        showOpenError(e);
      }
    }
  };

  return (
    <div className="welcome">
      <h1>Minimal IDE</h1>
      <div>Open a git repository to get started</div>
      <button className="open-btn" onClick={pickFolder}>
        Open Folder…
      </button>
      {recent.length > 0 && (
        <div className="recent">
          <div className="label">Recent</div>
          {recent.map((p) => (
            <button
              key={p}
              onClick={() => void openWorkspace(p).catch(showOpenError)}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One workspace's sidebar content / editor surface. EVERY workspace's pair
 * stays mounted; inactive ones are hidden with display:none so editor
 * buffers and explorer state are exactly as the user left them when
 * switching back. (Terminals live in the global bottom panel —
 * components/Panel.tsx.)
 */
function WorkspaceSidebarContent({ visible }: { visible: boolean }) {
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  return (
    <div
      className="app-sidebar-content"
      style={{ display: visible ? undefined : "none" }}
    >
      {sidebarTab === "explorer" ? <FileExplorer /> : <SourceControl />}
    </div>
  );
}

function WorkspaceEditor({ visible }: { visible: boolean }) {
  return (
    <div
      className="workspace-editor"
      style={{ display: visible ? undefined : "none" }}
    >
      <EditorArea />
    </div>
  );
}

/** Survives StrictMode's dev double-mount (App is mounted once). */
let sessionRestored = false;

export default function App() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activePath = useWorkspacesStore((s) => s.activePath);

  // Reopen last session's workspaces on launch (VSCode-style).
  useEffect(() => {
    if (sessionRestored) return;
    sessionRestored = true;
    void restoreSession();
  }, []);

  const togglePanel = useUiStore((s) => s.togglePanel);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "`") {
        e.preventDefault();
        togglePanel();
      } else if (e.key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        const { workspaces, activePath } = useWorkspacesStore.getState();
        const ws = workspaces.find((w) => w.path === activePath);
        const activeTabId = ws?.editor.getState().activeTabId;
        if (ws && activeTabId) void closeTabSafely(ws.editor, activeTabId);
      } else if (e.key >= "1" && e.key <= "9" && !e.shiftKey && !e.altKey) {
        // ⌘1…⌘9: jump to the Nth workspace tab
        const { workspaces, setActive } = useWorkspacesStore.getState();
        const ws = workspaces[Number(e.key) - 1];
        if (ws) {
          e.preventDefault();
          setActive(ws.path);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel, toggleSidebar]);

  const hasWorkspaces = workspaces.length > 0;
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const panelMaximized = useUiStore((s) => s.panelMaximized);

  // The whole accent family (commit button, rings, selections — derived from
  // --accent via color-mix in theme.css) follows the active project's color.
  const accentStyle = activePath
    ? ({ "--accent": projectColorVar(activePath) } as CSSProperties)
    : undefined;

  return (
    <div className="app" style={accentStyle}>
      <Titlebar />
      <div className="app-main">
        {hasWorkspaces && <ActivityBar />}
        {/* Sidebar spans the full app height; the bottom panel sits beside
            it, under the editor column only. */}
        {hasWorkspaces && sidebarVisible && (
          <div className="app-sidebar" style={{ width: sidebarWidth }}>
            {workspaces.map((ws) => (
              <WorkspaceContext.Provider key={ws.path} value={ws}>
                <WorkspaceSidebarContent visible={ws.path === activePath} />
              </WorkspaceContext.Provider>
            ))}
            <Resizer
              direction="vertical"
              onDelta={(d) =>
                setSidebarWidth(useUiStore.getState().sidebarWidth + d)
              }
            />
          </div>
        )}
        <div className="app-center">
          {hasWorkspaces ? (
            // Hidden (not unmounted) while the panel is maximized — editor
            // buffers/scroll state follow the workspace-switch survival rule.
            <div
              className="app-editor-area"
              style={{ display: panelMaximized ? "none" : undefined }}
            >
              {workspaces.map((ws) => (
                <WorkspaceContext.Provider key={ws.path} value={ws}>
                  <WorkspaceEditor visible={ws.path === activePath} />
                </WorkspaceContext.Provider>
              ))}
            </div>
          ) : (
            <Welcome />
          )}
          {/* Mounted in a stable position for either branch above, so the
              docks (and their shells) survive the 0↔N workspace transition. */}
          <Panel />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
