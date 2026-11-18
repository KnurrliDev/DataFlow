import * as path from 'path';
import * as vscode from 'vscode';
import { UPDATE_PUBLIC_KEY } from './release';
import { UpdateMode, Updater, UpdaterUi } from './updater';

// The first check comes after the start of the window, and the timer looks for work in each half hour
export const START_DELAY_MS = 60000;
const TICK_MS = 30 * 60 * 1000;

const NOTES = 'Release Notes';
const openNotes = (url: string) => vscode.env.openExternal(vscode.Uri.parse(url));

const ui: UpdaterUi = {
	askToUpdate: async (version, running, notesUrl) => {
		for (;;) {
			const answer = await vscode.window.showInformationMessage(`DataFlow ${version} is available. You have version ${running}.`,
				'Update', NOTES, 'Skip This Version');
			if (answer !== NOTES) {
				return answer === 'Update' ? 'update' : answer === 'Skip This Version' ? 'skip' : undefined;
			}
			await openNotes(notesUrl);
		}
	},
	offerReload: async (version, notesUrl) => {
		for (;;) {
			const answer = await vscode.window.showInformationMessage(`DataFlow ${version} is installed. Reload the window to use it.`, 'Reload', NOTES);
			if (answer !== NOTES) {
				if (answer === 'Reload') {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
				return;
			}
			await openNotes(notesUrl);
		}
	},
	progress: (title, work) => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, work)),
	info: (message) => void vscode.window.showInformationMessage(message),
	warn: (message) => void vscode.window.showWarningMessage(message),
};

// A user or a policy that turns off the automatic updates of extensions gets a question before an install
function updateMode(): UpdateMode {
	const mode = vscode.workspace.getConfiguration('dataflow').get<UpdateMode>('update.mode', 'auto');
	return mode === 'auto' && vscode.workspace.getConfiguration('extensions').get('autoUpdate') === false ? 'ask' : mode;
}

// The updates of an installed package. The extension of a development host or of a test does not update itself
export function startUpdater(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
	const isInstalled = context.extensionMode === vscode.ExtensionMode.Production;
	const updater = new Updater({
		version: String(context.extension.packageJSON.version),
		platform: `${process.platform}-${process.arch}`,
		publicKey: UPDATE_PUBLIC_KEY,
		storageDir: path.join(context.globalStorageUri.fsPath, 'update'),
		mode: updateMode,
		fetch: (input, init) => fetch(input, init),
		install: async (vsix) => {
			await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsix));
		},
		ui,
		log,
		now: () => Date.now(),
	});
	context.subscriptions.push(vscode.commands.registerCommand('dataflow.checkForUpdates', async () => {
		if (isInstalled) {
			await updater.check(true);
		} else {
			void vscode.window.showInformationMessage('Only an installed package of DataFlow updates itself. This window runs DataFlow from its source code.');
		}
	}));
	if (!isInstalled) {
		return;
	}
	const tick = () => void updater.tick().catch((error) => log.warn(`The update of DataFlow failed: ${String(error)}`));
	const first = setTimeout(tick, START_DELAY_MS);
	const timer = setInterval(tick, TICK_MS);
	context.subscriptions.push({ dispose: () => { clearTimeout(first); clearInterval(timer); } });
}
