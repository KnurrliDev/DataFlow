import type { FromSide, SideViewState } from '../side/protocol';

// The API that VS Code gives to the script of a webview
interface VsCodeApi {
	postMessage(message: FromSide): void;
	getState(): SideViewState | undefined;
	setState(state: SideViewState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

// The script can call acquireVsCodeApi only one time
export const vscode = acquireVsCodeApi();
