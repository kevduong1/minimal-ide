/**
 * Commit graph list: colored rail lanes + dots on the left, then ref pills,
 * commit summary, author and relative time. Virtualized by hand (no deps):
 * a flat item array (commit / file / loadmore rows) rendered as an absolutely
 * positioned visible slice inside one scroll container.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRepo, useWorkspace } from "../stores/workspaces";
import { gitCommitFiles, type CommitFile, type RefLabel } from "../lib/ipc";
import { statusColor } from "../lib/status";
import { computeGraph, type GraphRow } from "../lib/graphLayout";
import { IcBranch, IcRemote, IcTag } from "./icons";
import "./GitGraph.css";

const ROW = 24;
const OVERSCAN = 10;
const LANE_W = 12;
const LANE_X0 = 7;
const MAX_PILLS = 2;

const laneColor = (c: number) => `var(--graph-${c % 8})`;

function relTime(timestamp: number): string {
  const s = Math.floor(Date.now() / 1000) - timestamp;
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

// shared static pill icon elements (one element per kind, reused across rows)
const PILL_ICON: Record<RefLabel["kind"], ReactNode> = {
  local: <IcBranch />,
  remote: <IcRemote />,
  tag: <IcTag />,
};

// ---------------------------------------------------------------------------
// Rail (the lane/dot SVG at the left of a commit row)
// ---------------------------------------------------------------------------

function Rail({ row }: { row: GraphRow }) {
  let maxLane = row.lane;
  for (const p of row.passLanes) if (p.lane > maxLane) maxLane = p.lane;
  for (const c of row.connectors) {
    if (c.fromLane > maxLane) maxLane = c.fromLane;
    if (c.toLane > maxLane) maxLane = c.toLane;
  }
  const width = (maxLane + 1) * LANE_W + 6;
  const x = (lane: number) => LANE_X0 + lane * LANE_W;
  const cx = x(row.lane);
  const color = laneColor(row.color);

  const els: ReactNode[] = [];
  row.passLanes.forEach((p, i) => {
    const px = x(p.lane);
    els.push(
      <line
        key={`p${i}`}
        x1={px}
        y1={0}
        x2={px}
        y2={ROW}
        stroke={laneColor(p.color)}
        strokeWidth={2}
      />,
    );
  });
  row.connectors.forEach((c, i) => {
    const xf = x(c.fromLane);
    const xt = x(c.toLane);
    let d: string;
    if (c.kind === "merge-in") {
      // from the top edge curving into the dot
      d = `M ${xf} 0 C ${xf} 7, ${xt} 5, ${xt} 12`;
    } else if (c.kind === "branch-out") {
      // from the dot curving out to a lane at the bottom edge
      d = `M ${xf} 12 C ${xf} 19, ${xt} 17, ${xt} ${ROW}`;
    } else {
      // shift: gentle diagonal, top -> bottom
      d = `M ${xf} 0 C ${xf} 9, ${xt} 15, ${xt} ${ROW}`;
    }
    els.push(
      <path
        key={`c${i}`}
        d={d}
        fill="none"
        stroke={laneColor(c.color)}
        strokeWidth={2}
      />,
    );
  });
  if (row.linkUp) {
    els.push(
      <line key="u" x1={cx} y1={0} x2={cx} y2={12} stroke={color} strokeWidth={2} />,
    );
  }
  if (row.linkDown) {
    els.push(
      <line key="d" x1={cx} y1={12} x2={cx} y2={ROW} stroke={color} strokeWidth={2} />,
    );
  }
  if (row.commit.isHead) {
    els.push(
      <circle
        key="ring"
        cx={cx}
        cy={12}
        r={4.5}
        fill="var(--bg-sidebar)"
        stroke={color}
        strokeWidth={2}
      />,
      <circle key="dot" cx={cx} cy={12} r={2} fill={color} />,
    );
  } else {
    els.push(<circle key="dot" cx={cx} cy={12} r={3.5} fill={color} />);
  }

  return (
    <svg className="gg-rail" width={width} height={ROW} viewBox={`0 0 ${width} ${ROW}`}>
      {els}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Ref pills
// ---------------------------------------------------------------------------

const KIND_ORDER: Record<RefLabel["kind"], number> = { local: 0, remote: 1, tag: 2 };

function RefPills({ refs, isHead }: { refs: RefLabel[]; isHead: boolean }) {
  if (refs.length === 0) return null;
  const sorted =
    refs.length > 1
      ? refs.slice().sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
      : refs;
  const shown = sorted.slice(0, MAX_PILLS);
  const extra = sorted.length - shown.length;
  // the first local pill on the HEAD commit gets the filled style
  const headIdx = isHead ? shown.findIndex((r) => r.kind === "local") : -1;
  return (
    <>
      {shown.map((r, i) => (
        <span
          key={`${r.kind}:${r.name}`}
          className={`gg-pill ${i === headIdx ? "head" : r.kind}`}
          title={r.name}
        >
          {PILL_ICON[r.kind]}
          <span className="truncate">{r.name}</span>
        </span>
      ))}
      {extra > 0 && <span className="gg-pill more">+{extra}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Rows (memoized: stable props -> zero re-renders while scrolling)
// ---------------------------------------------------------------------------

const CommitRow = memo(function CommitRow({
  row,
  top,
  expanded,
  onToggle,
}: {
  row: GraphRow;
  top: number;
  expanded: boolean;
  onToggle: (oid: string) => void;
}) {
  const c = row.commit;
  const title = `${c.oid}\n${c.author} <${c.email}>\n${new Date(
    c.timestamp * 1000,
  ).toISOString()}`;
  return (
    <div
      className={`gg-row${expanded ? " expanded" : ""}`}
      style={{ top }}
      title={title}
      onClick={() => onToggle(c.oid)}
    >
      <Rail row={row} />
      <RefPills refs={c.refs} isHead={c.isHead} />
      <span className="gg-summary truncate">{c.summary}</span>
      <span className="gg-author truncate">{c.author}</span>
      <span className="gg-time">{relTime(c.timestamp)}</span>
    </div>
  );
});

const FileRow = memo(function FileRow({
  file,
  oid,
  top,
  repoPath,
}: {
  /** null while the commit's file list is being fetched. */
  file: CommitFile | null;
  oid: string;
  top: number;
  repoPath: string;
}) {
  const ws = useWorkspace();
  if (!file) {
    return (
      <div className="gg-file loading" style={{ top }}>
        loading…
      </div>
    );
  }
  const open = () =>
    ws.editor.getState().openDiff({
      repoPath,
      path: file.path,
      kind: "commit",
      oid,
      status: file.status,
      origPath: file.origPath,
    });
  return (
    <div className="gg-file" style={{ top }} title={file.path} onClick={open}>
      <span className="gg-file-status" style={{ color: statusColor(file.status) }}>
        {file.status}
      </span>
      <span className="gg-file-path truncate">
        {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
      </span>
    </div>
  );
});

const LoadMoreRow = memo(function LoadMoreRow({
  top,
  onClick,
}: {
  top: number;
  onClick: () => void;
}) {
  return (
    <div className="gg-loadmore" style={{ top }} onClick={onClick}>
      Load more commits
    </div>
  );
});

// ---------------------------------------------------------------------------
// GitGraph
// ---------------------------------------------------------------------------

type Item =
  | { type: "commit"; row: GraphRow }
  | { type: "file"; oid: string; file: CommitFile | null }
  | { type: "error"; oid: string }
  | { type: "loadmore" };

export default function GitGraph() {
  const repoPath = useRepo((s) => s.repoPath);
  const commits = useRepo((s) => s.commits);
  const hasMoreLog = useRepo((s) => s.hasMoreLog);
  const loadMoreLog = useRepo((s) => s.loadMoreLog);

  const layout = useMemo(() => computeGraph(commits), [commits]);

  // single expanded commit + per-oid file cache ("error" = fetch failed)
  const [expandedOid, setExpandedOid] = useState<string | null>(null);
  const [fileCache, setFileCache] = useState<Map<string, CommitFile[] | "error">>(
    () => new Map(),
  );
  const inflight = useRef<Set<string>>(new Set());

  // virtualization state
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);

  // reset view state when switching repositories
  useEffect(() => {
    setExpandedOid(null);
    setFileCache(new Map());
    inflight.current.clear();
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [repoPath]);

  // fetch the expanded commit's files once, cache forever (per oid)
  useEffect(() => {
    if (!expandedOid || !repoPath) return;
    if (fileCache.has(expandedOid) || inflight.current.has(expandedOid)) return;
    inflight.current.add(expandedOid);
    gitCommitFiles(repoPath, expandedOid)
      .then((files) => {
        setFileCache((prev) => new Map(prev).set(expandedOid, files));
      })
      .catch(() => {
        setFileCache((prev) => new Map(prev).set(expandedOid, "error"));
      })
      .finally(() => {
        inflight.current.delete(expandedOid);
      });
  }, [expandedOid, repoPath, fileCache]);

  // observe viewport height (re-attach when leaving the empty state, since
  // the scroll element does not exist while "No commits yet" is shown)
  const empty = commits.length === 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    // quantize to row boundaries so scrolling within a row skips the
    // re-render entirely (overscan absorbs the sub-row error)
    const q = Math.floor(e.currentTarget.scrollTop / ROW) * ROW;
    setScrollTop((prev) => (prev === q ? prev : q));
  }, []);

  const toggleExpand = useCallback((oid: string) => {
    // drop a cached fetch failure so re-expanding retries
    setFileCache((prev) => {
      if (prev.get(oid) !== "error") return prev;
      const next = new Map(prev);
      next.delete(oid);
      return next;
    });
    setExpandedOid((prev) => (prev === oid ? null : oid));
  }, []);

  const handleLoadMore = useCallback(() => {
    void loadMoreLog();
  }, [loadMoreLog]);

  // flat item list: commit rows, file rows under the expanded commit, tail
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const row of layout) {
      out.push({ type: "commit", row });
      if (expandedOid === row.commit.oid) {
        const files = fileCache.get(expandedOid);
        if (files === undefined) {
          out.push({ type: "file", oid: expandedOid, file: null });
        } else if (files === "error") {
          out.push({ type: "error", oid: expandedOid });
        } else {
          for (const f of files) out.push({ type: "file", oid: expandedOid, file: f });
        }
      }
    }
    if (hasMoreLog) out.push({ type: "loadmore" });
    return out;
  }, [layout, expandedOid, fileCache, hasMoreLog]);

  if (empty) {
    return (
      <div className="git-graph">
        <div className="gg-empty">No commits yet</div>
      </div>
    );
  }

  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW) + OVERSCAN);
  const visible: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const it = items[i];
    const top = i * ROW;
    if (it.type === "commit") {
      visible.push(
        <CommitRow
          key={it.row.commit.oid}
          row={it.row}
          top={top}
          expanded={it.row.commit.oid === expandedOid}
          onToggle={toggleExpand}
        />,
      );
    } else if (it.type === "file") {
      visible.push(
        <FileRow
          key={it.file ? `${it.oid}:${it.file.path}` : `${it.oid}:loading`}
          file={it.file}
          oid={it.oid}
          top={top}
          repoPath={repoPath ?? ""}
        />,
      );
    } else if (it.type === "error") {
      visible.push(
        <div
          key={`${it.oid}:error`}
          className="gg-file loading"
          style={{ top, color: "var(--danger)" }}
        >
          Failed to load files
        </div>,
      );
    } else {
      visible.push(<LoadMoreRow key="loadmore" top={top} onClick={handleLoadMore} />);
    }
  }

  return (
    <div className="git-graph">
      <div className="gg-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="gg-spacer" style={{ height: items.length * ROW }}>
          {visible}
        </div>
      </div>
    </div>
  );
}
