import * as path from 'path';
import * as vscode from 'vscode';
import { functionTitle } from './side/names';
import { DataFlowState, StateStore } from './state/store';

// Shows the state of DataFlow in the status bar. A click opens the side view.
export class StatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('dataflow.status', vscode.StatusBarAlignment.Left, 50);
	private readonly subscriptions: vscode.Disposable[];

	constructor(store: StateStore) {
		this.item.name = 'DataFlow';
		this.item.command = 'dataflow.openSideView';
		this.subscriptions = [store.onDidChange((state) => this.render(state))];
		this.render(store.state);
		this.item.show();
	}

	dispose(): void {
		this.subscriptions.forEach((s) => s.dispose());
		this.item.dispose();
	}

	private render(state: DataFlowState): void {
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.appendMarkdown(`**DataFlow** — engine: ${state.engine}`);
		if (state.clangVersion) {
			tooltip.appendMarkdown(`  \n${state.clangVersion}`);
		}
		if (state.project) {
			tooltip.appendMarkdown(`  \nProject: ${state.project.name} (\`${state.project.root}\`)`);
		}
		for (const db of state.databases) {
			tooltip.appendMarkdown(`  \nCompile database (${db.source}): \`${db.makefile ?? db.path}\``);
		}

		if (state.engine === 'failed') {
			this.item.text = '$(error) DataFlow';
			tooltip.appendMarkdown(`  \n${state.message ?? 'The engine stopped. See the DataFlow log.'}`);
		} else if (state.databases.length === 0 && state.engine !== 'starting') {
			this.item.text = '$(warning) DataFlow: no compile database';
		} else if (state.parsing.length > 0) {
			this.item.text = `$(sync~spin) DataFlow: parsing ${path.basename(state.parsing[0])}`;
		} else if (state.fn) {
			this.item.text = `$(symbol-function) ${functionTitle(state.fn)}`;
			tooltip.appendMarkdown(`  \n\`${state.fn.qualifiedName}\`, lines ${state.fn.range.begin.line} to ${state.fn.range.end.line}`);
			if (state.parseMs !== undefined) {
				tooltip.appendMarkdown(`  \nParse: ${Math.round(state.parseMs)} ms, ${state.errorCount ?? 0} errors`);
			}
		} else {
			this.item.text = '$(pulse) DataFlow';
		}
		this.item.tooltip = tooltip;
	}
}
