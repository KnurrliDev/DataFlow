import * as vscode from 'vscode';

// The target branch of Change Ripple is the branch that the active branch merges into. The user selects it with Target
// in the Change Ripple bar. DataFlow keeps the target branch of each branch of a repository. With no target branch of
// the user, DataFlow tries the candidates of targetCandidates.

// An item of the list of target branches. A separator has no ref. The ref of Automatic is ''.
export interface TargetItem extends vscode.QuickPickItem {
	ref?: string;
}

// The targets that DataFlow tries if the user selected no target branch, in this sequence: the ref of the setting
// dataflow.ripple.baseRef, the branch that the active branch comes from, the default branch of the remote, then main and
// master. If the ref of the setting starts with origin/, its local branch comes after it, for a repository with no
// remote. branchBase is the branch that VS Code noted when it made the active branch.
export function targetCandidates(setting: string, defaultBranch: string | undefined, branchBase?: string): string[] {
	const fromSetting = setting ? [setting, ...(setting.startsWith('origin/') ? [setting.slice('origin/'.length)] : [])] : [];
	return [...new Set([...fromSetting, ...(branchBase ? [branchBase] : []), ...(defaultBranch ? [defaultBranch] : []),
		'origin/main', 'main', 'origin/master', 'master'])];
}

// The list of target branches: Automatic, the default branch of the remote and HEAD, then the local and the remote
// branches. The active branch is not in the list, because it gives the same diff as HEAD. The selected item has a mark.
export function targetItems(branches: { local: string[]; remote: string[] }, active: string | undefined, defaultBranch: string | undefined,
	selected: string | undefined): TargetItem[] {
	const item = (ref: string, label: string, description = ''): TargetItem => ({
		ref, label, description: [description, ref === (selected ?? '') ? 'selected' : ''].filter(Boolean).join(' · '),
	});
	const separator = (label: string): TargetItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
	const local = branches.local.filter((b) => b !== active && b !== defaultBranch).map((b) => item(b, `$(git-branch) ${b}`));
	const remote = branches.remote.filter((b) => b !== defaultBranch).map((b) => item(b, `$(cloud) ${b}`));
	return [
		item('', '$(sparkle) Automatic', 'the branch that this branch comes from, the default branch of the remote, or main or master'),
		...(defaultBranch ? [item(defaultBranch, `$(git-branch) ${defaultBranch}`, 'the default branch of the remote')] : []),
		item('HEAD', '$(git-commit) HEAD', 'only the changes that are not committed'),
		...(local.length > 0 ? [separator('Local branches'), ...local] : []),
		...(remote.length > 0 ? [separator('Remote branches'), ...remote] : []),
	];
}
