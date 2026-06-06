/**
 * Editor area: tab bar + the active tab's content (file editor or diff
 * viewer). Inactive tabs are unmounted; unsaved file text survives via the
 * draft cache in Editor.tsx. The CodeMirror-heavy panes are lazy-loaded so
 * they stay out of the initial bundle.
 */
import { lazy, Suspense, useEffect, useRef } from "react";
import { closeTabSafely, useEditorStore, type Tab } from "../stores/editor";
import { statusColor } from "../lib/status";
import { IcBranch, IcClose, IcDiff, IcFile } from "./icons";
import "./EditorArea.css";

const Editor = lazy(() => import("./Editor"));
const DiffViewer = lazy(() => import("./DiffViewer"));

function TabItem({
  tab,
  active,
  dirty,
}: {
  tab: Tab;
  active: boolean;
  dirty: boolean;
}) {
  const setActive = useEditorStore((s) => s.setActive);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const iconColor =
    tab.kind === "diff" && tab.diff.status
      ? statusColor(tab.diff.status)
      : undefined;

  return (
    <div
      ref={ref}
      className={`editor-tab ${active ? "active" : ""} ${dirty ? "dirty" : ""}`}
      title={tab.kind === "file" ? tab.path : tab.diff.path}
      onClick={() => setActive(tab.id)}
      onMouseDown={(e) => {
        // prevent middle-click autoscroll; close on aux click below
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTabSafely(tab.id);
        }
      }}
    >
      <span className="tab-icon">
        {tab.kind === "file" ? (
          <IcFile />
        ) : (
          <IcDiff style={iconColor ? { color: iconColor } : undefined} />
        )}
      </span>
      <span className="tab-title truncate">{tab.title}</span>
      <span className="tab-trailing">
        <span className="tab-dirty-dot" />
        <button
          className="icon-btn tab-close"
          title="Close"
          onClick={(e) => {
            e.stopPropagation();
            void closeTabSafely(tab.id);
          }}
        >
          <IcClose />
        </button>
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="editor-empty">
      <IcBranch className="empty-icon" />
      <div className="empty-title">Open a file or select a change</div>
      <div className="empty-hints">
        <div className="hint-row">
          <span className="kbd">⌘ `</span>
          <span>Toggle terminal</span>
        </div>
        <div className="hint-row">
          <span className="kbd">⌘ B</span>
          <span>Toggle sidebar</span>
        </div>
        <div className="hint-row">
          <span className="kbd">⌘ W</span>
          <span>Close tab</span>
        </div>
      </div>
    </div>
  );
}

export default function EditorArea() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const dirty = useEditorStore((s) => s.dirty);

  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="editor-area">
      {tabs.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="editor-tabs">
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                dirty={!!dirty[tab.id]}
              />
            ))}
          </div>
          <div className="editor-content">
            <Suspense fallback={<div className="editor-msg dim">Loading…</div>}>
              {active?.kind === "file" && <Editor key={active.id} tab={active} />}
              {active?.kind === "diff" && (
                <DiffViewer key={active.id} tab={active} />
              )}
            </Suspense>
          </div>
        </>
      )}
    </div>
  );
}
