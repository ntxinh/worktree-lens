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
