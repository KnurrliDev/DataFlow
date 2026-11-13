import * as vscode from 'vscode';
import type * as Api from '../../api/dataflow-api';
import type { McpTool, McpToolResult } from './server';

// The tools that other extensions add to the MCP server of DataFlow with the API. The MCP name of a tool is the name of
// its client in lowercase, then _, then the name of the tool, for example my_extension_get_brief. Its description starts
// with the name of the client. A tool runs in its extension, and the token of the MCP server protects it as it protects
// the tools of DataFlow. Each change of the tools adds 1 to the number of the lists. The file of the window in the
// registry gets this number, so the bridge tells its client that the list of the tools changed.

// The maximum length of the MCP name of a tool
export const MAX_TOOL_NAME = 64;
const NAME = /^[A-Za-z0-9_]+$/;

// The start of the MCP names of the tools of a client: its name in lowercase, with _ in the place of each character that
// is not a letter or a digit, then _
export const toolPrefix = (client: string): string => `${client.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_`;

// The result of a tool of an extension for the model: a text as it is, else the value as JSON
function resultOf(value: unknown): McpToolResult {
	return { text: typeof value === 'string' ? value : JSON.stringify(value ?? null) };
}

interface ExtensionMcpTool extends McpTool {
	client: string;
}

export class ExtensionTools implements vscode.Disposable {
	private readonly tools = new Map<string, ExtensionMcpTool>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private changes = 0;

	// reserved: the names of the tools of DataFlow
	constructor(private readonly reserved: () => readonly string[]) {}

	// The number of the changes of the tools
	get lists(): number {
		return this.changes;
	}

	// The tools of all extensions, in the sequence of their registration
	list(): McpTool[] {
		return [...this.tools.values()];
	}

	// Adds the tools of a client. All tools must be correct, or no tool goes in, and the error gives each problem. The
	// result removes the tools
	register(client: string, input: unknown): vscode.Disposable {
		if (!Array.isArray(input) || input.length === 0) {
			throw new Error('Give a list of one tool or more.');
		}
		const prefix = toolPrefix(client);
		const taken = new Set([...this.reserved(), ...this.tools.keys()]);
		const added: ExtensionMcpTool[] = [];
		const problems: string[] = [];
		input.forEach((raw, i) => {
			const n = i + 1;
			if (!raw || typeof raw !== 'object') {
				problems.push(`Tool ${n} is not an object.`);
				return;
			}
			const before = problems.length;
			const t = raw as Partial<Api.ExtensionTool>;
			const name = typeof t.name === 'string' ? t.name : '';
			const full = `${prefix}${name}`;
			if (!NAME.test(name)) {
				problems.push(`Tool ${n}: "name" must have only letters, digits and _.`);
			} else if (full.length > MAX_TOOL_NAME) {
				problems.push(`Tool ${n}: the MCP name ${full} has more than ${MAX_TOOL_NAME} characters.`);
			} else if (taken.has(full)) {
				problems.push(`Tool ${n}: the MCP server has the tool ${full} already.`);
			}
			if (typeof t.title !== 'string' || !t.title.trim()) {
				problems.push(`Tool ${n}: give a "title".`);
			}
			if (typeof t.description !== 'string' || !t.description.trim()) {
				problems.push(`Tool ${n}: give a "description".`);
			}
			const schema = t.inputSchema as { type?: unknown } | undefined;
			if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
				problems.push(`Tool ${n}: "inputSchema" must be a JSON Schema of an object, with "type": "object".`);
			}
			if (typeof t.call !== 'function') {
				problems.push(`Tool ${n}: give the function "call".`);
			}
			if (problems.length > before) {
				return;
			}
			taken.add(full);
			const call = t.call!.bind(t);
			added.push({
				client,
				name: full,
				title: t.title!.trim(),
				description: `${client}: ${t.description!.trim()}`,
				inputSchema: t.inputSchema as Record<string, unknown>,
				isReadOnly: t.isReadOnly === true,
				...(t.isDestructive === true ? { isDestructive: true } : {}),
				call: async (args) => resultOf(await call(args)),
			});
		});
		if (problems.length > 0) {
			throw new Error(`No tool was added.\n${problems.join('\n')}`);
		}
		added.forEach((t) => this.tools.set(t.name, t));
		this.changed();
		return new vscode.Disposable(() => {
			let isRemoved = false;
			for (const t of added) {
				if (this.tools.get(t.name) === t) {
					this.tools.delete(t.name);
					isRemoved = true;
				}
			}
			if (isRemoved) {
				this.changed();
			}
		});
	}

	dispose(): void {
		this.emitter.dispose();
	}

	private changed(): void {
		this.changes += 1;
		this.emitter.fire();
	}
}
