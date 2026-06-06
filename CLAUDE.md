# CLAUDE.md

Minimal IDE — a Tauri 2 macOS desktop app: multi-repo workspaces (titlebar tab
switcher), git source control (status, staging, commit/amend/push, stashes,
commit graph), integrated split terminals (portable-pty + xterm.js), a global
drag-and-drop agent-terminal dock, and a CodeMirror 6 diff viewer/editor.
Rust backend in `src-tauri/`, React 19 + TypeScript frontend in `src/` (Vite,
zustand). No tests; correctness relies on typecheck + manual verification.

## Architecture map

| File | Responsibility |
|---|---|
| `src/lib/ipc.ts` | Typed IPC contract — single source of truth for command names and payload shapes |
| `src/lib/status.ts` | Shared status-code helpers: `statusLetter`, `statusColor`, `statusPaths` (renames span two paths!) |
| `src/lib/path.ts` | Shared POSIX-path helpers (`basename`, `dirname`) — import these, don't redefine per file |
| `src/lib/fuzzy.ts` | Hand-rolled two-phase fuzzy matcher for quick open: O(n) subsequence reject over the whole list, then a scoring DP (boundary/camelCase/basename/consecutive bonuses) returning matched positions for highlighting |
| `src/lib/graphLayout.ts` | Pure lane-layout algorithm for the commit graph (algorithm documented in-file) |
| `src/lib/terminalActivity.ts` | Per-pane busy/attention heuristics for **agent** terminals only (echo-suppressed output → busy; BEL/OSC 9/777 + quiet-while-away → attention; OSC 133/633 marks take over when present) |
| `src/lib/termSession.ts` | Framework-free xterm+PTY session (attach/detach reparenting; ONLY `dispose()` kills the PTY); also hosts `XTERM_THEME` |
| `src/lib/termSessions.ts` | Session registry for ALL dock terminals (`getOrCreateSession`/`getSession`/`disposeSession`) — sessions outlive React unmounts |
| `src/lib/agentSessions.ts` | Agent glue on the registry: masquerade+tracker session options, `closeAgentTerminal`, `openAgentTerminal` |
| `src/lib/workspaceSessions.ts` | Workspace glue on the registry (counterpart of agentSessions): `getOrCreateWorkspaceSession`, `closeWorkspaceTerminal` |
| `src/lib/tasks.ts` | VS Code-compatible `.vscode/tasks.json` model: JSONC parse, `${var}` substitution, shell command-line assembly (shell/process types; `osx` override always merged; re-read on every use, no watcher) |
| `src/lib/taskRunner.ts` | Task execution glue: types the assembled command into a workspace dock terminal (reused per `presentation.panel` shared/dedicated/new; ^C first on reuse), reveals per `presentation.reveal` |
| `src/lib/dockTree.ts` | Pure dock layout-tree model shared by both docks: split/group types, `normalize()` invariants, move/split/resize state ops, persistence sanitizer |
| `src/lib/projectColors.ts` | Per-project palette-index assignment (auto on first ask; user-set via `setProjectColorIndex`, localStorage-persisted) — render through the reactive `useProjectColorIndex`/`useProjectColorVar` hooks; feeds tab/badge tints and the app-wide `--accent` override |
| `src/stores/workspaces.ts` | Workspace registry: one workspace per open repo (own repo/editor/terminal/search stores), open/close/setActive, session restore, `switchToProject` (agent-terminal navigation), `WorkspaceContext` + `useWorkspace`/`useRepo`/`useEditor`/`useTerminal`/`useSearch` hooks |
| `src/stores/repo.ts` | Per-workspace repo store factory: status/log/stashes, git mutations (return `Promise<boolean>`), log branch filter (`logFilter`/`setLogFilter`), watcher wiring (`init`/`dispose`), status-bar `error` |
| `src/stores/editor.ts` | Per-workspace editor-tab store factory (`Tab = file \| diff`), dirty tracking, `closeTabSafely(store, id)` (confirms unsaved), `openFile(path, at?)` + nonce-gated `reveal` request (cursor-to-line, consumed by Editor.tsx) |
| `src/stores/search.ts` | Per-workspace search store factory (⌘⇧F state: query/toggles/results); 250 ms debounce + sequence-number stale-result guard live in the store closure |
| `src/stores/terminal.ts` | Per-workspace terminal dock store factory (plain shells, dockTree layout, NOT persisted; never touches xterm or IPC); also exports the shared `PaneActivity`/`aggregateActivity` activity types |
| `src/stores/agentTerminals.ts` | GLOBAL agent-terminal dock store: dockTree layout, terminal↔project bindings, deduped default titles, localStorage persistence (`minimal-ide:agent-terminals`) |
| `src/stores/ui.ts` | Global (workspace-independent) sidebar/panel visibility, sizes, panel group (`terminal`/`agent`, `useEffectivePanelGroup`), panel maximize (`panelMaximized` — cleared by hiding the panel or opening an editor tab) |
| `src/App.tsx` | Shell layout, per-workspace `WorkspaceView`s (all mounted; inactive hidden), global shortcuts (⌘\` ⌘B ⌘⇧B ⌘P ⌘⇧F ⌘W ⌘1–9), welcome screen |
| `src/components/Titlebar.tsx` | Workspace tab strip (switch/close/add; right-click → project color picker) + active repo's branch pill and fetch |
| `src/components/icons.tsx` | ALL shared SVG icons (16×16 stroke glyphs) — add new icons here, not inline |
| `src/components/SourceControl.tsx` | SCM panel: stage/unstage/discard, commit (+amend, &push), stashes, commit-graph branch filter dropdown |
| `src/components/GitGraph.tsx` | Hand-rolled virtualized commit list + SVG lane rail (no virtualization deps); ⌘/shift multi-select + right-click menu (checkout, create branch, squash, copy SHA) |
| `src/components/Editor.tsx` | CodeMirror file editor + shared CM helpers (theme, languageFor, editKeymap) + unsaved-draft cache + external-change reload |
| `src/components/EditorSearch.tsx` | VS Code-style floating find/replace widget (⌘F, top-right overlay) replacing @codemirror/search's default panel; per-EditorView React root via custom `createPanel`; match counting goes through an escaped-regex twin of literal queries (RegExpCursor ≫ string cursor on big docs); shared by Editor + DiffViewer |
| `src/components/DiffViewer.tsx` | @codemirror/merge split/unified diff; worktree diffs editable (⌘S), auto-refetch on repo change |
| `src/components/Panel.tsx` | Global bottom panel (under the editor column): group tabs (Agent Terminals / Terminal) + per-group actions in one header row; per-workspace terminal docks (all mounted, display:none) + agent dock mounted once; maximize toggle (button or header double-click) fills the center column |
| `src/components/Dock.tsx` | Generic dockable terminal grid shared by both groups: recursive split/group rendering, per-group tab strips, double-click tab rename, pointer-capture DnD (strip insert caret / 5-zone edge splits), split resizers — flavor injected via `Pane`/`TabIcon`/`TabBadge`/`Empty` props |
| `src/components/TerminalPanel.tsx` | Workspace flavor of Dock: plain registry sessions at the workspace root, auto-first-terminal (session/close glue lives in `lib/workspaceSessions.ts`) |
| `src/components/TaskPicker.tsx` | ⌘⇧B quick-pick overlay (filter + arrow/enter keyboard nav); a lone default build task skips it (App.tsx) |
| `src/components/QuickOpen.tsx` | ⌘P fuzzy file picker overlay (TaskPicker pattern); fetches the gitignore-aware file list per open, renders top 100 with match highlighting |
| `src/components/SearchPanel.tsx` | ⌘⇧F sidebar search view: query + case/word/regex toggles, per-file collapsible result groups, click opens the file at the match line (`openFile(path, at)`) |
| `src/components/AgentDock.tsx` | Agent flavor of Dock: masquerade/tracked sessions, project badge overlay (rename shares the tab's title), active-project highlight ring, click-to-switch project, disconnected ⊘ |
| `src/components/Resizer.tsx` | Generic drag-to-resize handle (sidebar, panel, dock splits) |
| `src/components/ContextMenu.tsx` | Shared fixed-position context menu (viewport clamp, backdrop/Escape close) — GitGraph commit actions, Titlebar color picker |
| `src/components/FileExplorer.tsx` | Lazy directory tree (per-dir cache + expanded set) |
| `src-tauri/src/git.rs` | All git2 commands; fetch/pull/push/checkout/branch/squash-rebase shell out to `git` CLI so user auth + safety checks work |
| `src-tauri/src/pty.rs` | PTY sessions keyed by frontend UUID; output streamed as base64 `pty-data:<id>` events with ack-based flow control (`pty_ack`, reader parks above 1 MiB unacked); kill = SIGHUP → 500 ms → SIGKILL process group |
| `src-tauri/src/watcher.rs` | Debounced repo watchers (one per open repo, keyed by root) → `repo-changed` event `{repoPath, gitChanged}` |
| `src-tauri/src/fsops.rs` | fs_read_dir / fs_read_file (5 MB cap, NUL + UTF-8 binary sniff) / atomic fs_write_file |
| `src-tauri/src/search.rs` | `ignore`-crate worktree walks: list_workspace_files (quick open, 50k cap) + search_workspace (parallel walk, fsops's binary/size skip rules, 2000-match cap, UTF-16 offsets for JS/CodeMirror) |

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
  in `lib/termSession.ts` (XTERM_THEME) and `Editor.tsx` (editorTheme).
- The accent family (`--accent-hover/-muted`, `--button-bg/-hover`,
  `--bg-selected`, `--focus-ring`) is DERIVED from `--accent` via color-mix —
  App.tsx recolors the whole app per active project by overriding only
  `--accent` (from the `--project-N` palette via `lib/projectColors.ts`).
  GOTCHA: a custom property substitutes `var()` where it is DEFINED, so the
  derived family lives on `:root, .app, .accent-scope` (theme.css) — any new
  scope that changes `--accent` must carry `.accent-scope` or the family
  stays stale. Opt a subtree out of project coloring by re-pinning
  `--accent: var(--accent-default)` + `.accent-scope` (pattern: `.git-graph`).
  Never reintroduce literal accent-family values.
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

- React StrictMode double-mounts effects in dev. PTY spawn/kill is guarded by
  a `disposed` flag + spawn-promise-sequenced kill (`lib/termSession.ts`),
  and the session registry's get-or-create is synchronous check-then-set;
  each repo store guards races with a per-store `disposed` flag;
  `openWorkspace` dedupes by root with no await between check and set. Keep
  this discipline for any new effectful mount.
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
- Inactive dock tabs/groups stay mounted with `display:none` so xterm
  buffers survive — visibility is always `display:none`, never unmounting
  (and with registry sessions, even an unmount only detaches). On reveal,
  the session's ResizeObserver refits + `term.refresh()`es IMMEDIATELY (no
  debounce) — xterm's renderer is paused while hidden and the WebGL canvas
  can come back blank, so a debounced refit reads as flicker.
- Terminals come in two homes: workspace panes (plain — no activity tracker,
  no OSC handlers, no timers) and the global **agent dock** (sparkle button
  in the panel header). Only agent sessions run `trackActivity` and only
  their PTYs set `TERM_PROGRAM=ghostty` — the masquerade exists because
  agent CLIs (Claude Code) only emit OSC 9/777 notification sequences for a
  recognized terminal, which `terminalActivity.ts` turns into
  needs-attention indicators (dock tab, titlebar workspace tab, status-bar
  dot) — don't "fix" it away for agent sessions. Known cost:
  TERM_PROGRAM-sniffing image CLIs (chafa, yazi) may emit Kitty graphics
  that xterm.js silently drops (the reason plain panes don't masquerade;
  they scrub TERM_PROGRAM).
- ALL dock terminals (both groups) decouple PTY lifetime from React via the
  session registry: host unmount = `detach()` ONLY (drag-and-drop and split
  rewraps remount bystander panes); the PTY dies exclusively via
  `disposeSession()` — reached through `closeAgentTerminal()`,
  `closeWorkspaceTerminal()`, or `closeWorkspace` (which disposes that
  workspace's sessions explicitly, since unmounting no longer kills
  anything). Never call `dispose()` from an effect cleanup, and never call a
  dock store's `closeTerminal` directly from UI (it would leak the shell).
  Agent terminals belong to a `workspacePath`, not a workspace: they keep
  running when their project closes ("disconnected" ⊘ badge; clicking
  reopens the project) and their layout persists across restarts (shells
  respawn lazily on first attach).
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
