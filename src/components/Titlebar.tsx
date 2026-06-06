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

/** Right-click menu for a workspace tab: pick the project's accent color. */
function ProjectColorMenu({
  path,
  x,
  y,
  onClose,
}: {
  path: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const colorIndex = useProjectColorIndex(path);
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
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
  onContext,
}: {
  ws: Workspace;
  active: boolean;
  ambiguous: boolean;
  onContext: (path: string, e: ReactMouseEvent) => void;
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
      onContextMenu={(e) => onContext(ws.path, e)}
    >
      {/* Idle glyph tinted in the project's color (identity carrier); the
          busy/attention glyphs keep their semantic colors. The inline style
          outranks Titlebar.css's .ws-tab > svg fg-dim rule. */}
      <ActivityGlyph
        activity={activity}
        idle={<IcFolder style={{ color: paletteColor(colorIndex) }} />}
      />
      <span className="truncate">
        {ws.name}
        {ambiguous && <span className="ws-tab-dir"> · {parentDir(ws.path)}</span>}
      </span>
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
  // Rendered as a sibling of the tab strip (not inside the tab) so backdrop
  // and swatch clicks don't bubble into the tab's activate-on-mousedown.
  const [colorMenu, setColorMenu] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);

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
    nameCounts.set(ws.name, (nameCounts.get(ws.name) ?? 0) + 1);
  }

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-tabs">
        {workspaces.map((ws) => (
          <WorkspaceTab
            key={ws.path}
            ws={ws}
            active={ws.path === activePath}
            ambiguous={(nameCounts.get(ws.name) ?? 0) > 1}
            onContext={(path, e) => {
              e.preventDefault();
              setColorMenu({ path, x: e.clientX, y: e.clientY });
            }}
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
        <div className="titlebar-center">Minimal IDE</div>
      )}

      <div className="titlebar-right">
        {active && <ActiveRepoControls ws={active} />}
      </div>

      {colorMenu && (
        <ProjectColorMenu
          path={colorMenu.path}
          x={colorMenu.x}
          y={colorMenu.y}
          onClose={() => setColorMenu(null)}
        />
      )}
    </div>
  );
}
