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
