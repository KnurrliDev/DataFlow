import * as path from 'path';
import * as vscode from 'vscode';
import type { CompileDbManager } from './cdb/manager';
import { DataFlowState, StateStore } from './state/store';

// The DataFlow view in the activity bar. It has the commands to open a file, a project and the side view, and the
// commands of the engine. The controls of the lenses are only in the side view.

// An item of the view: a command, or a group of items
export interface HomeItem {
	id: string;
	label: string;
	description?: string;
	tooltip?: string;
	icon: string; // the name of a codicon
	command?: string;
	arguments?: unknown[];
	children?: HomeItem[];
}

export interface HomeState {
	project?: { name: string; root: string };
	recent: { name: string; root: string }[]; // the last projects. The project of the window can be in the list
	engine: string;
	database?: { text: string; path: string }; // the first compile database: the path for the view, and the full path
}

export function homeItems(state: HomeState): HomeItem[] {
	const project = state.project;
	const recent = state.recent.filter((p) => p.root !== project?.root);
	return [
		{
			id: 'openFile', label: 'Open File…', icon: 'go-to-file', command: 'dataflow.openProjectFile', description: project?.name,
			tooltip: project ? `Open a C or C++ file of ${project.name} beside the side view` : 'Select a project, then open one of its C or C++ files',
		},
		{
			id: 'openFolder', label: 'Open Project Folder…', icon: 'folder-opened', command: 'dataflow.openProjectFolder',
			tooltip: 'Select the root folder of a project that is not open in VS Code. DataFlow finds its compile database. '
				+ 'The extensions that start for a folder do not start.',
		},
		...(recent.length > 0 ? [{
			id: 'recent', label: 'Recent Projects', icon: 'history',
			children: recent.map((p) => ({
				id: `recent:${p.root}`, label: p.name, description: p.root, tooltip: p.root, icon: 'folder',
				command: 'dataflow.openRecentProject', arguments: [p.root],
			})),
		}] : []),
		...(project ? [{ id: 'closeProject', label: 'Close Project', icon: 'close', command: 'dataflow.closeProject', description: project.name }] : []),
		{ id: 'openSideView', label: 'Open Side View', icon: 'open-preview', command: 'dataflow.openSideView', tooltip: 'Open the side view beside the editor' },
		{
			id: 'database', label: 'Compile Database', icon: 'database', command: 'dataflow.selectCompileCommands', description: state.database?.text ?? 'none',
			tooltip: state.database?.path ?? 'DataFlow found no compile database. Click to select one.',
		},
		{ id: 'log', label: 'Show Log', icon: 'output', command: 'dataflow.showLog' },
		{ id: 'restart', label: 'Restart Engine', icon: 'debug-restart', command: 'dataflow.restartEngine', description: state.engine },
	];
}

export class HomeView implements vscode.TreeDataProvider<HomeItem>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly subscriptions: vscode.Disposable[];
	private key = '';

	constructor(private readonly store: StateStore, private readonly cdb: CompileDbManager) {
		this.subscriptions = [store.onDidChange((state) => this.refresh(state)), this.emitter];
	}

	// The state of the view. The last projects come from all windows.
	get state(): HomeState {
		return this.stateOf(this.store.state);
	}

	getChildren(item?: HomeItem): HomeItem[] {
		return item ? item.children ?? [] : homeItems(this.state);
	}

	getTreeItem(item: HomeItem): vscode.TreeItem {
		const tree = new vscode.TreeItem(item.label, item.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		tree.id = item.id;
		tree.description = item.description;
		tree.tooltip = item.tooltip;
		tree.iconPath = new vscode.ThemeIcon(item.icon);
		if (item.command) {
			tree.command = { command: item.command, title: item.label, arguments: item.arguments };
		}
		return tree;
	}

	dispose(): void {
		this.subscriptions.forEach((s) => s.dispose());
	}

	private stateOf(state: DataFlowState): HomeState {
		const db = state.databases[0];
		const file = db && (db.makefile ?? db.path);
		return {
			project: state.project && { name: state.project.name, root: state.project.root },
			recent: this.cdb.recentProjects.map((p) => ({ name: p.name, root: p.root })),
			engine: state.engine,
			database: file ? { text: path.relative(db.folder, file) || file, path: file } : undefined,
		};
	}

	// The store changes often, for example with each move of the cursor. The view updates only when its state changes.
	private refresh(state: DataFlowState): void {
		const key = JSON.stringify(this.stateOf(state));
		if (key !== this.key) {
			this.key = key;
			this.emitter.fire();
		}
	}
}
