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
