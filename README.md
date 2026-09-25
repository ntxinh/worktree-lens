# Worktree Lens

A VS Code extension that puts every Git worktree action one click away in a
dedicated tree view inside the Source Control sidebar, with at-a-glance status
per worktree.

Personal tool — installed locally from a `.vsix`, not published to the
Marketplace.

## Features

- Every worktree of every open repo in one view, grouped by repo.
- Status per worktree: current (`@`), staged changes (`+`), commits ahead of
  main (`↑N`), unpushed commits (`⇡`).
- One-click add, open, open in new window, remove, refresh.
- Agent worktree folders (`.claude/worktrees`, `.codex/worktrees`,
  `.github/worktrees`, `.agents/worktrees`, `.worktrees`) are grouped by
  folder, and folders left behind unregistered are shown and removable
  (moved to trash, never permanently deleted).
- Event-driven refresh — no polling.

## Requirements

- VS Code ≥ 1.90
- Git on `PATH` (or configured via the built-in Git extension's `git.path`)

## Install

```sh
make package                              # builds worktree-lens-<version>.vsix
code --install-extension worktree-lens-*.vsix
```

## Usage

Open the Source Control sidebar — the **Worktrees** view sits alongside the
built-in SCM views.

- **Add**: `+` in the view title (or inline on a repo node) → pick or create a
  branch → pick a location → confirm path.
- **Open / Open in New Window**: inline on a worktree node.
- **Remove**: inline on a worktree node; dirty worktrees get a force prompt,
  missing folders are pruned, unregistered folders go to the trash.
- **Toggle grouping**: list/tree icon in the view title.

## Settings

| Setting | Default | Description |
|---|---|---|
| `worktreeLens.pathTemplate` | `../${repo}.worktrees/${branch}` | Default location for new worktrees, relative to the main worktree. `${repo}` = repo name, `${branch}` = branch with `/` → `-`. |
| `worktreeLens.groupBySource` | `true` | Group agent-source worktrees under one node per source folder; off = flat list with a source tag. |

## Development

```sh
mise install    # node
npm install
make build      # tsc -p .
make test       # tsc + node --test against real temp repos
```

F5 launches an Extension Development Host for manual testing (checklist in
`docs/superpowers/specs/2026-09-25-worktree-lens-design.md` §8).

## Design

`docs/superpowers/specs/2026-09-25-worktree-lens-design.md`
