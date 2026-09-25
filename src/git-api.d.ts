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
