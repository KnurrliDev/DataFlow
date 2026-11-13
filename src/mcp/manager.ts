import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { StateStore } from '../state/store';
import { registryDir, WindowEntry, windowFileName } from './bridge';
import type { ExtensionTools } from './extensionTools';
import {
	claudeSettingsFile, ClaudeConnection, connectionOf, connectSettings, disconnectSettings, marketplaceDir, marketplacePathOf, readText,
	removePlugin, writePlugin, writeTextAtomic, writeToken,
} from './claude';
import { McpPrompt, McpServer, McpTool } from './server';
import { INSTRUCTIONS } from './tools';

// The MCP server of DataFlow in a VS Code window: it starts and stops the server, keeps the token, gives the server to
// the agent mode of VS Code, and makes the setups for the clients. While the server runs, the window has a file in the
// registry of the bridge, so a client that starts the bridge finds the window of its project.

const TOKEN_KEY = 'dataflow.mcp.token';
const PROVIDER_ID = 'dataflow.mcp';
const PATH = '/mcp';
export const DEFAULT_MCP_PORT = 47321;

export class McpManager implements vscode.Disposable {
	private server?: McpServer;
	private token?: string;
	private starting?: Promise<void>;
	private focused = vscode.window.state.focused ? Date.now() : 0; // the time of the last focus of the window
	private entry = ''; // the text of the file of the window in the registry
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private readonly disposables: vscode.Disposable[] = [this.changeEmitter];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: StateStore,
		private readonly log: vscode.LogOutputChannel,
		private readonly tools: McpTool[],
		private readonly prompts: McpPrompt[],
		private readonly folders: () => string[], // the workspace folders and the folder of the project
		private readonly extensionTools?: ExtensionTools, // the tools that other extensions add with the API
	) {
		// the registry has the folders of the window and its last focus
		this.disposables.push(
			vscode.window.onDidChangeWindowState((state) => {
				if (state.focused) {
					this.focused = Date.now();
					this.writeEntry();
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.writeEntry()),
			store.onDidChange(() => this.writeEntry()),
		);
		// a change of the tools of the extensions: the registry gets the new number of the lists, so the bridge tells its
		// client, and the agent mode of VS Code gets a new version of the server
		if (extensionTools) {
			this.disposables.push(extensionTools.onDidChange(() => {
				this.writeEntry();
				this.changeEmitter.fire();
			}));
		}
		// VS Code starts the server when its agent mode needs it. The user agrees to the start in VS Code
		this.disposables.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
			onDidChangeMcpServerDefinitions: this.changeEmitter.event,
			provideMcpServerDefinitions: async () => [await this.definition()],
			resolveMcpServerDefinition: async (server) => {
				await this.start();
				if (server instanceof vscode.McpHttpServerDefinition) {
					server.uri = vscode.Uri.parse(this.server!.url);
					server.headers = { ...server.headers, Authorization: `Bearer ${await this.getToken()}` };
				}
				return server;
			},
		}));
	}

	get isRunning(): boolean {
		return !!this.server?.isRunning;
	}

	// The address of the running server
	get url(): string | undefined {
		return this.server?.isRunning ? this.server.url : undefined;
	}

	// The client that connected last
	get clientName(): string | undefined {
		return this.server?.client?.name;
	}

	// The token in the header Authorization. It stays the same in all windows and after a restart, so the setup of a
	// client stays correct. The secret storage of VS Code keeps it.
	async getToken(): Promise<string> {
		if (this.token) {
			return this.token;
		}
		let token: string | undefined;
		try {
			token = await this.context.secrets.get(TOKEN_KEY);
			if (!token) {
				token = randomBytes(24).toString('base64url');
				await this.context.secrets.store(TOKEN_KEY, token);
			}
		} catch (error) {
			// no secret storage, for example in a test without a keyring
			this.log.warn(`The secret storage is not available, so the MCP token is only for this window: ${error}`);
			token = randomBytes(24).toString('base64url');
		}
		this.token = token;
		return token;
	}

	start(): Promise<void> {
		this.starting ??= this.startNow().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.removeEntry();
		await server?.stop();
		if (server) {
			this.log.info('The MCP server stopped.');
		}
		this.store.update({ mcp: { state: 'off' } });
		this.changeEmitter.fire();
	}

	// The setups of the clients. bridge: the command that adds the bridge to Claude Code for all projects. http: the
	// command that adds the address of this window. json: the server of a client that starts programs, for example
	// Claude Desktop
	async setups(): Promise<{ bridge: string; http: string; json: string }> {
		await this.start();
		const token = await this.getToken();
		const bridge = this.installBridge();
		return {
			bridge: `claude mcp add --transport stdio --scope user --env DATAFLOW_TOKEN=${token} dataflow -- node "${bridge}"`,
			http: `claude mcp add --transport http dataflow ${this.server!.url} --header "Authorization: Bearer ${token}"`,
			json: JSON.stringify({ mcpServers: { dataflow: { command: 'node', args: [bridge], env: { DATAFLOW_TOKEN: token } } } }, null, 2),
		};
	}

	// The connection to Claude Code, from the settings of Claude Code
	claudeConnection(): ClaudeConnection {
		return connectionOf(readText(claudeSettingsFile()));
	}

	// Connects Claude Code: the server starts, and the plugin and the token file get the data of the server. The
	// settings of Claude Code name the marketplace of DataFlow and turn its plugin on. Their other keys stay as they are
	async connectClaude(): Promise<void> {
		await this.start();
		this.writeClaudeFiles(await this.getToken());
		const file = claudeSettingsFile();
		writeTextAtomic(file, connectSettings(readText(file), marketplaceDir(registryDir())));
		this.log.info(`DataFlow is connected to Claude Code in ${file}.`);
	}

	// Removes the marketplace and the plugin from the settings of Claude Code, and the files of the plugin. False if the
	// settings had no connection
	disconnectClaude(): boolean {
		const file = claudeSettingsFile();
		const text = disconnectSettings(readText(file));
		if (text !== undefined) {
			writeTextAtomic(file, text);
			this.log.info(`DataFlow is no longer connected to Claude Code in ${file}.`);
		}
		removePlugin(registryDir());
		return text !== undefined;
	}

	// At the start of DataFlow: with a connection, the server runs, and the plugin gets the program of this VS Code and
	// the token. The settings get the marketplace folder of this registry if they name a different one
	async refreshClaude(): Promise<void> {
		if (this.claudeConnection() !== 'connected') {
			return;
		}
		await this.start();
		this.writeClaudeFiles(await this.getToken());
		const file = claudeSettingsFile();
		const text = readText(file);
		const dir = marketplaceDir(registryDir());
		const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
		if (key(marketplacePathOf(text) ?? '') !== key(dir)) {
			writeTextAtomic(file, connectSettings(text, dir));
		}
	}

	async copySetup(onConnect: () => Promise<void>): Promise<void> {
		const setups = await this.setups();
		const pick = await vscode.window.showQuickPick([
			{
				label: 'Claude Code: connect with no setup',
				detail: 'DataFlow adds a local plugin to the settings of Claude Code. All projects and windows, with no command.',
				text: '',
			},
			{
				label: 'Claude Code: all projects and windows',
				detail: 'A command. Claude Code starts the bridge of DataFlow, and the bridge finds the window of the project.',
				text: setups.bridge,
			},
			{ label: 'Claude Code: this window only', detail: `A command with the address ${this.server!.url}.`, text: setups.http },
			{
				label: 'JSON for a client that starts programs',
				detail: 'For example for claude_desktop_config.json of Claude Desktop. The bridge takes the window of the folder of the client, else the window that had the focus last.',
				text: setups.json,
			},
		], { title: 'Copy the MCP setup of DataFlow' });
		if (!pick) {
			return;
		}
		if (!pick.text) {
			await onConnect();
			return;
		}
		await vscode.env.clipboard.writeText(pick.text);
		void vscode.window.showInformationMessage('The setup is on the clipboard. The agent mode of VS Code finds the server without setup.');
	}

	dispose(): void {
		void this.stop();
		this.disposables.forEach((d) => d.dispose());
	}

	// The bridge, the plugin and the token for Claude Code. VS Code itself runs the bridge as Node.js
	private writeClaudeFiles(token: string): void {
		this.installBridge();
		writePlugin(registryDir(), process.execPath, String(this.context.extension.packageJSON.version ?? ''));
		writeToken(registryDir(), token);
	}

	// Copies the bridge into the registry folder if it is missing or different, and returns its path. The path stays the
	// same after an update of the extension, so the setup of a client stays correct
	private installBridge(): string {
		const target = path.join(registryDir(), 'bridge.js');
		const text = readFileSync(this.context.asAbsolutePath(path.join('out', 'mcp', 'bridge.js')), 'utf8')
			.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
		let current = '';
		try {
			current = readFileSync(target, 'utf8');
		} catch {
			// no bridge yet
		}
		if (current !== text) {
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, text);
		}
		return target;
	}

	// The file of this window in the registry, while the server runs
	private writeEntry(): void {
		const server = this.server;
		if (!server?.isRunning) {
			return;
		}
		const lists = this.extensionTools?.lists ?? 0;
		const entry: WindowEntry = { pid: process.pid, url: server.url, folders: this.folders(), focused: this.focused, ...(lists > 0 ? { lists } : {}) };
		const text = JSON.stringify(entry);
		if (text === this.entry) {
			return;
		}
		try {
			mkdirSync(registryDir(), { recursive: true });
			writeFileSync(path.join(registryDir(), windowFileName(process.pid)), text);
			this.entry = text;
		} catch (error) {
			this.log.warn(`The registry of the MCP bridge is not available: ${error}`);
		}
	}

	private removeEntry(): void {
		this.entry = '';
		try {
			unlinkSync(path.join(registryDir(), windowFileName(process.pid)));
		} catch {
			// no file
		}
	}

	private port(): number {
		const port = vscode.workspace.getConfiguration('dataflow').get<number>('mcp.port', DEFAULT_MCP_PORT);
		return Number.isInteger(port) && port >= 0 && port < 65536 ? port : DEFAULT_MCP_PORT;
	}

	private async definition(): Promise<vscode.McpHttpServerDefinition> {
		const url = this.server?.isRunning ? this.server.url : `http://127.0.0.1:${this.port()}${PATH}`;
		// a new version tells VS Code that the tools changed
		const lists = this.extensionTools?.lists ?? 0;
		const version = `${String(this.context.extension.packageJSON.version ?? '')}${lists > 0 ? `+tools.${lists}` : ''}`;
		return new vscode.McpHttpServerDefinition('DataFlow', vscode.Uri.parse(url), { Authorization: `Bearer ${await this.getToken()}` }, version);
	}

	private async startNow(): Promise<void> {
		if (this.server?.isRunning) {
			return;
		}
		const server = new McpServer({
			port: this.port(),
			path: PATH,
			token: await this.getToken(),
			name: 'dataflow',
			title: 'DataFlow',
			version: String(this.context.extension.packageJSON.version ?? ''),
			instructions: INSTRUCTIONS,
			tools: () => (this.extensionTools ? [...this.tools, ...this.extensionTools.list()] : this.tools),
			prompts: this.prompts,
			log: (text) => this.log.warn(text),
			onClient: (client) => {
				this.log.info(`MCP: ${client.name} ${client.version} connected.`);
				this.updateState();
			},
		});
		try {
			await server.start();
		} catch (error) {
			this.store.update({ mcp: { state: 'failed', error: String(error) } });
			this.log.error(`The MCP server did not start: ${error}`);
			throw error;
		}
		this.server = server;
		this.log.info(`The MCP server runs on ${server.url}.`);
		this.updateState();
		this.changeEmitter.fire();
		// a new version of the extension updates the bridge of the setups that the user made before
		try {
			this.installBridge();
		} catch (error) {
			this.log.warn(`The MCP bridge is not available: ${error}`);
		}
		this.writeEntry();
	}

	private updateState(): void {
		const server = this.server;
		this.store.update({ mcp: server?.isRunning ? { state: 'on', url: server.url, client: server.client?.name } : { state: 'off' } });
	}
}
