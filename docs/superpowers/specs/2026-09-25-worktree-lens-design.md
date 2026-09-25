# Worktree Lens — Design

Date: 2026-09-25
Status: Approved design, pending spec review

## 1. Purpose

A VS Code extension that puts every Git worktree action one click away in a
dedicated tree view inside the Source Control sidebar, with at-a-glance status
per worktree.

VS Code 1.127's built-in Git extension already creates, deletes, and opens
worktrees. This extension deliberately overlaps with those features: the goal is
**one place for everything**, not filling a missing capability. It is a personal
tool, installed locally from a `.vsix`.

Coding agents create worktrees inside the repo (`.claude/worktrees`,
`.codex/worktrees`, …). The view keeps those apart from the user's own
worktrees and surfaces folders an agent left behind unregistered.

### Success criteria

- Every worktree of every open repo is visible in one view, grouped by repo.
- Each worktree shows: current (`@`), staged changes (`+`), commits ahead of
  main (`↑N`), unpushed commits (`⇡`).
- Add, open, open in new window, remove, and refresh are each reachable from the
  view with one click (plus prompts).
- Worktrees in the agent source folders (§5.4) are grouped by folder (or tagged,
  in flat mode), and unregistered folders there are visible and removable.
- Status stays current without polling.

## 2. Decisions

| Topic | Decision |
|---|---|
| Repos | Multi-root: one root node per repo, worktrees nested beneath. |
| Data source | Git CLI via `execFile` for all worktree data and mutations. |
| Built-in Git API | Used only for: repo list, change events, `git` binary path. |
| Refresh | Debounced on built-in Git change events + source-folder watchers + after add/remove + refresh button. No polling. |
| Default add path | Setting `worktreeLens.pathTemplate`, default `../${repo}.worktrees/${branch}`. |
| Source folders | Fixed list: `.claude/worktrees`, `.codex/worktrees`, `.github/worktrees`, `.agents/worktrees`, `.worktrees`, relative to the main worktree. |
| Grouping | Setting `worktreeLens.groupBySource` (default `true`), toggled from the view title. Grouped: one collapsed group per source folder. Flat: source tag in the description. |
| Unregistered folders | Shown under their source (group or tag); remove moves them to the trash, never a permanent delete. |
| New branch base | `main`, else `master`, else `HEAD`. |
| Rendering | Single pass: a repo's children are returned after all their statuses resolve. |
| Colors | Carried by the node icon; description symbols are plain text (tree API limit). |
| Build | Plain `tsc`, no bundler. Packaged with `npx @vscode/vsce package`. |
| Tests | `node --test` against a real temp repo for `git.ts`; manual checklist for UI. |

### Deviations from the original product spec

1. No `activationEvents` — generated from `contributes` since VS Code 1.74.
2. No `viewsContainers` — contributing to `views.scm` places the view in the
   Source Control sidebar.
3. `execFile` instead of `exec` — branch names and paths are argv entries, never
   shell-interpolated.
4. IDs namespaced `worktreeLens.*` instead of `worktree.*`.
5. `extensionDependencies: ["vscode.git"]` added.
6. Per-symbol colors in the description are not possible; the icon carries color.
7. Dirty check on remove is delegated to git itself (see §6), not a separate
   `git status` call.
8. Two-phase render (list first, enrich later) replaced by a single render.

## 3. Architecture

| File | Responsibility | Depends on |
|---|---|---|
| `src/git.ts` | `execFile` wrapper, `worktree list --porcelain` parser, per-worktree status, add/remove/prune, branch listing, source classification, unregistered-folder scan, add-location candidates. **No `vscode` import.** | `child_process`, `path`, `fs` |
| `src/tree.ts` | `TreeDataProvider`: repo, group, worktree, and error nodes; label/description/icon/tooltip/contextValue/id. | `git.ts`, `vscode` |
| `src/extension.ts` | `activate()`: obtain `vscode.git` API, register view + commands, source-folder watchers, debounced refresh. Command handlers live here. | `git.ts`, `tree.ts`, `vscode` |
| `src/git-api.d.ts` | Minimal hand-written subset of the `vscode.git` API types actually used. | — |
| `test/git.test.ts` | `node --test` suite for `git.ts` against a real temp repo. | `git.ts` |

`git.ts` functions take the git binary path and a working directory as
arguments, so they run identically under VS Code and under `node --test`.

### Built-in Git API subset used

```ts
const api = vscode.extensions.getExtension('vscode.git')!.exports.getAPI(1);
api.git.path                 // git binary to execFile
api.repositories             // Repository[]; each has rootUri, state.onDidChange
api.onDidOpenRepository
api.onDidCloseRepository
```

### Repo discovery and grouping

1. For each `api.repositories[i].rootUri`, run
   `git rev-parse --path-format=absolute --git-common-dir`.
2. Group by that common dir. Two workspace folders that are worktrees of the same
   repo produce one root node.
3. Root node label: basename of the main worktree path (first entry of
   `git worktree list --porcelain`).

## 4. Contributions (`package.json`)

- `engines.vscode`: `^1.90.0`
- `extensionDependencies`: `["vscode.git"]`
- `contributes.views.scm`: `[{ "id": "worktreeLens", "name": "Worktrees" }]`
- `contributes.viewsWelcome`: for `worktreeLens`, text "No Git repositories open."
- `contributes.configuration`:
  - `worktreeLens.pathTemplate` (string, default
    `../${repo}.worktrees/${branch}`), described as relative to the main
    worktree.
  - `worktreeLens.groupBySource` (boolean, default `true`).
- `contributes.commands`: `worktreeLens.refresh`, `worktreeLens.add`,
  `worktreeLens.open`, `worktreeLens.openNewWindow`, `worktreeLens.remove`,
  `worktreeLens.viewAsTree` (`list-tree`), `worktreeLens.viewAsList`
  (`list-flat`), each with a codicon.
- `contributes.menus`:
  - `view/title` (`navigation` group):
    - `add`, `refresh` when `view == worktreeLens`.
    - `viewAsList` when `view == worktreeLens && config.worktreeLens.groupBySource`.
    - `viewAsTree` when `view == worktreeLens && !config.worktreeLens.groupBySource`.
  - `view/item/context` inline:
    - `add` when `viewItem == repo`.
    - `open`, `openNewWindow` when
      `viewItem =~ /^worktree(\.main|\.current|\.orphan)?$/`.
    - `remove` when `viewItem =~ /^worktree(\.missing|\.orphan)?$/`.
  - `commandPalette`: hide `open`, `openNewWindow`, `remove` (`when: false`);
    they require a node argument.

### `contextValue`s

| Value | Node |
|---|---|
| `repo` | Repo root node |
| `group` | Source-folder group node |
| `worktree` | Removable worktree (linked, not current) |
| `worktree.main` | Main worktree |
| `worktree.current` | A linked worktree that is open as a workspace folder |
| `worktree.missing` | A prunable worktree (folder gone): remove only, no open |
| `worktree.orphan` | An unregistered folder in a source folder: open and remove |

A main worktree that is also current uses `worktree.main`. Remove is shown only
for `worktree`, `worktree.missing`, and `worktree.orphan`.

## 5. Tree rendering and status

### 5.1 Data flow

`getChildren()` with no argument returns repo root nodes (from the grouping in
§3). `getChildren(repoNode)`:

1. `git worktree list --porcelain` in any worktree of the repo.
2. Parse into entries. Skip `bare` entries.
3. Classify each entry's source (§5.4) and scan the source folders for
   unregistered folders (§5.5).
4. Resolve the base branch once for the repo: first of `main`, `master` that
   exists (`git rev-parse --verify --quiet refs/heads/<name>`); none → no `↑N`.
5. For all registered, non-prunable entries concurrently (`Promise.all`), run
   the checks in §5.3, each concurrently within the entry.
6. Build nodes (§5.6). In grouped mode, group nodes hold their already-built
   children; `getChildren(groupNode)` returns them without running git again.
7. VS Code shows the view progress bar while this resolves.

### 5.2 Porcelain parsing

Records are separated by a blank line. Recognised lines: `worktree <path>`,
`HEAD <sha>`, `branch refs/heads/<name>`, `detached`, `bare`,
`locked[ <reason>]`, `prunable[ <reason>]`. The first record is the main
worktree.

### 5.3 Status checks (cwd = the worktree path)

| Indicator | Command | Shown when |
|---|---|---|
| `+` | `git diff --cached --quiet` | exit code 1 |
| `↑N` | `git rev-list --count <base>..HEAD` | N > 0; hidden if no base |
| `⇡` | `git rev-list --count @{u}..HEAD` | count > 0; hidden on any failure (no upstream, detached) |
| `@` | none: `realpath` of the worktree path equals the `realpath` of any open workspace folder | match |

Any failing check hides only its own indicator; it never fails the node.

### 5.4 Source folders

| Folder (relative to main worktree) | Tag | Group icon |
|---|---|---|
| `.claude/worktrees` | `claude` | `robot` |
| `.codex/worktrees` | `codex` | `robot` |
| `.github/worktrees` | `github` | `robot` |
| `.agents/worktrees` | `agents` | `robot` |
| `.worktrees` | `worktrees` | `folder` |

A worktree's source is the first folder `F` in this order such that
`path.relative(main, worktreePath)` starts with `F` + path separator. The main
worktree never has a source. Worktrees outside these folders — including ones
agents keep outside the repo — have no source ("own" worktrees). The list is a
constant in `git.ts`.

### 5.5 Unregistered folders

For each source folder that exists as a directory under the main worktree, list
its immediate subdirectories. A subdirectory `D` is **unregistered** when no
registered worktree path `P` (after `realpath`) satisfies `P == D` or `P`
starts with `D` + path separator. The second condition keeps
`.codex/worktrees/abc` from being flagged when `.codex/worktrees/abc/repo` is a
registered worktree.

Unregistered folders get no status checks and no `@`.

### 5.6 Node presentation

**Ordering under a repo:**

- Grouped: main worktree, then own worktrees sorted by label, then one group
  node per source folder that has at least one entry (registered or
  unregistered), in the §5.4 order. Children of a group are sorted by label.
- Flat: main worktree, then own worktrees, then sourced worktrees and
  unregistered folders, each sorted by label, all directly under the repo.

**Repo node:** label = repo name, icon `repo`, collapsible state `Expanded`.

**Group node:** label = folder path (e.g. `.claude/worktrees`), description =
entry count, icon from §5.4, collapsible state `Collapsed`.

**Worktree node:**

- **Label:** branch name; detached → `(detached) <7-char sha>`; unregistered →
  folder name.
- **Description**, then indicators in the order `@ + ↑N ⇡`, separated by two
  spaces:
  - own or main worktree (either mode): path relative to the main worktree
    (`.` for the main worktree itself). Example:
    `../myapp.worktrees/feature-login  @  +  ↑1  ⇡`.
  - sourced, grouped mode: folder name only. Example: `fix-auth  ↑3`.
  - sourced, flat mode: tag, then path relative to the main worktree. Example:
    `claude  .claude/worktrees/fix-auth  ↑3`.
  - prunable: the path part above, then `missing` (no indicators).
  - unregistered: the path part above, then `unregistered` (no indicators).
- **Tooltip:** absolute path, then one line per active indicator in words
  (e.g. "2 commits ahead of main", "Has staged changes"). Unregistered: "Folder
  exists, but git has no worktree registered here."
- **Icon (first match wins):**
  1. prunable → `warning`
  2. unregistered → `circle-slash`
  3. locked → `lock`
  4. current → `check` with `ThemeColor('charts.green')`
  5. staged → `circle-filled` with `ThemeColor('gitDecoration.modifiedResourceForeground')`
  6. otherwise → `git-branch`

**Stable ids** (`TreeItem.id`), so expand/collapse state survives refresh:
`repo:<commonDir>`, `group:<commonDir>:<folder>`, `wt:<absolute path>`,
`err:<commonDir>`.

### 5.7 Refresh

A single `refresh()` fires `_onDidChangeTreeData` with `undefined` (whole tree).
It is debounced at 300 ms and triggered by:

- each repository's `state.onDidChange` (subscribed on open, disposed on close),
- `api.onDidOpenRepository` / `api.onDidCloseRepository`,
- `vscode.workspace.onDidChangeWorkspaceFolders` (affects `@`),
- source-folder watchers (below),
- completion of add/remove,
- the refresh command and changes to `worktreeLens.*` settings (not debounced).

**Source-folder watchers:** for each source folder that exists under a repo's
main worktree, one
`vscode.workspace.createFileSystemWatcher(new RelativePattern(Uri.file(<folder>), '*'))`,
with create/delete events feeding the debounced refresh. Watchers are kept in a
map keyed by folder path: created when a render finds the folder, disposed when
the folder or its repo disappears. A source folder created later is watched
from the next render onward.

Known limit: built-in Git events fire only for repos VS Code has open, so
status changes inside a worktree that is not open appear on the next refresh.

## 6. Commands and workflows

### `worktreeLens.refresh`

Refresh immediately.

### `worktreeLens.viewAsTree` / `worktreeLens.viewAsList`

Set `worktreeLens.groupBySource` to `true` / `false` in global settings. The
configuration change triggers the refresh.

### `worktreeLens.open` / `worktreeLens.openNewWindow`

`vscode.commands.executeCommand('vscode.openFolder', Uri.file(path), forceNewWindow)`
with `false` / `true`.

### `worktreeLens.add`

1. **Repo:** from a repo node inline action, that repo. From the view title: the
   only repo, or a quick pick when there are several.
2. **Branch quick pick**, in order:
   - `$(add) Create new branch…`
   - local branches (`git for-each-ref --format=%(refname:short) refs/heads`)
   - remote branches with no local branch of the same name
     (`refs/remotes`, excluding `*/HEAD`), shown with the remote prefix, passed
     to git without it.
   Branches already checked out in any worktree of the repo are omitted.
3. **New branch name** (only if "Create new branch…"): input box; empty cancels.
   Validation is left to git.
4. **Location quick pick** (skipped when no source folder exists in the repo).
   `<branch>` below is the branch name with `/` replaced by `-`.
   - `Default` — description: `worktreeLens.pathTemplate` resolved with
     `${repo}` = repo name and `${branch}` = `<branch>`.
   - one item per existing source folder `F` — description: `F/<branch>`.
   Escape cancels.
5. **Path:** input box pre-filled with the chosen location (or the resolved
   template when step 4 was skipped). Resolved relative to the main worktree.
   Empty cancels.
6. **Run** in the main worktree:
   - new branch: `git worktree add -b <name> <path> <base>` where `<base>` is
     `main`, else `master`, else `HEAD`.
   - existing local or remote branch: `git worktree add <path> <branch>` (git
     creates the tracking local branch for a remote-only name).
7. Refresh.

### `worktreeLens.remove`

By node kind:

- **Registered worktree** (`worktree`):
  1. Modal: "Remove worktree `<label>` and delete its folder?" → Remove /
     Cancel.
  2. Run `git worktree remove <path>` (no `--force`).
  3. If stderr contains `contains modified or untracked files`: modal
     "Worktree is dirty. Force remove?" → Force Remove / Cancel. On confirm,
     run `git worktree remove --force <path>`.
- **Prunable** (`worktree.missing`):
  1. Same modal as above.
  2. Run `git worktree prune` in the main worktree.
- **Unregistered** (`worktree.orphan`):
  1. Modal: "Delete folder `<name>`? Git doesn't track it as a worktree." →
     Move to Trash / Cancel.
  2. `vscode.workspace.fs.delete(Uri.file(path), { recursive: true, useTrash: true })`.
     On failure, show the error. Never fall back to a permanent delete.

Then refresh.

Not offered from the view: removing the main worktree or a current worktree
(menus hide it via `contextValue`).

## 7. Error handling and edge cases

- Any failed mutation (`add`, `remove`, `prune`, trash) → `showErrorMessage`
  with git's stderr (or the filesystem error), trimmed. No custom rewording.
- Status-check failures are silent (indicator hidden).
- `git worktree list` failure for a repo → the repo node shows a single child
  with the error text and a `error` icon.
- Source-folder scan failures (permissions, race with deletion) → that folder
  contributes no unregistered entries; registered worktrees are unaffected.
- The git binary is always `api.git.path`, respecting the user's `git.path`.

| Case | Handling |
|---|---|
| Detached HEAD | Label `(detached) <sha>`; `⇡` hidden. |
| Bare main repo | Bare record skipped. |
| Worktree folder deleted manually (`prunable`) | `warning` icon, `missing` in description, no status checks; remove → `git worktree prune`. |
| Locked worktree | `lock` icon; remove surfaces git's refusal. No unlock command. |
| Branch already checked out elsewhere | Omitted from the add quick pick. |
| Repo with only the main worktree | Root node with one child. |
| Removed worktree is open in another window | Not detected; that window loses its folder. Accepted. |
| Agent leaves a folder in a source folder without a registered worktree | Shown as unregistered; remove moves it to the trash. |
| Registered worktree nested deeper in a source folder (`F/abc/repo`) | Classified under `F`; `F/abc` not flagged unregistered. |
| Trash unavailable (e.g. some remote file systems) | Delete fails with an error; folder kept. |

## 8. Testing

### Automated: `test/git.test.ts` (`node --test`)

Runs against a real temporary repo created per test run (`git init -b main`,
isolated from user config via `GIT_CONFIG_GLOBAL=/dev/null` and fixed author
env vars). Asserts:

- Porcelain parser: main + linked worktree, branch names, detached, bare,
  locked, prunable.
- Status: staged change detected; `↑N` counts commits beyond `main`; `⇡` hidden
  with no upstream and counted with a local bare remote as upstream.
- Remove: clean worktree removed; dirty worktree refused with the
  "contains modified or untracked files" message, then removed with force.
- Add: new branch from `main`; existing branch.
- Path template: `${repo}`, `${branch}` substitution and `/` → `-`.
- Source classification: each of the five folders; own worktree outside them
  (including `../myapp.worktrees/x`, which must not match `.worktrees`); main
  worktree has no source.
- Unregistered scan: unregistered `.claude/worktrees/ghost` flagged; registered
  `.claude/worktrees/x` not flagged; registered `.codex/worktrees/abc/repo` does
  not flag `abc`; missing source folder → no entries.
- Add-location candidates: default first, then only source folders that exist,
  with the sanitized branch name.

`npm test` = `tsc -p . && node --test out/test/git.test.js`.

### Manual: Extension Development Host (F5)

1. Single repo: list shows main worktree with `@`.
2. Add with a new branch → new node appears with the templated path.
3. Add from an existing remote branch.
4. Stage a file in a worktree that is open in the workspace → `+` and icon color
   appear without pressing refresh.
5. Open, and open in new window.
6. Remove clean worktree; remove dirty worktree (force prompt).
7. Multi-root workspace with two repos, and with two worktrees of the same repo
   (one root node).
8. Delete a worktree folder by hand → `missing`; remove → pruned.
9. `git worktree add .claude/worktrees/x` from a terminal → appears under the
   `.claude/worktrees` group without pressing refresh.
10. `mkdir .claude/worktrees/ghost` → shown as unregistered; remove → folder is
    in the OS trash.
11. Toggle list/tree from the view title; expand a group, refresh, group stays
    expanded.
12. Add with `.claude/worktrees` existing → location quick pick offers it.

### Packaging

`npx @vscode/vsce package` → `worktree-lens-<version>.vsix`, installed with
`code --install-extension`. No Marketplace publishing.

## 9. Out of scope

- Moving, locking, unlocking, or repairing worktrees (including
  `git worktree repair` for unregistered folders).
- Polling, or file watchers beyond the source folders.
- A setting for additional source folders (the list is a constant; add a
  setting when a sixth tool appears).
- Automatically git-ignoring in-repo source folders.
- "Open it now?" prompt after add.
- Configurable base branch (`main` → `master` fallback only).
- `@vscode/test-electron` integration tests.
- Marketplace publishing, bundling, CI.
