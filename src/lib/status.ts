/**
 * Shared helpers for git status codes — single source of truth for the
 * letter, color and path handling of a FileStatus across the UI.
 */
import type { CommitFile, FileStatus, StatusCode } from "./ipc";

/** Letter shown in the UI ('?' renders as 'U' for untracked, VSCode-style). */
export const statusLetter = (code: StatusCode): string =>
  code === "?" ? "U" : code;

/** Theme variable for a status code. */
export const statusColor = (code: StatusCode): string => {
  switch (code) {
    case "A":
      return "var(--git-added)";
    case "?":
      return "var(--git-untracked)";
    case "D":
      return "var(--git-deleted)";
    case "R":
    case "C":
      return "var(--git-renamed)";
    case "U":
      return "var(--git-conflict)";
    default:
      return "var(--git-modified)";
  }
};

/**
 * The path arguments a git mutation needs for this entry. Renames span two
 * paths — operating on just the new one half-applies the rename (e.g. discard
 * would delete the new file without restoring the old one).
 */
export const statusPaths = (file: FileStatus | CommitFile): string[] =>
  file.status === "R" && file.origPath ? [file.path, file.origPath] : [file.path];
