# AGENTS.md

VS Code extension: all Git worktree actions in one tree view in the SCM
sidebar. Design spec: `docs/superpowers/specs/2026-09-25-worktree-lens-design.md`
— it is the source of truth; read it before changing behavior.

## Layout

| File | Responsibility |
|---|---|
| `src/git.ts` | Git CLI wrapper + porcelain parser + status + mutations + source classification + unregistered scan + path template. **No `vscode` import.** |
| `src/tree.ts` | `TreeDataProvider`: repo/group/worktree/error nodes. |
| `src/extension.ts` | `activate()`: Git API wiring, commands, watchers, debounced refresh. |
| `src/git-api.d.ts` | Hand-written subset of the `vscode.git` API types. |
| `test/git.test.ts` | `node --test` against a real temp repo. |

## Commands

```sh
mise install && npm install   # toolchain (node 22)
make build                    # tsc -p .
make test                     # tsc + node --test out/test/git.test.js
make package                  # worktree-lens-<version>.vsix
```

F5 = Extension Development Host (manual checklist in spec §8).

## Rules

- `src/git.ts` never imports `vscode`; every function takes the git binary
  path and a cwd so it runs under `node --test`.
- `execFile` only — branch names and paths are argv entries, never
  shell-interpolated.
- Command IDs and settings are namespaced `worktreeLens.*`.
- `contextValue` drives all menu visibility (`repo`, `group`, `worktree`,
  `worktree.main`, `worktree.current`, `worktree.missing`, `worktree.orphan`)
  — see spec §4.
- Status checks are silent on failure (indicator hidden); mutation failures
  surface git's trimmed stderr verbatim.
- Unregistered folders are deleted via `workspace.fs.delete` with
  `useTrash: true`; never a permanent delete.
- The source-folder list is a constant in `git.ts` — do not add a setting
  (spec §9).
