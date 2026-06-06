import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useStore } from "zustand";
import { open as openDialog, message } from "@tauri-apps/plugin-dialog";
import {
  useActiveWorkspace,
  useWorkspacesStore,
  type Workspace,
} from "../stores/workspaces";
import {
  selectWorkspaceActivity,
  useAgentTerminalsStore,
} from "../stores/agentTerminals";
import {
  paletteColor,
  PROJECT_COLOR_NAMES,
  setProjectColorIndex,
  useProjectColorIndex,
} from "../lib/projectColors";
import {
  setProjectDisplayName,
  useProjectDisplayName,
  useProjectDisplayNames,
} from "../lib/projectNames";
import { copyText } from "../lib/clipboard";
import { ContextMenu } from "./ContextMenu";
import {
  ActivityGlyph,
  IcBranch,
  IcClose,
  IcFolder,
  IcPlus,
  IcSync,
} from "./icons";
import "./Titlebar.css";

/** Parent directory name, for disambiguating same-named repos. */
const parentDir = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : "";
};

/** Right-click menu for a workspace tab: rename / copy path / accent color. */
function ProjectTabMenu({
  path,
  x,
  y,
  onClose,
  onRename,
}: {
  path: string;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
}) {
  const colorIndex = useProjectColorIndex(path);
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <button
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        Rename Project…
      </button>
      <button
        onClick={() => {
          void copyText(path);
          onClose();
        }}
      >
        Copy Path
      </button>
      <div className="ctx-menu-sep" />
      <div className="ws-color-label">Project Color</div>
      <div className="ws-color-row">
        {PROJECT_COLOR_NAMES.map((name, i) => (
          <button
            key={name}
            className={`ws-color-swatch ${i === colorIndex ? "selected" : ""}`}
            title={name}
            style={{ background: paletteColor(i) }}
            onClick={() => {
              setProjectColorIndex(path, i);
              onClose();
            }}
          />
        ))}
      </div>
    </ContextMenu>
  );
}

function WorkspaceTab({
  ws,
  active,
  ambiguous,
  renaming,
  onContext,
  onRenameStart,
  onRenameEnd,
}: {
  ws: Workspace;
  active: boolean;
  ambiguous: boolean;
  renaming: boolean;
  onContext: (path: string, e: ReactMouseEvent) => void;
  onRenameStart: () => void;
  onRenameEnd: () => void;
}) {
  const setActive = useWorkspacesStore((s) => s.setActive);
  const closeWorkspace = useWorkspacesStore((s) => s.closeWorkspace);
  // Agent-terminal activity trickles up from the global dock: spinner while
  // one of this project's agents works, pulsing dot when one is waiting on
  // the user (e.g. Claude Code asking a question).
  const activity = useAgentTerminalsStore((s) =>
    selectWorkspaceActivity(s, ws.path),
  );
  const ref = useRef<HTMLDivElement | null>(null);
  const colorIndex = useProjectColorIndex(ws.path);
  const name = useProjectDisplayName(ws.path);
  const cancelled = useRef(false);

  // An emptied name reverts to the default (the folder basename).
  const commitRename = (value: string) => {
    setProjectDisplayName(ws.path, value);
    onRenameEnd();
  };

  // keep the active tab reachable when the strip overflows (⌘1–9, restore)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div
      ref={ref}
      className={`ws-tab ${active ? "active" : ""}`}
      title={ws.path}
      onMouseDown={(e) => {
        // prevent middle-click autoscroll; close on aux click below
        if (e.button === 1) e.preventDefault();
        else if (e.button === 0) setActive(ws.path);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeWorkspace(ws.path);
        }
      }}
      onDoubleClick={onRenameStart}
      onContextMenu={(e) => onContext(ws.path, e)}
    >
      {/* All three glyph states tinted in the project's color (identity
          carrier). The inline styles outrank Titlebar.css's .ws-tab > svg
          fg-dim rule and the activity classes' default colors. */}
      <ActivityGlyph
        activity={activity}
        idle={<IcFolder style={{ color: paletteColor(colorIndex) }} />}
        color={paletteColor(colorIndex)}
      />
      {renaming ? (
        <input
          className="ws-tab-rename"
          defaultValue={name}
          autoFocus
          onFocus={(e) => {
            cancelled.current = false;
            e.currentTarget.select();
          }}
          // Keep edits out of the tab: no activate-on-mousedown, no
          // keystrokes reaching the global shortcut handler.
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitRename(e.currentTarget.value);
            else if (e.key === "Escape") {
              cancelled.current = true;
              onRenameEnd();
            }
          }}
          onBlur={(e) => {
            if (!cancelled.current) commitRename(e.currentTarget.value);
          }}
        />
      ) : (
        <span className="truncate">
          {name}
          {ambiguous && <span className="ws-tab-dir"> · {parentDir(ws.path)}</span>}
        </span>
      )}
      {!renaming && (
        <button
          className="ws-tab-close"
          title="Close Workspace"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void closeWorkspace(ws.path);
          }}
        >
          <IcClose />
        </button>
      )}
    </div>
  );
}

/** Branch pill + fetch button for the active workspace. */
function ActiveRepoControls({ ws }: { ws: Workspace }) {
  const status = useStore(ws.repo, (s) => s.status);
  const syncing = useStore(ws.repo, (s) => s.syncing);
  const branch = status?.branch ?? null;

  return (
    <>
      {branch && (
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
      <button
        className={`icon-btn ${syncing ? "titlebar-syncing" : ""}`}
        title="Fetch from remote"
        disabled={syncing}
        onClick={() => void ws.repo.getState().fetch()}
      >
        <IcSync />
      </button>
    </>
  );
}

export default function Titlebar() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activePath = useWorkspacesStore((s) => s.activePath);
  const openWorkspace = useWorkspacesStore((s) => s.openWorkspace);
  const active = useActiveWorkspace();
  const displayName = useProjectDisplayNames();
  // Rendered as a sibling of the tab strip (not inside the tab) so backdrop
  // and item clicks don't bubble into the tab's activate-on-mousedown.
  const [tabMenu, setTabMenu] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  // Lifted out of the tab so the context menu's Rename item can start an
  // inline edit on any tab.
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    try {
      await openWorkspace(dir);
    } catch (e) {
      await message(String(e), { title: "Open Repository", kind: "error" });
    }
  };

  const nameCounts = new Map<string, number>();
  for (const ws of workspaces) {
    const name = displayName(ws.path);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-tabs">
        {workspaces.map((ws) => (
          <WorkspaceTab
            key={ws.path}
            ws={ws}
            active={ws.path === activePath}
            ambiguous={(nameCounts.get(displayName(ws.path)) ?? 0) > 1}
            renaming={ws.path === renamingPath}
            onContext={(path, e) => {
              e.preventDefault();
              setTabMenu({ path, x: e.clientX, y: e.clientY });
            }}
            onRenameStart={() => setRenamingPath(ws.path)}
            onRenameEnd={() => setRenamingPath(null)}
          />
        ))}
        <button
          className="icon-btn ws-tab-add"
          title="Open Repository…"
          onClick={() => void pickFolder()}
        >
          <IcPlus />
        </button>
      </div>

      {workspaces.length === 0 && (
        <div className="titlebar-center">Vibe Studio</div>
      )}

      <div className="titlebar-right">
        {active && <ActiveRepoControls ws={active} />}
      </div>

      {tabMenu && (
        <ProjectTabMenu
          path={tabMenu.path}
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          onRename={() => setRenamingPath(tabMenu.path)}
        />
      )}
    </div>
  );
}
