import { useCallback, useEffect, useRef, useState } from "react";
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
import Titlebar from "./components/Titlebar";
import StatusBar from "./components/StatusBar";
import FileExplorer from "./components/FileExplorer";
import SourceControl from "./components/SourceControl";
import EditorArea from "./components/EditorArea";
import TerminalPanel from "./components/TerminalPanel";
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

/** Generic drag-to-resize handle. */
function Resizer({
  direction,
  onDelta,
}: {
  direction: "vertical" | "horizontal";
  onDelta: (delta: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      last.current = direction === "vertical" ? e.clientX : e.clientY;

      const onMove = (ev: MouseEvent) => {
        const pos = direction === "vertical" ? ev.clientX : ev.clientY;
        onDelta(pos - last.current);
        last.current = pos;
      };
      const onUp = () => {
        setDragging(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor =
        direction === "vertical" ? "col-resize" : "row-resize";
    },
    [direction, onDelta],
  );

  return (
    <div
      className={`resizer ${direction} ${dragging ? "dragging" : ""}`}
      onMouseDown={onMouseDown}
    />
  );
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
 * One workspace's whole working surface: sidebar + editor + terminal panel.
 * EVERY workspace stays mounted; inactive ones are hidden with display:none
 * so shells keep running, xterm buffers survive, and editor/explorer state
 * is exactly as the user left it when switching back.
 */
function WorkspaceView({ visible }: { visible: boolean }) {
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const terminalVisible = useUiStore((s) => s.terminalVisible);
  const terminalHeight = useUiStore((s) => s.terminalHeight);
  const setTerminalHeight = useUiStore((s) => s.setTerminalHeight);

  return (
    <div
      className="workspace"
      style={{ display: visible ? undefined : "none" }}
    >
      {sidebarVisible && (
        <div className="app-sidebar" style={{ width: sidebarWidth }}>
          <div className="app-sidebar-content">
            {sidebarTab === "explorer" ? <FileExplorer /> : <SourceControl />}
          </div>
          <Resizer
            direction="vertical"
            onDelta={(d) => setSidebarWidth(useUiStore.getState().sidebarWidth + d)}
          />
        </div>
      )}
      <div className="app-center">
        <div className="app-editor-area">
          <EditorArea />
        </div>
        <div
          className="app-terminal"
          style={{
            height: terminalVisible ? terminalHeight : 0,
            display: terminalVisible ? undefined : "none",
          }}
        >
          <Resizer
            direction="horizontal"
            onDelta={(d) =>
              setTerminalHeight(useUiStore.getState().terminalHeight - d)
            }
          />
          <TerminalPanel />
        </div>
      </div>
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

  const toggleTerminal = useUiStore((s) => s.toggleTerminal);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "`") {
        e.preventDefault();
        toggleTerminal();
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
  }, [toggleTerminal, toggleSidebar]);

  return (
    <div className="app">
      <Titlebar />
      <div className="app-main">
        {workspaces.length > 0 ? (
          <>
            <ActivityBar />
            {workspaces.map((ws) => (
              <WorkspaceContext.Provider key={ws.path} value={ws}>
                <WorkspaceView visible={ws.path === activePath} />
              </WorkspaceContext.Provider>
            ))}
          </>
        ) : (
          <Welcome />
        )}
      </div>
      <StatusBar />
    </div>
  );
}
