import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { confirm, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import { useEditor, useRepo, useWorkspace } from "../stores/workspaces";
import type { FileStatus } from "../lib/ipc";
import { statusColor, statusLetter, statusPaths } from "../lib/status";
import GitGraph from "./GitGraph";
import {
  IcApply,
  IcBox,
  IcCheck,
  IcChevronDown,
  IcChevronRight,
  IcDiscard,
  IcFile,
  IcMinus,
  IcPlus,
  IcPop,
  IcPull,
  IcPush,
  IcRefresh,
  IcSync,
  IcTrash,
} from "./icons";
import "./SourceControl.css";

/* ----------------------------------------------------------------------- */
/* Path helpers                                                             */
/* ----------------------------------------------------------------------- */

const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const dirname = (p: string) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

/* ----------------------------------------------------------------------- */
/* Collapsible section                                                      */
/* ----------------------------------------------------------------------- */

function Section({
  title,
  count,
  open,
  onToggle,
  actions,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`sc-section ${open ? "open" : ""}`}>
      <div className="sc-section-header" onClick={onToggle}>
        <span className={`sc-chevron ${open ? "open" : ""}`}>
          <IcChevronRight />
        </span>
        <span className="sc-section-title truncate">{title}</span>
        {count !== undefined && <span className="sc-badge">{count}</span>}
        {actions && (
          <span
            className="sc-section-actions"
            onClick={(e) => e.stopPropagation()}
          >
            {actions}
          </span>
        )}
      </div>
      {open && children}
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* File row                                                                 */
/* ----------------------------------------------------------------------- */

function FileRow({ file, staged }: { file: FileStatus; staged: boolean }) {
  const ws = useWorkspace();
  const openDiff = useEditor((s) => s.openDiff);
  const openFile = useEditor((s) => s.openFile);
  const color = statusColor(file.status);
  const name = basename(file.path);
  const dir = dirname(file.path);

  const onRowClick = () => {
    openDiff({
      repoPath: ws.path,
      path: file.path,
      kind: staged ? "staged" : "worktree",
      status: file.status,
      origPath: file.origPath,
    });
  };

  const onOpenFile = () => {
    openFile(`${ws.path}/${file.path}`);
  };

  const onDiscard = async () => {
    const verb =
      file.status === "?"
        ? `Are you sure you want to DELETE ${name}?`
        : `Are you sure you want to discard changes in ${name}?`;
    const ok = await confirm(`${verb}\nThis is irreversible!`, {
      title: "Discard Changes",
      kind: "warning",
    });
    if (ok) await ws.repo.getState().discard(statusPaths(file));
  };

  return (
    <div className="sc-row sc-file-row" title={file.path} onClick={onRowClick}>
      <span
        className={`sc-file-name truncate${file.status === "D" ? " deleted" : ""}`}
        style={{ color }}
      >
        {name}
      </span>
      <span className="sc-file-dir truncate">{dir}</span>
      <span className="sc-row-actions" onClick={(e) => e.stopPropagation()}>
        {file.status !== "D" && (
          <button className="icon-btn" title="Open File" onClick={onOpenFile}>
            <IcFile />
          </button>
        )}
        {!staged && (
          <button
            className="icon-btn"
            title="Discard Changes"
            onClick={() => void onDiscard()}
          >
            <IcDiscard />
          </button>
        )}
        {staged ? (
          <button
            className="icon-btn"
            title="Unstage Changes"
            onClick={() => void ws.repo.getState().unstage(statusPaths(file))}
          >
            <IcMinus />
          </button>
        ) : (
          <button
            className="icon-btn"
            title="Stage Changes"
            onClick={() => void ws.repo.getState().stage(statusPaths(file))}
          >
            <IcPlus />
          </button>
        )}
      </span>
      <span className="sc-file-letter" style={{ color }}>
        {statusLetter(file.status)}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* SourceControl                                                            */
/* ----------------------------------------------------------------------- */

const MAX_INPUT_HEIGHT = 6 * 18 + 12; // 6 lines * line-height + padding

export default function SourceControl() {
  const ws = useWorkspace();
  const { status, stashes, syncing } = useRepo(
    useShallow((s) => ({
      status: s.status,
      stashes: s.stashes,
      syncing: s.syncing,
    })),
  );
  const {
    refresh,
    fetch: fetchRemote,
    pull,
    push,
  } = useRepo(
    useShallow((s) => ({
      refresh: s.refresh,
      fetch: s.fetch,
      pull: s.pull,
      push: s.push,
    })),
  );

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const branch = status?.branch.name ?? "";

  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [stashesOpen, setStashesOpen] = useState(false);
  const [commitsOpen, setCommitsOpen] = useState(true);
  const [stashInputOpen, setStashInputOpen] = useState(false);
  const [stashMsg, setStashMsg] = useState("");

  const taRef = useRef<HTMLTextAreaElement>(null);
  const stashInputRef = useRef<HTMLInputElement>(null);

  // auto-grow the commit textarea between 1 and 6 lines
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [commitMsg]);

  useEffect(() => {
    if (stashInputOpen) stashInputRef.current?.focus();
  }, [stashInputOpen]);

  const doCommit = useCallback(
    async (amend: boolean, andPush: boolean) => {
      const msg = commitMsg.trim();
      // an empty message + amend keeps the prior commit message
      if ((!msg && !amend) || busy) return;
      const store = ws.repo.getState();
      if (!store.status) return;
      setBusy(true);
      try {
        if (!amend && store.status.staged.length === 0) {
          if (store.status.unstaged.length === 0) {
            await messageDialog("There are no changes to commit.", {
              title: "Source Control",
            });
            return;
          }
          const proceed = await confirm(
            "There are no staged changes to commit.\n\nWould you like to stage all your changes and commit them directly?",
            { title: "Source Control", kind: "warning" },
          );
          if (!proceed) return;
          if (!(await store.stage(store.status.unstaged.flatMap(statusPaths))))
            return;
        }
        const ok = await store.commit(msg, amend);
        if (!ok) return;
        setCommitMsg("");
        if (andPush) await ws.repo.getState().push();
      } finally {
        setBusy(false);
      }
    },
    [commitMsg, busy, ws],
  );

  const onCommitKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.metaKey && e.key === "Enter") {
      e.preventDefault();
      void doCommit(false, false);
    }
  };

  const onStageAll = () =>
    void ws.repo.getState().stage(unstaged.flatMap(statusPaths));
  const onUnstageAll = () =>
    void ws.repo.getState().unstage(staged.flatMap(statusPaths));

  const onDiscardAll = async () => {
    const n = unstaged.length;
    if (n === 0) return;
    const ok = await confirm(
      `Are you sure you want to discard ALL ${n} ${n === 1 ? "change" : "changes"}?\nThis is irreversible!`,
      { title: "Discard All Changes", kind: "warning" },
    );
    if (ok) await ws.repo.getState().discard(unstaged.flatMap(statusPaths));
  };

  const revealStashInput = () => {
    setStashesOpen(true);
    setStashInputOpen(true);
  };

  const onStashKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const msg = stashMsg.trim();
      setStashInputOpen(false);
      setStashMsg("");
      void ws.repo.getState().stashSave(msg || null, true);
    } else if (e.key === "Escape") {
      setStashInputOpen(false);
      setStashMsg("");
    }
  };

  const onStashDrop = async (oid: string, index: number) => {
    const ok = await confirm(
      `Are you sure you want to delete stash@{${index}}?`,
      { title: "Drop Stash", kind: "warning" },
    );
    if (ok) await ws.repo.getState().stashDrop(oid);
  };

  const canCommit = commitMsg.trim().length > 0 && !busy;
  const noChanges = staged.length === 0 && unstaged.length === 0;

  return (
    <div className="source-control">
      {/* panel header */}
      <div className="sc-header">
        <span className="sc-header-title truncate">Source Control</span>
        <button
          className="icon-btn"
          title="Refresh"
          disabled={syncing}
          onClick={() => void refresh()}
        >
          <IcRefresh />
        </button>
        <button
          className="icon-btn"
          title="Fetch"
          disabled={syncing}
          onClick={() => void fetchRemote()}
        >
          <IcSync />
        </button>
        <button
          className="icon-btn"
          title="Pull"
          disabled={syncing}
          onClick={() => void pull()}
        >
          <IcPull />
        </button>
        <button
          className="icon-btn"
          title="Push"
          disabled={syncing}
          onClick={() => void push()}
        >
          <IcPush />
        </button>
      </div>

      {/* commit box */}
      <div className="sc-commit-box">
        <textarea
          ref={taRef}
          className="commit-input"
          rows={1}
          placeholder={`Message (Cmd+Enter to commit on "${branch}")`}
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={onCommitKeyDown}
          spellCheck={false}
        />
        <div className="sc-commit-row">
          <button
            className="primary-btn sc-commit-btn"
            disabled={!canCommit}
            onClick={() => void doCommit(false, false)}
          >
            <IcCheck />
            Commit
          </button>
          <button
            className="sc-commit-caret"
            title="More Commit Actions…"
            disabled={busy}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IcChevronDown />
          </button>
          {menuOpen && (
            <>
              <div
                className="sc-menu-backdrop"
                onMouseDown={() => setMenuOpen(false)}
              />
              <div className="sc-menu">
                <button
                  disabled={!canCommit}
                  onClick={() => {
                    setMenuOpen(false);
                    void doCommit(false, false);
                  }}
                >
                  Commit
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    void doCommit(true, false);
                  }}
                >
                  Commit (Amend)
                </button>
                <button
                  disabled={!canCommit}
                  onClick={() => {
                    setMenuOpen(false);
                    void doCommit(false, true);
                  }}
                >
                  Commit &amp; Push
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* changes */}
      <div className="sc-changes">
        {noChanges ? (
          <div className="sc-empty">
            <IcCheck />
            <span>No changes</span>
          </div>
        ) : (
          <>
            {staged.length > 0 && (
              <Section
                title="Staged Changes"
                count={staged.length}
                open={stagedOpen}
                onToggle={() => setStagedOpen((v) => !v)}
                actions={
                  <button
                    className="icon-btn"
                    title="Unstage All Changes"
                    onClick={onUnstageAll}
                  >
                    <IcMinus />
                  </button>
                }
              >
                {staged.map((f) => (
                  <FileRow key={f.path} file={f} staged />
                ))}
              </Section>
            )}
            <Section
              title="Changes"
              count={unstaged.length}
              open={changesOpen}
              onToggle={() => setChangesOpen((v) => !v)}
              actions={
                <>
                  <button
                    className="icon-btn"
                    title="Stash Changes"
                    onClick={revealStashInput}
                  >
                    <IcBox />
                  </button>
                  <button
                    className="icon-btn"
                    title="Discard All Changes"
                    onClick={() => void onDiscardAll()}
                  >
                    <IcDiscard />
                  </button>
                  <button
                    className="icon-btn"
                    title="Stage All Changes"
                    onClick={onStageAll}
                  >
                    <IcPlus />
                  </button>
                </>
              }
            >
              {unstaged.map((f) => (
                <FileRow key={f.path} file={f} staged={false} />
              ))}
            </Section>
          </>
        )}
      </div>

      {/* stashes */}
      <div className="sc-stashes">
        <Section
          title="Stashes"
          count={stashes.length}
          open={stashesOpen}
          onToggle={() => setStashesOpen((v) => !v)}
          actions={
            <button
              className="icon-btn"
              title="Stash Changes"
              onClick={revealStashInput}
            >
              <IcPlus />
            </button>
          }
        >
          {stashInputOpen && (
            <div className="sc-stash-input-row">
              <input
                ref={stashInputRef}
                className="text-input"
                placeholder="Stash message (Enter)"
                value={stashMsg}
                onChange={(e) => setStashMsg(e.target.value)}
                onKeyDown={onStashKeyDown}
                onBlur={() => setStashInputOpen(false)}
              />
            </div>
          )}
          <div className="sc-stash-list">
            {stashes.map((st) => (
              <div
                key={st.oid}
                className="sc-row sc-stash-row"
                title={st.message}
              >
                <span className="sc-stash-icon">
                  <IcBox />
                </span>
                <span className="sc-stash-label truncate">
                  {`stash@{${st.index}}: ${st.message}`}
                </span>
                <span
                  className="sc-row-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="icon-btn"
                    title="Apply Stash"
                    onClick={() => void ws.repo.getState().stashApply(st.oid)}
                  >
                    <IcApply />
                  </button>
                  <button
                    className="icon-btn"
                    title="Pop Stash"
                    onClick={() => void ws.repo.getState().stashPop(st.oid)}
                  >
                    <IcPop />
                  </button>
                  <button
                    className="icon-btn"
                    title="Drop Stash"
                    onClick={() => void onStashDrop(st.oid, st.index)}
                  >
                    <IcTrash />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* commits graph */}
      <div className={`sc-commits ${commitsOpen ? "open" : ""}`}>
        <div
          className="sc-section-header"
          onClick={() => setCommitsOpen((v) => !v)}
        >
          <span className={`sc-chevron ${commitsOpen ? "open" : ""}`}>
            <IcChevronRight />
          </span>
          <span className="sc-section-title truncate">Commits</span>
        </div>
        {commitsOpen && (
          <div className="sc-graph-wrap">
            <GitGraph />
          </div>
        )}
      </div>
    </div>
  );
}
