# Minimal IDE

A minimal, fast, memory-efficient IDE for macOS. Like VSCode without all the extra stuff:
**git source control + commit graph, integrated split terminals, and a proper diff viewer.**

Built with [Tauri 2](https://tauri.app) — native WKWebView, no bundled Chromium — so it stays
light on CPU and RAM.

## Features

- **Source control** — stage / unstage / discard, commit (+ amend, commit & push), stash
  (save / apply / pop / drop), fetch / pull / push using your existing git auth
- **Commit graph** — colored branch lanes, branch & tag pills, click a commit to see and
  diff its files; virtualized so huge histories stay smooth
- **Integrated terminal** — real PTYs running your login shell, tabs + side-by-side splits,
  WebGL-accelerated rendering (xterm.js)
- **Diff viewer** — side-by-side or unified, syntax-highlighted, unchanged regions collapsed;
  working-tree diffs are editable (⌘S saves)
- **Editor & explorer** — lazy file tree, CodeMirror 6 tabs with on-demand language loading
- **Live updates** — a debounced file watcher refreshes status/log/graph when anything
  changes on disk (including external `git` commands)

## Architecture

| Layer | Tech |
|---|---|
| Shell | Tauri 2 (Rust) |
| Git | `git2` (libgit2); network ops shell out to `git` CLI for your ssh/credential helpers |
| Terminals | `portable-pty` → base64 events → xterm.js 6 |
| Watcher | `notify` (FSEvents), debounced |
| UI | React 19 + Vite, zustand, CodeMirror 6, `@codemirror/merge` |

## Keyboard shortcuts

| Keys | Action |
|---|---|
| ⌘ ` | Toggle terminal panel |
| ⌘ B | Toggle sidebar |
| ⌘ W | Close tab |
| ⌘ S | Save file / working-tree diff edit |
| ⌘ ↩ | Commit (focus in message box) |

## Development

```sh
pnpm install
pnpm tauri dev      # run the app in dev mode
pnpm tauri build    # produce .app / .dmg in src-tauri/target/release/bundle
```

## Installing / updating the release build

There's no auto-updater — installing and updating are the same operation:
build, then copy the bundle into `/Applications`.

```sh
pnpm tauri build
rm -rf "/Applications/Minimal IDE.app" && ditto \
  "src-tauri/target/release/bundle/macos/Minimal IDE.app" \
  "/Applications/Minimal IDE.app"
```

Notes:

- **Quit the app first** when updating a running install.
- The `rm -rf` matters: `ditto` *merges* into an existing bundle, so copying
  over an old install can leave stale files behind if something was renamed
  or removed between builds. Deleting first guarantees a clean bundle.
- Settings survive updates — persisted state (workspaces, terminal layouts,
  project colors) lives in WebKit storage under `~/Library/` keyed by bundle
  id, not inside the .app. The dev build (`pnpm tauri dev`) keeps its own
  separate state.
- No Gatekeeper friction: locally built apps aren't quarantined (that only
  applies to downloads).
