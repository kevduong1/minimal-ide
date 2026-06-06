import { create } from "zustand";
import {
  gitCommit,
  gitDiscard,
  gitFetch,
  gitLog,
  gitOpen,
  gitPull,
  gitPush,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashSave,
  gitStatus,
  gitUnstage,
  onRepoChanged,
  unwatchRepo,
  watchRepo,
  type CommitInfo,
  type StatusResult,
  type StashInfo,
} from "../lib/ipc";

const LOG_PAGE = 200;
const RECENT_KEY = "minimal-ide:recent-repos";

/** Watcher echoes arriving this soon after an explicit refresh are skipped. */
const POST_MUTATION_QUIET_MS = 400;

export const getRecentRepos = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
};

const pushRecentRepo = (path: string) => {
  const list = [path, ...getRecentRepos().filter((p) => p !== path)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
};

interface RepoState {
  /** Workdir root of the open repository; null until a repo is opened. */
  repoPath: string | null;
  repoName: string;
  status: StatusResult | null;
  commits: CommitInfo[];
  hasMoreLog: boolean;
  stashes: StashInfo[];
  /** True while a network op (fetch/pull/push) is in flight. */
  syncing: boolean;
  /** Transient error string surfaced in the status bar; auto-clearable. */
  error: string | null;

  openRepo: (path: string) => Promise<void>;
  /** Refresh status (+ log/stashes unless `statusOnly`). */
  refresh: (opts?: { statusOnly?: boolean }) => Promise<void>;
  loadMoreLog: () => Promise<void>;

  /** Mutations return true on success (errors land in `error`). */
  stage: (paths: string[]) => Promise<boolean>;
  unstage: (paths: string[]) => Promise<boolean>;
  discard: (paths: string[]) => Promise<boolean>;
  commit: (message: string, amend?: boolean) => Promise<boolean>;

  stashSave: (
    message: string | null,
    includeUntracked: boolean,
  ) => Promise<boolean>;
  /** Stash ops address by oid — indices shift when the list changes. */
  stashApply: (oid: string) => Promise<boolean>;
  stashPop: (oid: string) => Promise<boolean>;
  stashDrop: (oid: string) => Promise<boolean>;

  fetch: () => Promise<boolean>;
  pull: () => Promise<boolean>;
  push: () => Promise<boolean>;

  clearError: () => void;
}

let unlistenRepoChanged: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Generation counter: bumped on every openRepo. Async results (refresh,
 * loadMore, watcher events) carry the generation they started under and are
 * dropped if a different repo has been opened since.
 */
let generation = 0;

/** Timestamp of the last explicit (mutation-driven) refresh. */
let lastExplicitRefresh = 0;

export const useRepoStore = create<RepoState>((set, get) => {
  /** Wraps a git mutation: runs it, surfaces errors, refreshes state. */
  const mutate = async (fn: () => Promise<unknown>): Promise<boolean> => {
    let ok = true;
    try {
      await fn();
      set({ error: null });
    } catch (e) {
      set({ error: String(e) });
      ok = false;
    }
    lastExplicitRefresh = Date.now();
    await get().refresh();
    return ok;
  };

  const netOp = async (fn: () => Promise<{ ok: boolean; output: string }>) => {
    set({ syncing: true });
    const ok = await mutate(async () => {
      const r = await fn();
      if (!r.ok) throw r.output;
    });
    set({ syncing: false });
    return ok;
  };

  return {
    repoPath: null,
    repoName: "",
    status: null,
    commits: [],
    hasMoreLog: false,
    stashes: [],
    syncing: false,
    error: null,

    openRepo: async (path) => {
      const info = await gitOpen(path); // throws if not a repo
      const root = info.root;
      const gen = ++generation;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      set({
        repoPath: root,
        repoName: root.split("/").filter(Boolean).pop() ?? root,
        commits: [],
        hasMoreLog: false,
        status: null,
        stashes: [],
        error: null,
      });
      pushRecentRepo(root);

      // (Re)wire the change watcher. The generation check makes concurrent
      // openRepo calls (StrictMode dev double-mount) converge on one listener.
      const unlisten = await onRepoChanged((change) => {
        if (gen !== generation) return;
        if (Date.now() - lastExplicitRefresh < POST_MUTATION_QUIET_MS) return;
        // Coalesce with any pending refresh; plain file edits skip the
        // log/stash round trip (statusOnly).
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(
          () => void get().refresh({ statusOnly: !change.gitChanged }),
          150,
        );
      });
      if (gen !== generation) {
        unlisten();
        return;
      }
      unlistenRepoChanged?.();
      unlistenRepoChanged = unlisten;

      await unwatchRepo().catch(() => {});
      await watchRepo(root).catch(() => {});
      await get().refresh();
    },

    refresh: async (opts) => {
      const { repoPath, commits } = get();
      if (!repoPath) return;
      const gen = generation;
      try {
        if (opts?.statusOnly) {
          const status = await gitStatus(repoPath);
          if (gen === generation) set({ status });
          return;
        }
        // keep however many commits the user has paged in (min one page)
        const limit = Math.max(commits.length, LOG_PAGE);
        const [status, log, stashes] = await Promise.all([
          gitStatus(repoPath),
          gitLog(repoPath, limit, 0),
          gitStashList(repoPath),
        ]);
        if (gen !== generation) return; // a different repo was opened
        set({ status, commits: log.commits, hasMoreLog: log.hasMore, stashes });
      } catch (e) {
        if (gen === generation) set({ error: String(e) });
      }
    },

    loadMoreLog: async () => {
      const { repoPath, commits, hasMoreLog } = get();
      if (!repoPath || !hasMoreLog) return;
      const gen = generation;
      const baseline = commits;
      try {
        const log = await gitLog(repoPath, LOG_PAGE, commits.length);
        // Drop the result if the repo changed or a concurrent refresh
        // replaced the list we were appending to (avoids duplicates).
        if (gen !== generation || get().commits !== baseline) return;
        set({ commits: [...baseline, ...log.commits], hasMoreLog: log.hasMore });
      } catch (e) {
        if (gen === generation) set({ error: String(e) });
      }
    },

    stage: (paths) => mutate(() => gitStage(get().repoPath!, paths)),
    unstage: (paths) => mutate(() => gitUnstage(get().repoPath!, paths)),
    discard: (paths) => mutate(() => gitDiscard(get().repoPath!, paths)),
    commit: (message, amend = false) =>
      mutate(() => gitCommit(get().repoPath!, message, amend)),

    stashSave: (message, includeUntracked) =>
      mutate(() => gitStashSave(get().repoPath!, message, includeUntracked)),
    stashApply: (oid) => mutate(() => gitStashApply(get().repoPath!, oid)),
    stashPop: (oid) => mutate(() => gitStashPop(get().repoPath!, oid)),
    stashDrop: (oid) => mutate(() => gitStashDrop(get().repoPath!, oid)),

    fetch: () => netOp(() => gitFetch(get().repoPath!)),
    pull: () => netOp(() => gitPull(get().repoPath!)),
    push: () => netOp(() => gitPush(get().repoPath!)),

    clearError: () => set({ error: null }),
  };
});
