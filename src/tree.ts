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
