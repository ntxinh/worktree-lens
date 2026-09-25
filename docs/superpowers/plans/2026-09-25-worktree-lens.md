# Worktree Lens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VS Code extension that puts every Git worktree action one click away in a tree view inside the Source Control sidebar, with per-worktree status.

**Architecture:** `src/git.ts` holds all Git CLI logic (execFile, porcelain parsing, status, mutations, source classification) with **no `vscode` import** so it runs under `node --test`. `src/tree.ts` is a `TreeDataProvider` building repo/group/worktree/error nodes. `src/extension.ts` wires the built-in `vscode.git` API, commands, watchers, and debounced refresh.

**Tech Stack:** TypeScript, `commonjs`, plain `tsc` (no bundler), `node --test` against a real temp repo, `@vscode/vsce` for packaging.

**Spec:** `docs/superpowers/specs/2026-09-25-worktree-lens-design.md` — the plan argues from the spec; read it alongside each task.

## Global Constraints

- `engines.vscode`: `^1.90.0`; `extensionDependencies`: `["vscode.git"]`.
- Command IDs and settings namespaced `worktreeLens.*`.
- Git access via `execFile` only — args are argv entries, never shell-interpolated.
- Git binary is always `api.git.path`.
- No `activationEvents`, no `viewsContainers` — `contributes.views.scm` with id `worktreeLens`.
- Source folders constant (order matters): `.claude/worktrees` (tag `claude`, icon `robot`), `.codex/worktrees` (`codex`, `robot`), `.github/worktrees` (`github`, `robot`), `.agents/worktrees` (`agents`, `robot`), `.worktrees` (`worktrees`, `folder`) — relative to the main worktree.
- Settings: `worktreeLens.pathTemplate` default `../${repo}.worktrees/${branch}`; `worktreeLens.groupBySource` default `true`.
- `contextValue`s: `repo`, `group`, `worktree`, `worktree.main`, `worktree.current`, `worktree.missing`, `worktree.orphan`.
- Refresh: debounced 300 ms, event-driven only — no polling.
- `npm test` = `tsc -p . && node --test out/test/git.test.js`.
- Already scaffolded at repo root: `package.json`, `tsconfig.json` (`rootDir: "."`, `outDir: "out"` → compiled layout `out/src/`, `out/test/`), `Makefile`, `mise.toml`, `.editorconfig`, `.gitignore`, `.vscodeignore`, `.vscode/launch.json`, `README.md`, `AGENTS.md`. `npm install` already run.

## File Structure

| File | Responsibility |
|---|---|
| `src/git.ts` | execFile wrapper, porcelain parser, `listWorktrees`, `resolveBase`, `getStatus`, `listBranches`, `addWorktree`/`removeWorktree`/`pruneWorktrees`, `classifySource`, `findUnregistered`, `resolvePathTemplate`, `addLocationCandidates`. No `vscode` import. |
| `src/git-api.d.ts` | Hand-written subset of the `vscode.git` API types. Types only. |
| `src/tree.ts` | `RepoNode`, `GroupNode`, `WorktreeNode`, `ErrorNode`, `WorktreeLensProvider`. |
| `src/extension.ts` | `activate()`, `discoverRepos`, command handlers, watchers, debounce. |
| `test/git.test.ts` | `node --test` suite against real temp repos. |

### Shared interface contract (`src/git.ts` — the names every task uses)

```ts
export const SOURCE_FOLDERS: readonly { folder: string; tag: string; icon: string }[];
export type SourceFolder = (typeof SOURCE_FOLDERS)[number];

export interface WorktreeEntry {
  path: string;            // absolute worktree path
  head: string;            // full sha
  branch?: string;         // short branch name; undefined when detached
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
}

export function runGit(gitPath: string, cwd: string, args: string[]): Promise<string>;
export function parseWorktreeList(out: string): WorktreeEntry[];
export function gitCommonDir(gitPath: string, cwd: string): Promise<string>;
export function listWorktrees(gitPath: string, cwd: string): Promise<WorktreeEntry[]>;
export function resolveBase(gitPath: string, cwd: string): Promise<string | undefined>; // 'main' | 'master' | undefined
export interface WorktreeStatus { staged: boolean; ahead: number; unpushed: number }
export function getStatus(gitPath: string, wtPath: string, base: string | undefined): Promise<WorktreeStatus>;
export function listBranches(gitPath: string, cwd: string): Promise<{ local: string[]; remote: string[] }>;
export function addWorktree(gitPath: string, mainPath: string, wtPath: string, opts: { newBranch?: string; branch?: string; base?: string }): Promise<void>;
export function removeWorktree(gitPath: string, mainPath: string, wtPath: string, force?: boolean): Promise<void>;
export function pruneWorktrees(gitPath: string, mainPath: string): Promise<void>;
export function classifySource(mainPath: string, wtPath: string): SourceFolder | undefined;
export function findUnregistered(mainPath: string, registeredPaths: string[]): Promise<{ folder: SourceFolder; path: string }[]>;
export function resolvePathTemplate(template: string, repo: string, branch: string): string;
export function addLocationCandidates(repo: string, mainPath: string, template: string, branch: string): Promise<{ label: string; wtPath: string }[]>;
```

`tree.ts` exports: `RepoInfo`, `Node`, `RepoNode`, `GroupNode`, `WorktreeNode`, `ErrorNode`, `WorktreeLensProvider` — signatures in Task 6.

---

### Task 1: `src/git-api.d.ts` — Git API type subset

**Files:**
- Create: `src/git-api.d.ts`

**Interfaces:**
- Produces: `GitExtension`, `GitApi`, `Repository` types used by `extension.ts`.

- [ ] **Step 1: Write the file**

```ts
// Minimal subset of the built-in vscode.git extension API actually used.
// The real API is https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
import type * as vscode from 'vscode';

export interface GitExtension {
  getAPI(version: 1): GitApi;
}

export interface GitApi {
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
}
```

- [ ] **Step 2: Compile**

Run: `npx tsc -p .`
Expected: clean (no output). Note: `src/extension.ts` doesn't exist yet; `include` covers `src/**/*.ts` — a lone `.d.ts` compiles fine.

- [ ] **Step 3: Commit**

```bash
git add src/git-api.d.ts && git commit -m "feat: git API type subset"
```

---

### Task 2: `src/git.ts` core — runGit, porcelain parser, listWorktrees, gitCommonDir

**Files:**
- Create: `src/git.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Produces: `SOURCE_FOLDERS`, `SourceFolder`, `WorktreeEntry`, `runGit`, `parseWorktreeList`, `gitCommonDir`, `listWorktrees` (contract above).

- [ ] **Step 1: Write the failing tests**

Create `test/git.test.ts`:

```ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as g from '../src/git';

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const GIT = process.env.GIT ?? 'git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, args, { cwd, env: ENV, encoding: 'utf8' });
}

/** Creates <tmp>/repo as `git init -b main` with one commit. Returns main worktree path. */
function makeRepo(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'repo');
  git(dir, 'init', '-b', 'main', 'repo');
  fs.writeFileSync(path.join(main, 'f.txt'), 'x\n');
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'init');
  return main;
}

test('parseWorktreeList: main, linked, detached, bare, locked, prunable', () => {
  const out = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo.wt/feat',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feature/x',
    'locked reason here',
    '',
    'worktree /repo.wt/det',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
    'worktree /repo.git',
    'HEAD 0000000000000000000000000000000000000000',
    'bare',
    '',
    'worktree /repo.wt/gone',
    'HEAD 4444444444444444444444444444444444444444',
    'branch refs/heads/old',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  const e = g.parseWorktreeList(out);
  assert.equal(e.length, 5);
  assert.deepEqual(
    { path: e[0].path, branch: e[0].branch, bare: e[0].bare },
    { path: '/repo', branch: 'main', bare: false },
  );
  assert.equal(e[1].branch, 'feature/x');
  assert.equal(e[1].locked, true);
  assert.equal(e[1].lockReason, 'reason here');
  assert.equal(e[2].detached, true);
  assert.equal(e[2].branch, undefined);
  assert.equal(e[3].bare, true);
  assert.equal(e[4].prunable, true);
  assert.match(e[4].prunableReason!, /non-existent/);
});

test('listWorktrees + gitCommonDir against a real repo', async (t) => {
  const main = makeRepo(t);
  const wt = path.join(path.dirname(main), 'repo.wt', 'feat');
  git(main, 'worktree', 'add', '-b', 'feature', wt);
  const entries = await g.listWorktrees(GIT, main);
  assert.equal(entries.length, 2);
  assert.equal(fs.realpathSync(entries[0].path), fs.realpathSync(main));
  assert.equal(entries[0].branch, 'main');
  assert.equal(fs.realpathSync(entries[1].path), fs.realpathSync(wt));
  assert.equal(entries[1].branch, 'feature');
  const common = await g.gitCommonDir(GIT, wt);
  assert.equal(common, path.join(fs.realpathSync(main), '.git'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/git'`.

- [ ] **Step 3: Implement `src/git.ts` core**

```ts
import { execFile } from 'node:child_process';
import { promises as fsp, realpathSync } from 'node:fs';
import * as path from 'node:path';

/** Agent source folders, in precedence order. The list is a constant by design (spec §9). */
export const SOURCE_FOLDERS = [
  { folder: '.claude/worktrees', tag: 'claude', icon: 'robot' },
  { folder: '.codex/worktrees', tag: 'codex', icon: 'robot' },
  { folder: '.github/worktrees', tag: 'github', icon: 'robot' },
  { folder: '.agents/worktrees', tag: 'agents', icon: 'robot' },
  { folder: '.worktrees', tag: 'worktrees', icon: 'folder' },
] as const;
export type SourceFolder = (typeof SOURCE_FOLDERS)[number];

export interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
}

/** Runs git via execFile; resolves stdout, rejects with trimmed stderr on non-zero exit. */
export function runGit(gitPath: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      args,
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && typeof err.code === 'number') {
          reject(new Error(stderr.trim() || err.message));
        } else if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  const flush = () => {
    if (cur) {
      entries.push(cur);
      cur = undefined;
    }
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice(9), head: '', detached: false, bare: false, locked: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
      cur.lockReason = line.slice(6).trim() || undefined;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
      cur.prunableReason = line.slice(8).trim() || undefined;
    }
  }
  flush();
  return entries;
}

export async function gitCommonDir(gitPath: string, cwd: string): Promise<string> {
  return (await runGit(gitPath, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
}

export async function listWorktrees(gitPath: string, cwd: string): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await runGit(gitPath, cwd, ['worktree', 'list', '--porcelain']));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts && git commit -m "feat: git execFile wrapper and worktree porcelain parser"
```

---

### Task 3: `src/git.ts` — resolveBase, getStatus

**Files:**
- Modify: `src/git.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Consumes: `runGit`, `listWorktrees` from Task 2.
- Produces: `resolveBase`, `WorktreeStatus`, `getStatus`.

- [ ] **Step 1: Write the failing tests**

Append to `test/git.test.ts`:

```ts
test('resolveBase: main, master fallback, none', async (t) => {
  const main = makeRepo(t);
  assert.equal(await g.resolveBase(GIT, main), 'main');
  git(main, 'branch', '-m', 'main', 'master');
  assert.equal(await g.resolveBase(GIT, main), 'master');
  git(main, 'branch', '-m', 'master', 'trunk');
  assert.equal(await g.resolveBase(GIT, main), undefined);
});

test('getStatus: staged, ahead, unpushed without upstream', async (t) => {
  const main = makeRepo(t);
  const wt = path.join(path.dirname(main), 'repo.wt', 'feat');
  git(main, 'worktree', 'add', '-b', 'feature', wt);

  let s = await g.getStatus(GIT, wt, 'main');
  assert.deepEqual(s, { staged: false, ahead: 0, unpushed: 0 });

  // staged change
  fs.writeFileSync(path.join(wt, 'f.txt'), 'changed\n');
  git(wt, 'add', 'f.txt');
  s = await g.getStatus(GIT, wt, 'main');
  assert.equal(s.staged, true);
  assert.equal(s.ahead, 0);

  // commit → ahead of main, no longer staged
  git(wt, 'commit', '-m', 'feat work');
  s = await g.getStatus(GIT, wt, 'main');
  assert.equal(s.staged, false);
  assert.equal(s.ahead, 1);
  assert.equal(s.unpushed, 0); // no upstream
});

test('getStatus: unpushed counted with a local bare remote as upstream', async (t) => {
  const main = makeRepo(t);
  const bare = path.join(path.dirname(main), 'remote.git');
  git(path.dirname(main), 'init', '--bare', bare);
  git(main, 'remote', 'add', 'origin', bare);
  git(main, 'push', '-u', 'origin', 'main');

  fs.writeFileSync(path.join(main, 'f.txt'), 'more\n');
  git(main, 'commit', '-am', 'ahead of origin');
  const s = await g.getStatus(GIT, main, 'main');
  assert.equal(s.unpushed, 1);
});

test('getStatus: no base → ahead stays 0', async (t) => {
  const main = makeRepo(t);
  const s = await g.getStatus(GIT, main, undefined);
  assert.equal(s.ahead, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `g.resolveBase is not a function`.

- [ ] **Step 3: Implement**

Append to `src/git.ts`:

```ts
/** First existing of main, master; undefined when neither exists. */
export async function resolveBase(gitPath: string, cwd: string): Promise<string | undefined> {
  for (const name of ['main', 'master']) {
    try {
      await runGit(gitPath, cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      return name;
    } catch {
      // try next
    }
  }
  return undefined;
}

export interface WorktreeStatus {
  staged: boolean;
  ahead: number;
  unpushed: number;
}

/** Each check fails silently into its zero value — a failure hides only its own indicator. */
export async function getStatus(
  gitPath: string,
  wtPath: string,
  base: string | undefined,
): Promise<WorktreeStatus> {
  const [staged, ahead, unpushed] = await Promise.all([
    // `diff --cached --quiet` exits 1 exactly when staged changes exist;
    // any other failure must hide the indicator, not turn it on.
    new Promise<boolean>((resolve) => {
      execFile(
        gitPath,
        ['diff', '--cached', '--quiet'],
        { cwd: wtPath },
        (err) => resolve(err !== null && err.code === 1),
      );
    }),
    base
      ? runGit(gitPath, wtPath, ['rev-list', '--count', `${base}..HEAD`]).then(
          (n) => Number(n.trim()) || 0,
          () => 0,
        )
      : Promise.resolve(0),
    runGit(gitPath, wtPath, ['rev-list', '--count', '@{u}..HEAD']).then(
      (n) => Number(n.trim()) || 0,
      () => 0,
    ),
  ]);
  return { staged, ahead, unpushed };
}
```


- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts && git commit -m "feat: base resolution and per-worktree status"
```

---

### Task 4: `src/git.ts` — listBranches, addWorktree, removeWorktree, pruneWorktrees

**Files:**
- Modify: `src/git.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Consumes: `runGit`, `listWorktrees`.
- Produces: `listBranches` (remote entries keep `origin/` prefix, `*/HEAD` excluded), `addWorktree`, `removeWorktree`, `pruneWorktrees`.

- [ ] **Step 1: Write the failing tests**

Append to `test/git.test.ts`:

```ts
test('listBranches: local names; remote names keep prefix, HEAD excluded', async (t) => {
  const main = makeRepo(t);
  const bare = path.join(path.dirname(main), 'remote.git');
  git(path.dirname(main), 'init', '--bare', bare);
  git(main, 'remote', 'add', 'origin', bare);
  git(main, 'push', '-u', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main'); // creates origin/HEAD so the exclusion is exercised
  git(main, 'branch', 'local-only');

  const { local, remote } = await g.listBranches(GIT, main);
  assert.ok(local.includes('main'));
  assert.ok(local.includes('local-only'));
  assert.ok(remote.includes('origin/main'));
  assert.ok(!remote.some((r) => r.endsWith('/HEAD')));
});

test('addWorktree: new branch from base and existing branch', async (t) => {
  const main = makeRepo(t);
  const wtNew = path.join(path.dirname(main), 'repo.wt', 'new');
  await g.addWorktree(GIT, main, wtNew, { newBranch: 'feat-new', base: 'main' });
  let entries = await g.listWorktrees(GIT, main);
  assert.equal(fs.realpathSync(entries.find((e) => e.branch === 'feat-new')!.path), fs.realpathSync(wtNew));

  const wtOld = path.join(path.dirname(main), 'repo.wt', 'old');
  git(main, 'branch', 'feat-old');
  await g.addWorktree(GIT, main, wtOld, { branch: 'feat-old' });
  entries = await g.listWorktrees(GIT, main);
  assert.equal(fs.realpathSync(entries.find((e) => e.branch === 'feat-old')!.path), fs.realpathSync(wtOld));
});

test('removeWorktree: clean removed; dirty refused then forced', async (t) => {
  const main = makeRepo(t);
  const wt = path.join(path.dirname(main), 'repo.wt', 'feat');
  git(main, 'worktree', 'add', '-b', 'feature', wt);

  // dirty → refused
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x\n');
  await assert.rejects(
    () => g.removeWorktree(GIT, main, wt),
    /modified or untracked/,
  );
  assert.ok(fs.existsSync(wt));

  // forced → gone
  await g.removeWorktree(GIT, main, wt, true);
  assert.ok(!fs.existsSync(wt));
  const entries = await g.listWorktrees(GIT, main);
  assert.equal(entries.length, 1);
});

test('pruneWorktrees: prunes worktree whose folder was deleted', async (t) => {
  const main = makeRepo(t);
  const wt = path.join(path.dirname(main), 'repo.wt', 'feat');
  git(main, 'worktree', 'add', '-b', 'feature', wt);
  fs.rmSync(wt, { recursive: true, force: true });

  let entries = await g.listWorktrees(GIT, main);
  assert.equal(entries.find((e) => e.branch === 'feature')?.prunable, true);

  await g.pruneWorktrees(GIT, main);
  entries = await g.listWorktrees(GIT, main);
  assert.equal(entries.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `g.listBranches is not a function`.

- [ ] **Step 3: Implement**

Append to `src/git.ts`:

```ts
/** Remote entries keep the `origin/` prefix; remote HEAD symbolic refs are excluded. */
export async function listBranches(
  gitPath: string,
  cwd: string,
): Promise<{ local: string[]; remote: string[] }> {
  const [l, r] = await Promise.all([
    runGit(gitPath, cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    runGit(gitPath, cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
  ]);
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return { local: lines(l), remote: lines(r).filter((x) => !x.endsWith('/HEAD')) };
}

/**
 * `newBranch` → `git worktree add -b <newBranch> <wtPath> <base ?? 'HEAD'>`.
 * Otherwise → `git worktree add <wtPath> <branch>` (a remote-only short name
 * makes git create the tracking local branch).
 */
export async function addWorktree(
  gitPath: string,
  mainPath: string,
  wtPath: string,
  opts: { newBranch?: string; branch?: string; base?: string },
): Promise<void> {
  const args = opts.newBranch
    ? ['worktree', 'add', '-b', opts.newBranch, wtPath, opts.base ?? 'HEAD']
    : ['worktree', 'add', wtPath, opts.branch!];
  await runGit(gitPath, mainPath, args);
}

export async function removeWorktree(
  gitPath: string,
  mainPath: string,
  wtPath: string,
  force = false,
): Promise<void> {
  await runGit(gitPath, mainPath, ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath]);
}

export async function pruneWorktrees(gitPath: string, mainPath: string): Promise<void> {
  await runGit(gitPath, mainPath, ['worktree', 'prune']);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts && git commit -m "feat: branch listing and worktree mutations"
```

---

### Task 5: `src/git.ts` — classifySource, findUnregistered, resolvePathTemplate, addLocationCandidates

**Files:**
- Modify: `src/git.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Consumes: `SOURCE_FOLDERS`, `SourceFolder`, `listWorktrees`.
- Produces: `classifySource`, `findUnregistered`, `resolvePathTemplate`, `addLocationCandidates`.

- [ ] **Step 1: Write the failing tests**

Append to `test/git.test.ts`:

```ts
test('classifySource: five source folders, own worktrees, main worktree', async (t) => {
  const main = makeRepo(t);
  for (const s of g.SOURCE_FOLDERS) {
    assert.equal(g.classifySource(main, path.join(main, s.folder, 'x'))?.folder, s.folder);
  }
  // nested registered path still classifies under its source
  assert.equal(
    g.classifySource(main, path.join(main, '.codex/worktrees/abc/repo'))?.folder,
    '.codex/worktrees',
  );
  // own worktrees — including ../repo.worktrees/x which must NOT match '.worktrees'
  assert.equal(g.classifySource(main, path.join(path.dirname(main), 'repo.worktrees', 'x')), undefined);
  assert.equal(g.classifySource(main, '/elsewhere/x'), undefined);
  // main worktree has no source
  assert.equal(g.classifySource(main, main), undefined);
});

test('findUnregistered: flags orphans, spares registered and nested parents', async (t) => {
  const main = makeRepo(t);
  const claudeDir = path.join(main, '.claude/worktrees');
  const codexDir = path.join(main, '.codex/worktrees');

  // registered worktrees inside source folders
  const wtClaude = path.join(claudeDir, 'reg');
  fs.mkdirSync(claudeDir, { recursive: true });
  git(main, 'worktree', 'add', '-b', 'claude-wt', wtClaude);
  const wtNested = path.join(codexDir, 'abc', 'repo');
  fs.mkdirSync(path.dirname(wtNested), { recursive: true });
  git(main, 'worktree', 'add', '-b', 'codex-wt', wtNested);

  // unregistered folder
  fs.mkdirSync(path.join(claudeDir, 'ghost'));

  const entries = await g.listWorktrees(GIT, main);
  const orphans = await g.findUnregistered(main, entries.map((e) => e.path));
  const paths = orphans.map((o) => o.path);
  assert.deepEqual(paths, [path.join(claudeDir, 'ghost')]);
  assert.equal(orphans[0].folder.folder, '.claude/worktrees');
  // 'abc' not flagged although the registered worktree is 'abc/repo'
  assert.ok(!paths.includes(path.join(codexDir, 'abc')));

  // missing source folder contributes nothing
  fs.rmSync(claudeDir, { recursive: true, force: true });
  const orphans2 = await g.findUnregistered(main, entries.map((e) => e.path));
  assert.ok(!orphans2.some((o) => o.folder.folder === '.claude/worktrees'));
});

test('resolvePathTemplate: ${repo}, ${branch}, slash sanitization', () => {
  assert.equal(
    g.resolvePathTemplate('../${repo}.worktrees/${branch}', 'myapp', 'feature/login'),
    '../myapp.worktrees/feature-login',
  );
  assert.equal(g.resolvePathTemplate('${branch}', 'r', 'x'), 'x');
});

test('addLocationCandidates: Default first, then only existing source folders', async (t) => {
  const main = makeRepo(t);
  const tpl = '../${repo}.worktrees/${branch}';

  let cands = await g.addLocationCandidates('repo', main, tpl, 'feat/x');
  assert.deepEqual(cands, [{ label: 'Default', wtPath: '../repo.worktrees/feat-x' }]);

  fs.mkdirSync(path.join(main, '.claude/worktrees'), { recursive: true });
  cands = await g.addLocationCandidates('repo', main, tpl, 'feat/x');
  assert.deepEqual(cands, [
    { label: 'Default', wtPath: '../repo.worktrees/feat-x' },
    { label: '.claude/worktrees', wtPath: '.claude/worktrees/feat-x' },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `g.classifySource is not a function`.

- [ ] **Step 3: Implement**

Append to `src/git.ts`:

```ts
/** First source folder F such that the worktree path is inside main/F. */
export function classifySource(mainPath: string, wtPath: string): SourceFolder | undefined {
  const rel = path.relative(mainPath, wtPath);
  return SOURCE_FOLDERS.find((s) => rel.startsWith(s.folder + path.sep));
}

/**
 * Immediate subdirectories of each existing source folder that no registered
 * worktree (realpath-compared) equals or is nested inside.
 */
export async function findUnregistered(
  mainPath: string,
  registeredPaths: string[],
): Promise<{ folder: SourceFolder; path: string }[]> {
  const registered = registeredPaths.map(realpathSafe);
  const out: { folder: SourceFolder; path: string }[] = [];
  for (const s of SOURCE_FOLDERS) {
    const dir = path.join(mainPath, s.folder);
    let subs: string[];
    try {
      subs = (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // missing folder or permission error → contributes nothing
    }
    for (const name of subs) {
      const abs = path.join(dir, name);
      const real = realpathSafe(abs);
      const isRegistered = registered.some((p) => p === real || p.startsWith(real + path.sep));
      if (!isRegistered) out.push({ folder: s, path: abs });
    }
  }
  return out;
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `${repo}` → repo name; `${branch}` → branch with '/' replaced by '-'. */
export function resolvePathTemplate(template: string, repo: string, branch: string): string {
  return template
    .replace(/\$\{repo\}/g, repo)
    .replace(/\$\{branch\}/g, branch.replace(/\//g, '-'));
}

/** 'Default' plus one entry per source folder that exists under the main worktree. */
export async function addLocationCandidates(
  repo: string,
  mainPath: string,
  template: string,
  branch: string,
): Promise<{ label: string; wtPath: string }[]> {
  const out = [{ label: 'Default', wtPath: resolvePathTemplate(template, repo, branch) }];
  const sanitized = branch.replace(/\//g, '-');
  for (const s of SOURCE_FOLDERS) {
    try {
      if ((await fsp.stat(path.join(mainPath, s.folder))).isDirectory()) {
        out.push({ label: s.folder, wtPath: `${s.folder}/${sanitized}` });
      }
    } catch {
      // folder does not exist → skipped
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts && git commit -m "feat: source classification, orphan scan, path templates"
```

---

### Task 6: `src/tree.ts` — tree data provider and nodes

**Files:**
- Create: `src/tree.ts`

**Interfaces:**
- Consumes (from `git.ts`): `SOURCE_FOLDERS`, `SourceFolder`, `WorktreeEntry`, `WorktreeStatus`, `listWorktrees`, `resolveBase`, `getStatus`, `classifySource`, `findUnregistered`.
- Produces (consumed by `extension.ts`):

```ts
export interface RepoInfo {
  commonDir: string;
  name: string;                          // basename of main worktree path
  mainPath: string;                      // absolute path of main worktree
  gitPath: string;                       // git binary (api.git.path)
  openFolders: ReadonlySet<string>;      // realpaths of open workspace folders
}
export type Node = RepoNode | GroupNode | WorktreeNode | ErrorNode;
export class RepoNode extends vscode.TreeItem { readonly repo: RepoInfo }
export class GroupNode extends vscode.TreeItem { readonly items: WorktreeNode[] }
export class WorktreeNode extends vscode.TreeItem {
  readonly repo: RepoInfo; readonly wtPath: string;
  readonly missing: boolean; readonly orphan: boolean;
}
export class ErrorNode extends vscode.TreeItem {}
export class WorktreeLensProvider implements vscode.TreeDataProvider<Node> {
  onSourceFolders?: (commonDir: string, paths: string[]) => void;
  constructor(getRepos: () => Promise<RepoInfo[]>);
  refresh(): void;
}
```

- [ ] **Step 1: Write `src/tree.ts`**

```ts
import { realpathSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as g from './git';

export interface RepoInfo {
  commonDir: string;
  name: string;
  mainPath: string;
  gitPath: string;
  openFolders: ReadonlySet<string>;
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export class RepoNode extends vscode.TreeItem {
  readonly kind = 'repo';
  constructor(public readonly repo: RepoInfo) {
    super(repo.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `repo:${repo.commonDir}`;
    this.contextValue = 'repo';
    this.tooltip = repo.mainPath;
    this.iconPath = new vscode.ThemeIcon('repo');
  }
}

export class GroupNode extends vscode.TreeItem {
  readonly kind = 'group';
  constructor(commonDir: string, public readonly folder: g.SourceFolder, public readonly items: WorktreeNode[]) {
    super(folder.folder, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `group:${commonDir}:${folder.folder}`;
    this.contextValue = 'group';
    this.description = String(items.length);
    this.iconPath = new vscode.ThemeIcon(folder.icon);
  }
}

export class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error';
  constructor(commonDir: string, message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.id = `err:${commonDir}`;
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

export class WorktreeNode extends vscode.TreeItem {
  readonly kind = 'worktree';
  constructor(
    label: string,
    public readonly repo: RepoInfo,
    public readonly wtPath: string,
    public readonly missing: boolean,
    public readonly orphan: boolean,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `wt:${wtPath}`;
  }
}

export type Node = RepoNode | GroupNode | WorktreeNode | ErrorNode;

type RegisteredSpec = {
  kind: 'registered';
  entry: g.WorktreeEntry;
  source: g.SourceFolder | undefined;
  status: g.WorktreeStatus;
  current: boolean;
  isMain: boolean;
};
type OrphanSpec = { kind: 'orphan'; absPath: string; source: g.SourceFolder };
type NodeSpec = RegisteredSpec | OrphanSpec;

function makeWorktreeNode(
  s: NodeSpec,
  repo: RepoInfo,
  grouped: boolean,
  base: string | undefined,
): WorktreeNode {
  if (s.kind === 'orphan') {
    const label = path.basename(s.absPath);
    const rel = path.relative(repo.mainPath, s.absPath);
    const desc = (grouped ? label : `${s.source.tag}  ${rel}`) + '  unregistered';
    const node = new WorktreeNode(label, repo, s.absPath, false, true);
    node.description = desc;
    node.tooltip = `${s.absPath}\nFolder exists, but git has no worktree registered here.`;
    node.iconPath = new vscode.ThemeIcon('circle-slash');
    node.contextValue = 'worktree.orphan';
    return node;
  }

  const { entry: e, status, current } = s;
  const label = e.branch ?? `(detached) ${e.head.slice(0, 7)}`;
  const rel = path.relative(repo.mainPath, e.path) || '.';
  const parts: string[] = !s.source
    ? [rel]
    : grouped
      ? [path.basename(e.path)]
      : [`${s.source.tag}  ${rel}`];

  const tip: string[] = [e.path];
  if (e.prunable) {
    parts.push('missing');
    tip.push('Folder is missing; remove to prune the registration.');
  } else {
    if (current) {
      parts.push('@');
      tip.push('Open in this window');
    }
    if (status.staged) {
      parts.push('+');
      tip.push('Has staged changes');
    }
    if (status.ahead > 0) {
      parts.push(`↑${status.ahead}`);
      tip.push(`${status.ahead} commit${status.ahead === 1 ? '' : 's'} ahead of ${base}`);
    }
    if (status.unpushed > 0) {
      parts.push('⇡');
      tip.push(`${status.unpushed} unpushed commit${status.unpushed === 1 ? '' : 's'}`);
    }
  }

  const node = new WorktreeNode(label, repo, e.path, e.prunable, false);
  node.description = parts.join('  ');
  node.tooltip = tip.join('\n');
  node.contextValue = s.isMain
    ? 'worktree.main'
    : current
      ? 'worktree.current'
      : e.prunable
        ? 'worktree.missing'
        : 'worktree';
  node.iconPath = e.prunable
    ? new vscode.ThemeIcon('warning')
    : e.locked
      ? new vscode.ThemeIcon('lock')
      : current
        ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
        : status.staged
          ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'))
          : new vscode.ThemeIcon('git-branch');
  return node;
}

const byLabel = (a: WorktreeNode, b: WorktreeNode) =>
  String(a.label).localeCompare(String(b.label));

/** Spec §5.1: full children for a repo node in a single pass. */
async function repoChildren(
  repo: RepoInfo,
  grouped: boolean,
  onFolders: (paths: string[]) => void,
): Promise<Node[]> {
  let entries: g.WorktreeEntry[];
  try {
    entries = (await g.listWorktrees(repo.gitPath, repo.mainPath)).filter((e) => !e.bare);
  } catch (e) {
    const msg = e instanceof Error ? e.message.trim() : String(e);
    return [new ErrorNode(repo.commonDir, msg)];
  }
  if (entries.length === 0) return [];

  const existing = g.SOURCE_FOLDERS.filter((s) =>
    existsSync(path.join(repo.mainPath, s.folder)),
  ).map((s) => path.join(repo.mainPath, s.folder));
  onFolders(existing);

  const orphans = await g.findUnregistered(repo.mainPath, entries.map((e) => e.path));
  const base = await g.resolveBase(repo.gitPath, repo.mainPath);

  const statuses = new Map<string, g.WorktreeStatus>();
  await Promise.all(
    entries
      .filter((e) => !e.prunable)
      .map(async (e) => statuses.set(e.path, await g.getStatus(repo.gitPath, e.path, base))),
  );
  const zero: g.WorktreeStatus = { staged: false, ahead: 0, unpushed: 0 };

  const mainNode = makeWorktreeNode(
    {
      kind: 'registered',
      entry: entries[0],
      source: undefined,
      status: statuses.get(entries[0].path) ?? zero,
      current: repo.openFolders.has(realpathSafe(entries[0].path)),
      isMain: true,
    },
    repo,
    grouped,
    base,
  );

  const own: WorktreeNode[] = [];
  const sourced = new Map<g.SourceFolder, WorktreeNode[]>();
  const put = (f: g.SourceFolder, n: WorktreeNode) =>
    sourced.set(f, [...(sourced.get(f) ?? []), n]);

  for (const e of entries.slice(1)) {
    const source = g.classifySource(repo.mainPath, e.path);
    const node = makeWorktreeNode(
      {
        kind: 'registered',
        entry: e,
        source,
        status: statuses.get(e.path) ?? zero,
        current: repo.openFolders.has(realpathSafe(e.path)),
        isMain: false,
      },
      repo,
      grouped,
      base,
    );
    if (source) put(source, node);
    else own.push(node);
  }
  for (const o of orphans) {
    const node = makeWorktreeNode(
      { kind: 'orphan', absPath: o.path, source: o.folder },
      repo,
      grouped,
      base,
    );
    put(o.folder, node);
  }

  own.sort(byLabel);
  if (!grouped) {
    const rest = [...sourced.values()].flat().sort(byLabel);
    return [mainNode, ...own, ...rest];
  }
  const groups = g.SOURCE_FOLDERS.filter((f) => (sourced.get(f) ?? []).length > 0).map(
    (f) => new GroupNode(repo.commonDir, f, sourced.get(f)!.sort(byLabel)),
  );
  return [mainNode, ...own, ...groups];
}

export class WorktreeLensProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Called after each repo render with that repo's existing source-folder paths. */
  onSourceFolders: ((commonDir: string, paths: string[]) => void) | undefined;

  constructor(private readonly getRepos: () => Promise<RepoInfo[]>) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    return n;
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) {
      try {
        return (await this.getRepos()).map((r) => new RepoNode(r));
      } catch {
        return [];
      }
    }
    if (n instanceof RepoNode) {
      const grouped = vscode.workspace
        .getConfiguration('worktreeLens')
        .get('groupBySource', true);
      const children = await repoChildren(n.repo, grouped, (paths) =>
        this.onSourceFolders?.(n.repo.commonDir, paths),
      );
      return children;
    }
    if (n instanceof GroupNode) return n.items;
    return [];
  }
}
```

- [ ] **Step 2: Compile**

Run: `npx tsc -p .`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/tree.ts && git commit -m "feat: worktree tree data provider"
```

---

### Task 7: `src/extension.ts` — activation, commands, watchers

**Files:**
- Create: `src/extension.ts`

**Interfaces:**
- Consumes: `git-api.d.ts` types; `git.ts` functions (`gitCommonDir`, `listWorktrees`, `listBranches`, `resolveBase`, `addWorktree`, `removeWorktree`, `pruneWorktrees`, `addLocationCandidates`); `tree.ts` (`RepoInfo`, `RepoNode`, `WorktreeNode`, `WorktreeLensProvider`).
- Produces: `activate(context)` — the extension entry point (`main` in package.json → `out/src/extension.js`).

- [ ] **Step 1: Write `src/extension.ts`**

```ts
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as g from './git';
import type { GitApi, GitExtension, Repository } from './git-api';
import { RepoInfo, RepoNode, WorktreeLensProvider, WorktreeNode } from './tree';

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function trimErr(e: unknown): string {
  return e instanceof Error ? e.message.trim() : String(e);
}

/** Groups open repositories by git-common-dir → one RepoInfo per real repo (spec §3). */
async function discoverRepos(api: GitApi): Promise<RepoInfo[]> {
  const gitPath = api.git.path;
  const openFolders = new Set(
    (vscode.workspace.workspaceFolders ?? []).map((f) => realpathSafe(f.uri.fsPath)),
  );
  const groupedByCommon = new Map<string, string>(); // commonDir → a repo fsPath
  for (const r of api.repositories) {
    try {
      const common = await g.gitCommonDir(gitPath, r.rootUri.fsPath);
      if (!groupedByCommon.has(common)) groupedByCommon.set(common, r.rootUri.fsPath);
    } catch {
      // repo is being closed or is broken → skipped
    }
  }
  const infos: RepoInfo[] = [];
  for (const [commonDir, fsPath] of groupedByCommon) {
    let mainPath = fsPath;
    let name = path.basename(fsPath);
    try {
      const main = (await g.listWorktrees(gitPath, fsPath)).find((e) => !e.bare);
      if (main) {
        mainPath = main.path;
        name = path.basename(main.path);
      }
    } catch {
      // leave fsPath fallback; repoChildren will surface the error node
    }
    infos.push({ commonDir, name, mainPath, gitPath, openFolders });
  }
  return infos;
}

const cfg = () => vscode.workspace.getConfiguration('worktreeLens');

export function activate(context: vscode.ExtensionContext): void {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return;
  const api = ext.exports.getAPI(1);

  const provider = new WorktreeLensProvider(() => discoverRepos(api));
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('worktreeLens', provider),
  );

  let timer: NodeJS.Timeout | undefined;
  const debouncedRefresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 300);
  };

  // Built-in Git events (spec §5.7)
  const repoSubs = new Map<string, vscode.Disposable>();
  const subscribeRepo = (r: Repository) => {
    const key = r.rootUri.fsPath;
    if (!repoSubs.has(key)) repoSubs.set(key, r.state.onDidChange(debouncedRefresh));
    debouncedRefresh();
  };
  for (const r of api.repositories) subscribeRepo(r);
  context.subscriptions.push(api.onDidOpenRepository(subscribeRepo));
  context.subscriptions.push(
    api.onDidCloseRepository(async (r) => {
      repoSubs.get(r.rootUri.fsPath)?.dispose();
      repoSubs.delete(r.rootUri.fsPath);
      const alive = new Set((await discoverRepos(api)).map((i) => i.commonDir));
      for (const k of [...foldersByRepo.keys()]) if (!alive.has(k)) foldersByRepo.delete(k);
      reconcileWatchers();
      debouncedRefresh();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(debouncedRefresh),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('worktreeLens')) provider.refresh();
    }),
  );

  // Source-folder watchers, keyed by absolute folder path (spec §5.7)
  const foldersByRepo = new Map<string, Set<string>>();
  const watchers = new Map<string, vscode.FileSystemWatcher>();
  function reconcileWatchers(): void {
    const want = new Set([...foldersByRepo.values()].flatMap((s) => [...s]));
    for (const [p, w] of watchers) {
      if (!want.has(p)) {
        w.dispose();
        watchers.delete(p);
      }
    }
    for (const p of want) {
      if (!watchers.has(p)) {
        const w = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(p), '*'),
        );
        w.onDidCreate(debouncedRefresh);
        w.onDidDelete(debouncedRefresh);
        watchers.set(p, w);
        context.subscriptions.push(w);
      }
    }
  }
  provider.onSourceFolders = (commonDir, paths) => {
    foldersByRepo.set(commonDir, new Set(paths));
    reconcileWatchers();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('worktreeLens.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('worktreeLens.viewAsTree', () =>
      cfg().update('groupBySource', true, vscode.ConfigurationTarget.Global),
    ),
    vscode.commands.registerCommand('worktreeLens.viewAsList', () =>
      cfg().update('groupBySource', false, vscode.ConfigurationTarget.Global),
    ),
    vscode.commands.registerCommand('worktreeLens.open', (n: WorktreeNode) =>
      openFolder(n, false),
    ),
    vscode.commands.registerCommand('worktreeLens.openNewWindow', (n: WorktreeNode) =>
      openFolder(n, true),
    ),
    vscode.commands.registerCommand('worktreeLens.add', (n?: RepoNode) =>
      addWorktreeCmd(api, provider, n),
    ),
    vscode.commands.registerCommand('worktreeLens.remove', (n: WorktreeNode) =>
      removeWorktreeCmd(api, provider, n),
    ),
  );
}

function openFolder(n: WorktreeNode, newWindow: boolean): void {
  vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(n.wtPath), {
    forceNewWindow: newWindow,
  });
}

/** Spec §6 add flow: repo → branch → (name) → location → path → git → refresh. */
async function addWorktreeCmd(
  api: GitApi,
  provider: WorktreeLensProvider,
  node?: RepoNode,
): Promise<void> {
  const git = api.git.path;
  let repo = node?.repo;
  if (!repo) {
    const repos = await discoverRepos(api);
    if (repos.length === 0) return;
    repo =
      repos.length === 1
        ? repos[0]
        : (
            await vscode.window.showQuickPick(
              repos.map((r) => ({ label: r.name, repo: r })),
              { placeHolder: 'Repository for the new worktree' },
            )
          )?.repo;
    if (!repo) return;
  }
  const main = repo.mainPath;

  // Branch quick pick — omit branches already checked out in any worktree.
  const entries = await g.listWorktrees(git, main);
  const checkedOut = new Set(entries.flatMap((e) => (e.branch ? [e.branch] : [])));
  const { local, remote } = await g.listBranches(git, main);
  type Pick = vscode.QuickPickItem & { isNew?: boolean; branch?: string };
  const items: Pick[] = [{ label: '$(add) Create new branch…', isNew: true }];
  for (const b of local) if (!checkedOut.has(b)) items.push({ label: b, branch: b });
  for (const r of remote) {
    const short = r.slice(r.indexOf('/') + 1); // show 'origin/x', pass 'x' to git
    if (!local.includes(short) && !checkedOut.has(short)) {
      items.push({ label: r, branch: short });
    }
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Branch for the new worktree',
  });
  if (!pick) return;

  let branch: string;
  let isNew = false;
  if (pick.isNew) {
    const name = await vscode.window.showInputBox({ prompt: 'New branch name' });
    if (!name) return;
    branch = name;
    isNew = true;
  } else {
    branch = pick.branch!;
  }

  // Location quick pick — skipped when no source folder exists (only Default).
  const template = cfg().get('pathTemplate', '../${repo}.worktrees/${branch}');
  const candidates = await g.addLocationCandidates(repo.name, main, template, branch);
  let chosen = candidates[0].wtPath;
  if (candidates.length > 1) {
    const loc = await vscode.window.showQuickPick(
      candidates.map((c) => ({ label: c.label, description: c.wtPath })),
      { placeHolder: 'Worktree location' },
    );
    if (!loc) return;
    chosen = loc.description!;
  }
  const input = await vscode.window.showInputBox({
    prompt: 'Worktree path, resolved relative to the main worktree',
    value: chosen,
  });
  if (!input) return;
  const target = path.resolve(main, input);

  try {
    if (isNew) {
      const base = (await g.resolveBase(git, main)) ?? 'HEAD';
      await g.addWorktree(git, main, target, { newBranch: branch, base });
    } else {
      await g.addWorktree(git, main, target, { branch });
    }
  } catch (e) {
    vscode.window.showErrorMessage(trimErr(e));
    return;
  }
  provider.refresh();
}

/** Spec §6 remove flow by node kind. */
async function removeWorktreeCmd(
  api: GitApi,
  provider: WorktreeLensProvider,
  node: WorktreeNode,
): Promise<void> {
  const git = api.git.path;
  try {
    if (node.orphan) {
      const ok = await vscode.window.showWarningMessage(
        `Delete folder '${path.basename(node.wtPath)}'? Git doesn't track it as a worktree.`,
        { modal: true },
        'Move to Trash',
      );
      if (ok !== 'Move to Trash') return;
      await vscode.workspace.fs.delete(vscode.Uri.file(node.wtPath), {
        recursive: true,
        useTrash: true,
      });
    } else if (node.missing) {
      const ok = await vscode.window.showWarningMessage(
        `Remove worktree '${node.label}' and delete its folder?`,
        { modal: true },
        'Remove',
      );
      if (ok !== 'Remove') return;
      await g.pruneWorktrees(git, node.repo.mainPath);
    } else {
      const ok = await vscode.window.showWarningMessage(
        `Remove worktree '${node.label}' and delete its folder?`,
        { modal: true },
        'Remove',
      );
      if (ok !== 'Remove') return;
      try {
        await g.removeWorktree(git, node.repo.mainPath, node.wtPath);
      } catch (e) {
        if (!trimErr(e).includes('modified or untracked')) throw e;
        const force = await vscode.window.showWarningMessage(
          'Worktree is dirty. Force remove?',
          { modal: true },
          'Force Remove',
        );
        if (force !== 'Force Remove') return;
        await g.removeWorktree(git, node.repo.mainPath, node.wtPath, true);
      }
    }
  } catch (e) {
    vscode.window.showErrorMessage(trimErr(e));
    return;
  }
  provider.refresh();
}

export function deactivate(): void {}
```

- [ ] **Step 2: Compile**

Run: `npx tsc -p .`
Expected: clean.

- [ ] **Step 3: Smoke — Extension Development Host**

F5 → open a Git repo → Source Control sidebar shows **Worktrees** view with the repo root and main worktree carrying `@`.

Expected: view renders, `@` on the main worktree.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts && git commit -m "feat: activation, commands, watchers, debounced refresh"
```

---

### Task 8: Package and verify

**Files:**
- Modify: none (verify only)

- [ ] **Step 1: Package**

Run: `make package`
Expected: `worktree-lens-0.1.0.vsix` produced; no vsce errors about missing `main` entry.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: 14 tests PASS.

- [ ] **Step 3: Manual checklist in Extension Development Host** (spec §8)

Verify each in the dev-host window:

- [ ] Single repo: main worktree shows `@`.
- [ ] Add with new branch → node appears at templated path.
- [ ] Stage a file in an open worktree → `+` appears without pressing refresh.
- [ ] Open / open in new window.
- [ ] Remove clean worktree; dirty → force prompt.
- [ ] Delete a worktree folder by hand → `missing`; remove → pruned.
- [ ] `git worktree add .claude/worktrees/x` in terminal → appears under `.claude/worktrees` group without refresh.
- [ ] `mkdir .claude/worktrees/ghost` → shown `unregistered`; remove → folder in trash.
- [ ] Toggle list/tree; expand a group, refresh, expansion survives (stable ids).
- [ ] Multi-root: two worktrees of same repo → one root node.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: package worktree-lens 0.1.0"
```

---

## Self-Review Notes

- **Spec coverage:** contributions/menus/config (package.json — already scaffolded), git layer (Tasks 2–5), tree render §5 (Task 6), commands/watchers §5.7+§6 (Task 7), packaging (Task 8). Error handling §7 is inside each task's code (ErrorNode, silent status, trimmed stderr, trash-only delete).
- **Deliberate deviations from spec to flag:** none beyond §2's own list; `getStatus` returns numeric `ahead`/`unpushed` (0 = hidden) so the tooltip can word the count.
- **Type consistency:** `RepoInfo`, `WorktreeNode.{wtPath,missing,orphan,repo}`, `SourceFolder.{folder,tag,icon}` used identically in Tasks 6–7.
