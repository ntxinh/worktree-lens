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
