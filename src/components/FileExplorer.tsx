import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { fsReadDir, onRepoChanged, type DirEntry } from "../lib/ipc";
import { useEditor, useRepo } from "../stores/workspaces";
import {
  IcChevronRight,
  IcCollapseAll,
  IcFile,
  IcFolder,
  IcRefresh,
} from "./icons";
import "./FileExplorer.css";

type DirCache = Map<string, DirEntry[] | "error">;

interface Row {
  key: string;
  kind: "entry" | "empty" | "error";
  entry: DirEntry | null;
  depth: number;
}

export default function FileExplorer() {
  const repoPath = useRepo((s) => s.repoPath);
  const repoName = useRepo((s) => s.repoName);
  const openFile = useEditor((s) => s.openFile);
  const activeTabId = useEditor((s) => s.activeTabId);

  const [cache, setCache] = useState<DirCache>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [rootExpanded, setRootExpanded] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const treeRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const repoPathRef = useRef(repoPath);
  const expandedRef = useRef(expanded);
  const cacheRef = useRef(cache);
  repoPathRef.current = repoPath;
  expandedRef.current = expanded;
  cacheRef.current = cache;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadDir = useCallback((path: string) => {
    fsReadDir(path).then(
      (entries) => {
        if (!mountedRef.current) return;
        setCache((c) => new Map(c).set(path, entries));
      },
      () => {
        if (!mountedRef.current) return;
        setCache((c) => new Map(c).set(path, "error"));
      },
    );
  }, []);

  /**
   * Re-reads root + every expanded dir. Collapsed dirs are pruned from the
   * cache, but dirs loaded concurrently (expanded mid-refetch) are kept.
   */
  const refetchExpanded = useCallback(async () => {
    const root = repoPathRef.current;
    if (!root) return;
    const dirs = [root, ...expandedRef.current];
    const results = await Promise.all(
      dirs.map(async (d): Promise<[string, DirEntry[] | "error"]> => {
        try {
          return [d, await fsReadDir(d)];
        } catch {
          return [d, "error"];
        }
      }),
    );
    if (!mountedRef.current) return;
    setCache((c) => {
      const next = new Map(results);
      for (const k of expandedRef.current) {
        if (!next.has(k) && c.has(k)) next.set(k, c.get(k)!);
      }
      return next;
    });
  }, []);

  // load the repo root whenever the repo changes
  useEffect(() => {
    setCache(new Map());
    setExpanded(new Set());
    setRootExpanded(true);
    setSelected(null);
    if (!repoPath) return;
    let cancelled = false;
    fsReadDir(repoPath).then(
      (entries) => {
        if (!cancelled) setCache(new Map([[repoPath, entries]]));
      },
      () => {
        if (!cancelled) setCache(new Map([[repoPath, "error"]]));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  // silently refresh expanded dirs when the repo workdir changes (debounced)
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void onRepoChanged((change) => {
      // events arrive for every open workspace — only ours matter
      if (change.repoPath !== repoPathRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetchExpanded(), 300);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [refetchExpanded]);

  // highlight the file backing the active editor tab
  const activeFilePath =
    activeTabId && activeTabId.startsWith("file:")
      ? activeTabId.slice("file:".length)
      : null;
  useEffect(() => {
    if (activeFilePath) setSelected(activeFilePath);
  }, [activeFilePath]);

  const toggleDir = useCallback(
    (path: string) => {
      const isOpen = expandedRef.current.has(path);
      const next = new Set(expandedRef.current);
      if (isOpen) next.delete(path);
      else next.add(path);
      setExpanded(next);
      if (!isOpen && !cacheRef.current.has(path)) loadDir(path);
    },
    [loadDir],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    const pushDir = (dirPath: string, depth: number) => {
      const entries = cache.get(dirPath);
      if (entries === undefined) return; // not loaded yet
      if (entries === "error") {
        out.push({ key: `${dirPath}::error`, kind: "error", entry: null, depth });
        return;
      }
      if (entries.length === 0) {
        out.push({ key: `${dirPath}::empty`, kind: "empty", entry: null, depth });
        return;
      }
      for (const e of entries) {
        out.push({ key: e.path, kind: "entry", entry: e, depth });
        if (e.isDir && expanded.has(e.path)) pushDir(e.path, depth + 1);
      }
    };
    if (repoPath && rootExpanded) pushDir(repoPath, 0);
    return out;
  }, [cache, expanded, rootExpanded, repoPath]);

  const scrollRowIntoView = (path: string) => {
    requestAnimationFrame(() => {
      treeRef.current
        ?.querySelector(`[data-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  const onRowClick = (e: DirEntry) => {
    setSelected(e.path);
    if (e.isDir) toggleDir(e.path);
    else openFile(e.path);
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const entries = rows.filter((r) => r.kind === "entry").map((r) => r.entry!);
    if (entries.length === 0) return;
    const idx = entries.findIndex((e) => e.path === selected);
    const sel = idx >= 0 ? entries[idx] : null;

    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const ni =
        idx === -1
          ? 0
          : Math.min(
              entries.length - 1,
              Math.max(0, idx + (ev.key === "ArrowDown" ? 1 : -1)),
            );
      setSelected(entries[ni].path);
      scrollRowIntoView(entries[ni].path);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      if (sel?.isDir && !expanded.has(sel.path)) toggleDir(sel.path);
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      if (sel?.isDir && expanded.has(sel.path)) toggleDir(sel.path);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (!sel) return;
      if (sel.isDir) toggleDir(sel.path);
      else openFile(sel.path);
    }
  };

  return (
    <div className="file-explorer">
      <div className="fx-header">
        <span className="fx-title">Explorer</span>
        <div className="fx-actions">
          <button
            className="icon-btn"
            title="Collapse all"
            onClick={() => setExpanded(new Set())}
          >
            <IcCollapseAll />
          </button>
          <button
            className="icon-btn"
            title="Refresh"
            onClick={() => void refetchExpanded()}
          >
            <IcRefresh />
          </button>
        </div>
      </div>

      <div className="fx-tree" ref={treeRef} tabIndex={0} onKeyDown={onKeyDown}>
        <div
          className="fx-repo-row"
          onClick={() => setRootExpanded((v) => !v)}
        >
          <span className={`fx-chevron ${rootExpanded ? "open" : ""}`}>
            <IcChevronRight />
          </span>
          <span className="fx-repo-name truncate">{repoName}</span>
        </div>

        {rows.map((row) => {
          if (row.kind !== "entry") {
            return (
              <div key={row.key} className="fx-row fx-placeholder">
                {Array.from({ length: row.depth }, (_, i) => (
                  <span key={i} className="fx-indent" />
                ))}
                <span className="fx-chevron" />
                <span className="fx-placeholder-text">
                  ({row.kind === "error" ? "error" : "empty"})
                </span>
              </div>
            );
          }
          const e = row.entry!;
          const isOpen = e.isDir && expanded.has(e.path);
          const cls = [
            "fx-row",
            selected === e.path ? "selected" : "",
            e.name.startsWith(".") ? "dotfile" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={row.key}
              data-path={e.path}
              className={cls}
              onClick={() => onRowClick(e)}
            >
              {Array.from({ length: row.depth }, (_, i) => (
                <span key={i} className="fx-indent" />
              ))}
              <span className={`fx-chevron ${isOpen ? "open" : ""}`}>
                {e.isDir && <IcChevronRight />}
              </span>
              <span className={`fx-icon ${e.isDir ? "dir" : "file"}`}>
                {e.isDir ? <IcFolder /> : <IcFile />}
              </span>
              <span className="fx-name truncate">{e.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
