import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TOKEN_FILE } from './bridge';

// The connection to Claude Code with no MCP setup. Claude Code has no API for other extensions, so DataFlow uses two
// documented settings of Claude Code: a plugin marketplace in a local folder (extraKnownMarketplaces), and a plugin of
// this marketplace that is on (enabledPlugins). The plugin has one MCP server, the bridge of DataFlow. The bridge finds
// the window of the project, and it reads the token from a file in the registry folder. Claude Code loads a plugin of
// a local folder in place, so the plugin needs no install. All Claude Code clients read the settings: the VS Code
// extension, the terminal and the desktop app.
// These functions do not use the VS Code API, so the unit tests and the scripts can call them.

export const MARKETPLACE_NAME = 'dataflow-vscode';
export const PLUGIN_NAME = 'dataflow';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

// connected: the plugin is on. disabled: the user turned the plugin off in Claude Code, or removed a part of the
// connection. none: no connection
export type ClaudeConnection = 'connected' | 'disabled' | 'none';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

// The folder of the settings of Claude Code. CLAUDE_CONFIG_DIR moves it
export function claudeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function claudeSettingsFile(): string {
	return path.join(claudeConfigDir(), 'settings.json');
}

// The folder of the marketplace, in the registry folder of the bridge
export function marketplaceDir(registry: string): string {
	return path.join(registry, 'claude');
}

// The file with the token of the MCP server, for the bridge that the plugin starts
export function tokenFile(registry: string): string {
	return path.join(registry, TOKEN_FILE);
}

// The files of the marketplace and of its plugin, by their paths in the marketplace folder. runtime runs the bridge:
// VS Code itself as Node.js, with ELECTRON_RUN_AS_NODE, so the user needs no Node.js. The registry folder goes to the
// bridge in its environment, because Claude Code can give a server only a part of its own environment
export function pluginFiles(registry: string, runtime: string, version: string): Record<string, string> {
	const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
	const description = 'The C++ analysis of the DataFlow extension of VS Code: data flow, logic, calls, threads, hidden C++, '
		+ 'includes, and the side view';
	return {
		[path.join('.claude-plugin', 'marketplace.json')]: text({
			name: MARKETPLACE_NAME,
			owner: { name: 'DataFlow' },
			description: 'The plugin of the DataFlow extension of VS Code. DataFlow writes this folder.',
			plugins: [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}`, description }],
		}),
		[path.join('plugins', PLUGIN_NAME, '.claude-plugin', 'plugin.json')]: text({
			name: PLUGIN_NAME,
			displayName: 'DataFlow',
			version,
			description,
			author: { name: 'DataFlow' },
			mcpServers: {
				dataflow: {
					command: runtime,
					args: [path.join(registry, 'bridge.js')],
					env: { ELECTRON_RUN_AS_NODE: '1', DATAFLOW_MCP_REGISTRY: registry },
				},
			},
		}),
	};
}

// The settings as an object. No text gives an empty object, and text that is not a JSON object throws
function parseSettings(text: string | undefined): Json {
	if (!text || text.trim() === '') {
		return {};
	}
	const value: unknown = JSON.parse(text);
	if (!isObject(value)) {
		throw new Error('The settings of Claude Code are not a JSON object.');
	}
	return value;
}

// The text of the settings with the indent and the line ends of the old text
function formatSettings(settings: Json, old: string | undefined): string {
	const indent = old ? /\n([ \t]+)"/.exec(old)?.[1] ?? '  ' : '  ';
	const eol = old?.includes('\r\n') ? '\r\n' : '\n';
	const text = JSON.stringify(settings, null, indent).replace(/\n/g, eol);
	return old && !/\r?\n$/.test(old) ? text : text + eol;
}

export function connectionOf(text: string | undefined): ClaudeConnection {
	let settings: Json;
	try {
		settings = parseSettings(text);
	} catch {
		return 'none';
	}
	const isDeclared = isObject(settings.extraKnownMarketplaces) && MARKETPLACE_NAME in settings.extraKnownMarketplaces;
	const enabled = isObject(settings.enabledPlugins) ? settings.enabledPlugins[PLUGIN_ID] : undefined;
	if (isDeclared && enabled === true) {
		return 'connected';
	}
	return isDeclared || enabled === false ? 'disabled' : 'none';
}

// The settings with the marketplace of DataFlow and its plugin on. The other keys stay as they are
export function connectSettings(text: string | undefined, dir: string): string {
	const settings = parseSettings(text);
	const markets = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
	markets[MARKETPLACE_NAME] = { source: { source: 'directory', path: dir } };
	settings.extraKnownMarketplaces = markets;
	const plugins = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
	plugins[PLUGIN_ID] = true;
	settings.enabledPlugins = plugins;
	return formatSettings(settings, text);
}

// The settings without the marketplace of DataFlow and its plugin, or undefined if they have neither. A key that has
// no other value then goes away
export function disconnectSettings(text: string | undefined): string | undefined {
	const settings = parseSettings(text);
	let isChanged = false;
	for (const [key, name] of [['extraKnownMarketplaces', MARKETPLACE_NAME], ['enabledPlugins', PLUGIN_ID]] as const) {
		const values = settings[key];
		if (isObject(values) && name in values) {
			delete values[name];
			isChanged = true;
			if (Object.keys(values).length === 0) {
				delete settings[key];
			}
		}
	}
	return isChanged ? formatSettings(settings, text) : undefined;
}

// The path of the marketplace of DataFlow in the settings, if they declare it
export function marketplacePathOf(text: string | undefined): string | undefined {
	try {
		const markets = parseSettings(text).extraKnownMarketplaces;
		const market = isObject(markets) ? markets[MARKETPLACE_NAME] : undefined;
		const source = isObject(market) ? market.source : undefined;
		return isObject(source) && typeof source.path === 'string' ? source.path : undefined;
	} catch {
		return undefined;
	}
}

//-------------------
// Files

export function readText(file: string): string | undefined {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

// Writes a file in one step: a different program that reads it sees the old text or the new text, never a part
export function writeTextAtomic(file: string, text: string, mode?: number): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.dataflow-${process.pid}.tmp`;
	writeFileSync(temp, text, mode === undefined ? undefined : { mode });
	renameSync(temp, file);
}

// Writes the files of the marketplace if they are different
export function writePlugin(registry: string, runtime: string, version: string): void {
	const dir = marketplaceDir(registry);
	for (const [name, text] of Object.entries(pluginFiles(registry, runtime, version))) {
		const file = path.join(dir, name);
		if (readText(file) !== text) {
			writeTextAtomic(file, text);
		}
	}
}

// The token for the bridge. Only the user can read the file on Linux and macOS. On Windows, the folder of the user
// keeps it private
export function writeToken(registry: string, token: string): void {
	const file = tokenFile(registry);
	if (readText(file) === token) {
		return;
	}
	writeTextAtomic(file, token, 0o600);
	try {
		chmodSync(file, 0o600);
	} catch {
		// a file system with no modes
	}
}

// Removes the marketplace folder and the token file
export function removePlugin(registry: string): void {
	rmSync(marketplaceDir(registry), { recursive: true, force: true });
	rmSync(tokenFile(registry), { force: true });
}
