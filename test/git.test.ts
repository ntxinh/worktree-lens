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
