# CLAUDE.md

Minimal IDE — a Tauri 2 macOS desktop app: multi-repo workspaces (titlebar tab
switcher), git source control (status, staging, commit/amend/push, stashes,
commit graph), integrated split terminals (portable-pty + xterm.js), and a
CodeMirror 6 diff viewer/editor.
Rust backend in `src-tauri/`, React 19 + TypeScript frontend in `src/` (Vite,
zustand). No tests; correctness relies on typecheck + manual verification.

## Architecture map

| File | Responsibility |
|---|---|
| `src/lib/ipc.ts` | Typed IPC contract — single source of truth for command names and payload shapes |
| `src/lib/status.ts` | Shared status-code helpers: `statusLetter`, `statusColor`, `statusPaths` (renames span two paths!) |
| `src/lib/graphLayout.ts` | Pure lane-layout algorithm for the commit graph (algorithm documented in-file) |
| `src/lib/terminalActivity.ts` | Per-pane busy/attention heuristics for **agent** terminals only (echo-suppressed output → busy; BEL/OSC 9/777 + quiet-while-away → attention; OSC 133/633 marks take over when present) |
| `src/stores/workspaces.ts` | Workspace registry: one workspace per open repo (own repo/editor/terminal stores), open/close/setActive, session restore, `WorkspaceContext` + `useWorkspace`/`useRepo`/`useEditor`/`useTerminal` hooks |
| `src/stores/repo.ts` | Per-workspace repo store factory: status/log/stashes, git mutations (return `Promise<boolean>`), log branch filter (`logFilter`/`setLogFilter`), watcher wiring (`init`/`dispose`), status-bar `error` |
| `src/stores/editor.ts` | Per-workspace editor-tab store factory (`Tab = file \| diff`), dirty tracking, `closeTabSafely(store, id)` (confirms unsaved) |
| `src/stores/terminal.ts` | Per-workspace terminal tab/pane UI-state factory ONLY (tab `kind`: `plain`/`agent`, `paneActivity` + `aggregateActivity`); never touches xterm or IPC |
| `src/stores/ui.ts` | Global (workspace-independent) sidebar/terminal visibility and sizes |
| `src/App.tsx` | Shell layout, per-workspace `WorkspaceView`s (all mounted; inactive hidden), global shortcuts (⌘\` ⌘B ⌘W ⌘1–9), welcome screen, drag resizers |
| `src/components/Titlebar.tsx` | Workspace tab strip (switch/close/add) + active repo's branch pill and fetch |
| `src/components/icons.tsx` | ALL shared SVG icons (16×16 stroke glyphs) — add new icons here, not inline |
| `src/components/SourceControl.tsx` | SCM panel: stage/unstage/discard, commit (+amend, &push), stashes, commit-graph branch filter dropdown |
| `src/components/GitGraph.tsx` | Hand-rolled virtualized commit list + SVG lane rail (no virtualization deps); ⌘/shift multi-select + right-click menu (checkout, create branch, squash, copy SHA) |
| `src/components/Editor.tsx` | CodeMirror file editor + shared CM helpers (theme, languageFor, editKeymap) + unsaved-draft cache + external-change reload |
| `src/components/DiffViewer.tsx` | @codemirror/merge split/unified diff; worktree diffs editable (⌘S), auto-refetch on repo change |
| `src/components/TerminalPanel.tsx` | xterm + PTY lifecycle per pane (`XtermPane` one-shot effect) |
| `src/components/FileExplorer.tsx` | Lazy directory tree (per-dir cache + expanded set) |
| `src-tauri/src/git.rs` | All git2 commands; fetch/pull/push/checkout/branch/squash-rebase shell out to `git` CLI so user auth + safety checks work |
| `src-tauri/src/pty.rs` | PTY sessions keyed by frontend UUID; output streamed as base64 `pty-data:<id>` events with ack-based flow control (`pty_ack`, reader parks above 1 MiB unacked); kill = SIGHUP → 500 ms → SIGKILL process group |
| `src-tauri/src/watcher.rs` | Debounced repo watchers (one per open repo, keyed by root) → `repo-changed` event `{repoPath, gitChanged}` |
| `src-tauri/src/fsops.rs` | fs_read_dir / fs_read_file (5 MB cap, NUL + UTF-8 binary sniff) / atomic fs_write_file |

## IPC contract rule

`src/lib/ipc.ts` is the single source of truth. Every Rust payload struct uses
`#[serde(rename_all = "camelCase")]` so wire shapes match the TS types exactly;
Tauri converts snake_case command args (`repo_path`) to camelCase (`repoPath`).
Adding a command = implement in the right `src-tauri/src/*.rs` module, register
in `main.rs` `generate_handler!`, add the typed wrapper in `ipc.ts`. Components
never call `invoke()` directly — always go through ipc.ts.

Backend rules: every command body runs inside `blocking(...)` (the
`spawn_blocking` helper in git.rs / per-module equivalents) so sync libgit2,
fs, or CLI work never stalls the async runtime that also serves terminal IPC.
Stash operations address stashes by **oid**, never index (indices shift).
Paths handed to libgit2 pathspec APIs must be escaped (`escape_pathspec`) or
use `disable_pathspec_match` — brackets/globs in filenames are otherwise
interpreted as patterns (real-world case: Next.js `app/[slug]/page.tsx`).

## Dev commands

```sh
pnpm install
pnpm tauri dev                  # run the app (starts vite via beforeDevCommand)
pnpm tauri build                # .app/.dmg in src-tauri/target/release/bundle
npx tsc --noEmit                # frontend typecheck only
cd src-tauri && cargo check     # backend typecheck
```

## Conventions

- All colors/fonts/metrics come from CSS variables in `src/styles/theme.css`;
  never hardcode colors in component CSS. Sanctioned exceptions: the JS themes
  in `TerminalPanel.tsx` (XTERM_THEME) and `Editor.tsx` (editorTheme).
- Icons live in `src/components/icons.tsx` (16×16, stroke currentColor,
  round caps) — no icon library, no new inline SVGs in components.
- Status letters/colors/paths come from `src/lib/status.ts`. `statusPaths` is
  mandatory for any git mutation on a file entry — renamed files need both the
  new and old path or the operation half-applies.
- zustand: subscribe with narrow selectors (`useShallow` for multi-field picks);
  whole-store destructuring re-renders on every state change. Inside a
  workspace tree, use the context hooks (`useRepo`/`useEditor`/`useTerminal`),
  NOT a global store; event handlers read fresh state via
  `useWorkspace().repo.getState()` etc. Global chrome (titlebar/status bar)
  follows `useActiveWorkspace()`. Repo mutations return booleans — branch on
  them, never probe `getState().error` for success.
- Tauri `listen()` resolves AFTER mount: track a `disposed` flag and call the
  unlisten fn in effect cleanup (pattern: `XtermPane`, `FileExplorer`).
- Errors: git mutations → repo store `error` (status bar, click to dismiss);
  save failures → inline banner; confirmations/open-repo failures →
  `@tauri-apps/plugin-dialog` `confirm()`/`message()`.

## Gotchas

- React StrictMode double-mounts effects in dev. PTY spawn/kill is guarded by a
  `disposed` flag + spawn-promise-sequenced kill (`XtermPane`); each repo store
  guards races with a per-store `disposed` flag; `openWorkspace` dedupes by
  root with no await between check and set. Keep this discipline for any new
  effectful mount.
- ALL workspace trees stay mounted; the inactive ones are hidden with
  `display:none` (same rule as terminal tabs) so shells, editor buffers, and
  explorer state survive switching — never key a workspace's subtree on the
  active path.
- `repo-changed` events are emitted for EVERY watched repo: each `listen`er
  must filter by `payload.repoPath` (repo store, `FileExplorer`, `Editor`,
  `DiffViewer`) or it will react to other workspaces' changes.
- WKWebView: `window.alert/confirm/prompt` are NO-OPS — always use
  `@tauri-apps/plugin-dialog`. Vite build target is `safari16`; avoid newer
  JS/CSS features than that.
- Watcher debounce layering (rationale documented in `watcher.rs`): Rust waits
  for a 250 ms quiet period (max 1 s), `repo.ts` adds 150 ms coalescing +
  skips watcher echoes within 400 ms of an explicit mutation refresh,
  `FileExplorer` debounces its own re-reads 300 ms. The event payload's
  `gitChanged` flag decides between a cheap status-only refresh (plain file
  edits) and a full status+log+stash refresh (HEAD/index/refs changed).
- Inactive terminal tabs stay mounted with `display:none` so shells keep
  running and xterm buffers survive — never unmount `XtermPane` to hide it.
  On reveal, `XtermPane`'s ResizeObserver refits + `term.refresh()`es
  IMMEDIATELY (no debounce) — xterm's renderer is paused while hidden and the
  WebGL canvas can come back blank, so a debounced refit reads as flicker.
- Terminal tabs come in two kinds: plain (default — no activity tracker, no
  OSC handlers, no timers) and **agent** (sparkle button). Only agent panes
  run `trackActivity` and only their PTYs set `TERM_PROGRAM=ghostty` — the
  masquerade exists because agent CLIs (Claude Code) only emit OSC 9/777
  notification sequences for a recognized terminal, which
  `terminalActivity.ts` turns into needs-attention tab indicators — don't
  "fix" it away for agent panes. Known cost: TERM_PROGRAM-sniffing image
  CLIs (chafa, yazi) may emit Kitty graphics that xterm.js silently drops
  (the reason plain panes don't masquerade; they scrub TERM_PROGRAM).
- NEVER `fit.fit()` a hidden (display:none) xterm host: xterm 6 measures
  glyphs via OffscreenCanvas even unrendered, so FitAddon doesn't bail — it
  resizes the terminal+PTY to a bogus ~10×5 grid. Guard every fit path with
  `host.offsetParent !== null` (mount fit, debounced fit, reveal fit).
- `fs_read_file` truncates files >5 MB (editor becomes read-only); binary =
  NUL in the first 8 KB **or invalid UTF-8** (we refuse to lossy-decode: a
  lossy round-trip through the editor would corrupt the file on save).
  `fs_write_file` is atomic (temp file + rename) and writes through symlinks.
- The editor and worktree/staged diffs reload on external changes (terminal
  git commands, formatters) and guard ⌘S with a disk-conflict check — don't
  bypass `Editor.tsx`'s save path with direct `fsWriteFile` calls.
