import { readdirSync, readFileSync } from 'fs';
import { request } from 'http';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';

// The bridge between an MCP client that starts a local program and the MCP server of DataFlow in a VS Code window. A
// client, for example Claude Code or Claude Desktop, starts "node bridge.js" and sends the messages of the stdio
// transport: one JSON-RPC message on each line. The bridge sends each message to the server of a window and writes the
// reply on a line.
//   > each window that runs the server keeps a file in the registry folder, with the address and the folders of the
//     window. The bridge reads the files again for each message, so a new window and a reload of a window need no
//     restart of the client
//   > the window is the window whose folders have the folder of the client: the argument --folder, else the working
//     folder of the bridge. If no window has the folder, the bridge takes the window that had the focus last
//   > the token comes from the environment variable DATAFLOW_TOKEN, else from the token file of the registry folder,
//     which the connection to Claude Code writes
//   > after a change of the server, for example a reload of the window with a new version of DataFlow, the bridge tells
//     the client that the list of the tools changed. The client then asks for the list again (ListWatch). The same occurs
//     when an extension adds tools to the server or removes them: the window gives a new number of its lists
// This file needs only Node.js. The extension copies it into the registry folder, so the setup of a client stays
// correct after an update of the extension.

export interface WindowEntry {
	pid: number; // the process of the extension host of the window
	url: string; // the address of the server, for example http://127.0.0.1:47321/mcp
	folders: string[]; // the workspace folders and the folder of the project
	focused: number; // the time of the last focus of the window in ms, or 0
	lists?: number; // the number of the changes of the tools of the extensions. Undefined for 0
}

// The registry folder. It is not in AppData, because the Claude app on Windows redirects the files of AppData
export function registryDir(): string {
	return process.env.DATAFLOW_MCP_REGISTRY || path.join(os.homedir(), '.dataflow', 'mcp');
}

// The name of the file of a window in the registry folder
export function windowFileName(pid: number): string {
	return `window-${pid}.json`;
}

// The file in the registry folder with the token, for a client with no DATAFLOW_TOKEN. The connection to Claude Code
// writes it
export const TOKEN_FILE = 'token';

// The token: the variable DATAFLOW_TOKEN, else the token file of the registry folder, else no token
export function tokenOf(dir = registryDir()): string {
	if (process.env.DATAFLOW_TOKEN) {
		return process.env.DATAFLOW_TOKEN;
	}
	try {
		return readFileSync(path.join(dir, TOKEN_FILE), 'utf8').trim();
	} catch {
		return '';
	}
}

// The windows of the registry whose process runs
export function readWindows(dir = registryDir()): WindowEntry[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => /^window-\d+\.json$/.test(n));
	} catch {
		return [];
	}
	const out: WindowEntry[] = [];
	for (const name of names) {
		try {
			const entry = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as WindowEntry;
			if (typeof entry.url === 'string' && Array.isArray(entry.folders) && isRunning(entry.pid)) {
				out.push(entry);
			}
		} catch {
			// a file that a window writes at the same time, or a different file
		}
	}
	return out;
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

// true if the folder is the parent folder or a folder in it
function isInside(parent: string, folder: string): boolean {
	const rel = path.relative(parent, folder);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The window for a folder: the window with the longest folder that has the folder. Else the window with a folder in the
// folder, for example a part of a repository. Else the window that had the focus last
export function chooseWindow(windows: readonly WindowEntry[], folder: string): WindowEntry | undefined {
	const best = (score: (w: WindowEntry) => number): WindowEntry | undefined => {
		let out: WindowEntry | undefined;
		let max = 0;
		for (const w of windows) {
			const s = score(w);
			if (s > max || (s === max && s > 0 && out && w.focused > out.focused)) {
				out = w;
				max = s;
			}
		}
		return out;
	};
	return best((w) => Math.max(0, ...w.folders.filter((f) => isInside(f, folder)).map((f) => f.length)))
		?? best((w) => (w.folders.some((f) => isInside(folder, f)) ? 1 : 0))
		?? best((w) => w.focused + 1);
}

//-------------------
// Program

type JsonRpcId = string | number | null;

interface Reply {
	status: number;
	body: string;
}

function post(url: string, token: string, body: string): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json, text/event-stream',
				'Authorization': `Bearer ${token}`,
				'Content-Length': Buffer.byteLength(body),
			},
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.end(body);
	});
}

function errorReply(id: JsonRpcId, message: string): string {
	return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

// The lists that a client can get again after a notification, with the key of the list in the result
const LISTS: Record<string, { key: string; notification: string }> = {
	'tools/list': { key: 'tools', notification: 'notifications/tools/list_changed' },
	'prompts/list': { key: 'prompts', notification: 'notifications/prompts/list_changed' },
};

// The process of a server, and the server with the number of its lists
const processOf = (w: WindowEntry) => `${w.pid} ${w.url}`;
const serverOf = (w: WindowEntry) => `${processOf(w)} ${w.lists ?? 0}`;

// The lists of the client, for the notifications after a change of the server. The HTTP server cannot send a message
// of its own, so the bridge checks the server of the window at an interval. With a different server process, it gives
// the new server the initialize of the client, so the new server knows the client. A new number of the lists of the same
// server needs no initialize. Then the bridge compares the lists of the server with the lists that the client got. For a
// different list, the client gets a notification, and it asks for the list again. A change of the focus to a window with
// the same lists sends no notification.
export class ListWatch {
	private initialize?: string; // the last initialize of the client, one line
	private server?: string; // the server of the lists of the client, with the number of its lists
	private process?: string; // the server process that got the initialize of the client
	private readonly lists = new Map<string, string>(); // a method of a list -> the list that the client got, as JSON

	// Notes a reply of a server to the client. The reply to initialize tells the client that the lists can change
	note(method: unknown, line: string, window: WindowEntry, body: { result?: Record<string, unknown> }): object {
		const result = body.result;
		if (!result || typeof method !== 'string') {
			return body;
		}
		if (method === 'initialize') {
			this.initialize = line;
			this.server = serverOf(window);
			this.process = processOf(window);
			const caps = (result.capabilities ?? {}) as Record<string, object | undefined>;
			result.capabilities = { ...caps, tools: { ...caps.tools, listChanged: true }, prompts: { ...caps.prompts, listChanged: true } };
		} else if (LISTS[method]) {
			this.lists.set(method, JSON.stringify(result[LISTS[method].key]));
			this.server = serverOf(window);
			this.process ??= processOf(window);
		}
		return body;
	}

	// The notifications for the client after a change of the server. An error, for example of a server that starts,
	// gives no notification, and the next check tries again
	async check(folder: string, token: string, dir = registryDir()): Promise<string[]> {
		const window = chooseWindow(readWindows(dir), folder);
		if (this.initialize === undefined || this.lists.size === 0 || !window || serverOf(window) === this.server) {
			return [];
		}
		try {
			if (processOf(window) !== this.process) {
				await post(window.url, token, this.initialize);
				this.process = processOf(window);
			}
			const lists = new Map<string, string>();
			for (const method of this.lists.keys()) {
				const reply = await post(window.url, token, JSON.stringify({ jsonrpc: '2.0', id: `dataflow-bridge-${method}`, method, params: {} }));
				const result = reply.status === 200 ? (JSON.parse(reply.body) as { result?: Record<string, unknown> }).result : undefined;
				if (!result) {
					return [];
				}
				lists.set(method, JSON.stringify(result[LISTS[method].key]));
			}
			const out = [...lists].filter(([method, list]) => list !== this.lists.get(method))
				.map(([method]) => JSON.stringify({ jsonrpc: '2.0', method: LISTS[method].notification }));
			lists.forEach((list, method) => this.lists.set(method, list));
			this.server = serverOf(window);
			return out;
		} catch {
			return [];
		}
	}
}

// The reply to one line of the client, or undefined for a notification. A window that closed between two messages
// gets one more try with the registry of that time. A watch notes the replies for the notifications of the bridge
export async function forward(line: string, folder: string, token: string, dir = registryDir(), watch?: ListWatch): Promise<string | undefined> {
	let id: JsonRpcId = null;
	let isRequest = false;
	let method: unknown;
	try {
		const message = JSON.parse(line) as { id?: JsonRpcId; method?: unknown };
		isRequest = typeof message.method === 'string' && message.id !== undefined;
		id = message.id ?? null;
		method = message.method;
	} catch {
		return errorReply(null, 'The line is not valid JSON.');
	}
	const fail = (text: string) => (isRequest ? errorReply(id, text) : undefined);
	for (let attempt = 0; attempt < 2; attempt++) {
		const window = chooseWindow(readWindows(dir), folder);
		if (!window) {
			return fail('No VS Code window runs the DataFlow MCP server. Open the project in VS Code, and open a C or C++ file. '
				+ 'With the connection to Claude Code, the server starts with DataFlow. Else run "DataFlow: Start MCP Server".');
		}
		let reply: Reply;
		try {
			reply = await post(window.url, token, line);
		} catch (error) {
			if (attempt === 0) {
				continue;
			}
			return fail(`The DataFlow MCP server on ${window.url} does not answer: ${(error as Error).message}`);
		}
		if (reply.status === 202 || reply.body === '') {
			return undefined;
		}
		if (reply.status === 200) {
			try {
				const body = JSON.parse(reply.body) as { result?: Record<string, unknown> };
				return JSON.stringify(watch ? watch.note(method, line, window, body) : body); // one line
			} catch {
				return fail('The DataFlow MCP server sent a reply that is not valid JSON.');
			}
		}
		let text = reply.body;
		try {
			text = (JSON.parse(reply.body) as { error?: string }).error ?? text;
		} catch {
			// a body that is not JSON
		}
		return fail(reply.status === 401 && !token
			? 'The token is missing. Run "DataFlow: Connect to Claude Code" or "DataFlow: Copy MCP Setup" in VS Code.' : text);
	}
	return undefined;
}

// The time between two checks of the server of the window, in ms. The tests use a shorter time
const CHECK_MS = Number(process.env.DATAFLOW_BRIDGE_CHECK_MS) || 2000;

async function main(): Promise<void> {
	const at = process.argv.indexOf('--folder');
	const folder = path.resolve(at > 0 && process.argv[at + 1] ? process.argv[at + 1] : process.cwd());
	const pending = new Set<Promise<void>>();
	const watch = new ListWatch();
	let isChecking = false;
	// the timer does not keep the bridge running after the end of the input
	setInterval(() => {
		if (isChecking) {
			return;
		}
		isChecking = true;
		void watch.check(folder, tokenOf()).then((lines) => lines.forEach((l) => process.stdout.write(`${l}\n`))).finally(() => {
			isChecking = false;
		});
	}, CHECK_MS).unref();
	// the requests run at the same time, so a long tool call does not stop a ping. Each reply is one line. The token
	// file can come after the start of the bridge, so the bridge reads it for each message
	for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
		if (line.trim() === '') {
			continue;
		}
		const job = forward(line, folder, tokenOf(), registryDir(), watch).then((reply) => {
			if (reply !== undefined) {
				process.stdout.write(`${reply}\n`);
			}
		}, (error) => {
			process.stderr.write(`DataFlow bridge: ${error}\n`);
		});
		pending.add(job);
		void job.finally(() => pending.delete(job));
	}
	await Promise.all(pending);
}

if (require.main === module) {
	void main();
}
