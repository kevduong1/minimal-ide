/**
 * Typed IPC contract between the React frontend and the Rust (Tauri) backend.
 *
 * This file is the single source of truth for command names and payload
 * shapes. Rust structs use #[serde(rename_all = "camelCase")] so wire shapes
 * match these types exactly. Tauri converts snake_case Rust command args to
 * camelCase on the JS side (e.g. repo_path -> repoPath).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Git types
// ---------------------------------------------------------------------------

/** Single-letter status codes, VSCode-style. '?' = untracked. */
export type StatusCode = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";

export interface FileStatus {
  path: string;
  /** Previous path when status is R (rename) or C (copy). */
  origPath?: string | null;
  status: StatusCode;
}

export interface BranchInfo {
  /** Branch name, or short oid when detached. */
  name: string;
  detached: boolean;
  ahead: number;
  behind: number;
}

export interface StatusResult {
  branch: BranchInfo;
  staged: FileStatus[];
  /** Includes untracked files with status '?'. */
  unstaged: FileStatus[];
}

export interface RefLabel {
  /** Short name, e.g. "main", "origin/main", "v1.0.0". */
  name: string;
  kind: "local" | "remote" | "tag";
}

export interface CommitInfo {
  oid: string;
  /** First line of the commit message. */
  summary: string;
  author: string;
  email: string;
  /** Unix seconds. */
  timestamp: number;
  parents: string[];
  refs: RefLabel[];
  isHead: boolean;
}

export interface LogResult {
  commits: CommitInfo[];
  hasMore: boolean;
}

export interface CommitFile {
  path: string;
  origPath?: string | null;
  status: StatusCode;
}

export type DiffKind = "worktree" | "staged" | "commit";

export interface DiffPayload {
  oldText: string;
  newText: string;
  /** e.g. "HEAD", "Index", "abc1234", "Working Tree" */
  oldLabel: string;
  newLabel: string;
  binary: boolean;
}

export interface StashInfo {
  index: number;
  message: string;
  oid: string;
}

export interface GitOpResult {
  ok: boolean;
  /** Combined stdout/stderr of the underlying `git` CLI call. */
  output: string;
}

export interface RepoInfo {
  /** Absolute path of the repository workdir root. */
  root: string;
}

// ---------------------------------------------------------------------------
// FS types
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileContent {
  text: string;
  binary: boolean;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Git commands
// ---------------------------------------------------------------------------

/** Validate + open a repository (any path inside it works). */
export const gitOpen = (path: string): Promise<RepoInfo> =>
  invoke("git_open", { path });

export const gitStatus = (repoPath: string): Promise<StatusResult> =>
  invoke("git_status", { repoPath });

export const gitStage = (repoPath: string, paths: string[]): Promise<void> =>
  invoke("git_stage", { repoPath, paths });

export const gitUnstage = (repoPath: string, paths: string[]): Promise<void> =>
  invoke("git_unstage", { repoPath, paths });

/** Restore files to their HEAD/index state. Destructive; confirm in UI first. */
export const gitDiscard = (repoPath: string, paths: string[]): Promise<void> =>
  invoke("git_discard", { repoPath, paths });

/** Returns the new commit oid. */
export const gitCommit = (
  repoPath: string,
  message: string,
  amend: boolean,
): Promise<string> => invoke("git_commit", { repoPath, message, amend });

export const gitLog = (
  repoPath: string,
  limit: number,
  skip: number,
): Promise<LogResult> => invoke("git_log", { repoPath, limit, skip });

/** Files changed by a commit (vs its first parent). */
export const gitCommitFiles = (
  repoPath: string,
  oid: string,
): Promise<CommitFile[]> => invoke("git_commit_files", { repoPath, oid });

/**
 * Old/new file contents for a diff:
 *  - worktree: index (or HEAD if not in index) vs working tree
 *  - staged:   HEAD vs index
 *  - commit:   first parent of `oid` vs `oid` (oid required)
 * For renames pass `origPath` so the old side is read from the pre-rename
 * path instead of showing a whole-file add.
 */
export const gitDiffFile = (
  repoPath: string,
  path: string,
  kind: DiffKind,
  oid?: string,
  origPath?: string | null,
): Promise<DiffPayload> =>
  invoke("git_diff_file", {
    repoPath,
    path,
    kind,
    oid: oid ?? null,
    origPath: origPath ?? null,
  });

export const gitStashList = (repoPath: string): Promise<StashInfo[]> =>
  invoke("git_stash_list", { repoPath });

export const gitStashSave = (
  repoPath: string,
  message: string | null,
  includeUntracked: boolean,
): Promise<void> =>
  invoke("git_stash_save", { repoPath, message, includeUntracked });

/** Stash ops address by oid — indices shift when the list changes. */
export const gitStashApply = (repoPath: string, oid: string): Promise<void> =>
  invoke("git_stash_apply", { repoPath, oid });

export const gitStashPop = (repoPath: string, oid: string): Promise<void> =>
  invoke("git_stash_pop", { repoPath, oid });

export const gitStashDrop = (repoPath: string, oid: string): Promise<void> =>
  invoke("git_stash_drop", { repoPath, oid });

/** Network ops shell out to the `git` CLI so user auth (ssh/credhelper) works. */
export const gitFetch = (repoPath: string): Promise<GitOpResult> =>
  invoke("git_fetch", { repoPath });

export const gitPull = (repoPath: string): Promise<GitOpResult> =>
  invoke("git_pull", { repoPath });

export const gitPush = (repoPath: string): Promise<GitOpResult> =>
  invoke("git_push", { repoPath });

// ---------------------------------------------------------------------------
// FS commands
// ---------------------------------------------------------------------------

/** Lists a directory, dirs first then files, both alphabetical. `.git` is omitted. */
export const fsReadDir = (path: string): Promise<DirEntry[]> =>
  invoke("fs_read_dir", { path });

/** Reads a UTF-8 text file. Files > 5 MB are truncated; binaries flagged. */
export const fsReadFile = (path: string): Promise<FileContent> =>
  invoke("fs_read_file", { path });

export const fsWriteFile = (path: string, text: string): Promise<void> =>
  invoke("fs_write_file", { path, text });

// ---------------------------------------------------------------------------
// Repo watcher
// ---------------------------------------------------------------------------

export interface RepoChanged {
  repoPath: string;
  /**
   * True when git metadata (HEAD / index / refs) changed — commit log and
   * stashes may be stale, not just file contents / status.
   */
  gitChanged: boolean;
}

/**
 * Starts a debounced recursive watcher over the repo workdir (+ the real git
 * dir, including linked worktrees). Emits "repo-changed" with a RepoChanged
 * payload. Watching a new repo replaces the previous watch.
 */
export const watchRepo = (repoPath: string): Promise<void> =>
  invoke("watch_repo", { repoPath });

export const unwatchRepo = (): Promise<void> => invoke("unwatch_repo");

export const onRepoChanged = (
  cb: (change: RepoChanged) => void,
): Promise<UnlistenFn> =>
  listen<RepoChanged>("repo-changed", (e) => cb(e.payload));

// ---------------------------------------------------------------------------
// PTY commands
// ---------------------------------------------------------------------------

/**
 * Spawns the user's login shell ($SHELL -l, fallback /bin/zsh) in a new PTY.
 * The caller generates `id` (crypto.randomUUID()) and attaches the
 * `pty-data:<id>` / `pty-exit:<id>` listeners BEFORE calling this, so no
 * early output is lost. Output events carry a base64 payload; exit carries
 * the exit code.
 */
export const ptySpawn = (
  id: string,
  cwd: string,
  cols: number,
  rows: number,
): Promise<void> => invoke("pty_spawn", { id, cwd, cols, rows });

/** Write user input (UTF-8 string from xterm onData). */
export const ptyWrite = (id: string, data: string): Promise<void> =>
  invoke("pty_write", { id, data });

export const ptyResize = (
  id: string,
  cols: number,
  rows: number,
): Promise<void> => invoke("pty_resize", { id, cols, rows });

export const ptyKill = (id: string): Promise<void> => invoke("pty_kill", { id });

/** Decoded PTY output bytes — feed directly to xterm.write(). */
export const onPtyData = (
  id: string,
  cb: (data: Uint8Array) => void,
): Promise<UnlistenFn> =>
  listen<string>(`pty-data:${id}`, (e) => cb(base64ToBytes(e.payload)));

export const onPtyExit = (
  id: string,
  cb: (code: number | null) => void,
): Promise<UnlistenFn> =>
  listen<number | null>(`pty-exit:${id}`, (e) => cb(e.payload));

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
