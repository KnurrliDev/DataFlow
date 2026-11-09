import { timingSafeEqual } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import type { AddressInfo, Socket } from 'net';

// A small MCP server with the Streamable HTTP transport. A client sends each JSON-RPC 2.0 message in a POST request, and
// the server sends one JSON reply for each request. The server has tools and prompts, and it sends no messages of its
// own, so a GET request gets no event stream. The server listens only on 127.0.0.1. It accepts a request only with the
// token in the header Authorization, and no request from a web page of a different origin.
// https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

// The versions of the protocol that the server knows, the newest first. The server agrees to the version of the client
// if it knows the version, else it gives the newest.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const HOST = '127.0.0.1';

export interface McpToolResult {
	text: string; // the result for the model, usually JSON
	isError?: boolean;
}

export interface McpTool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>; // a JSON Schema of the arguments
	isReadOnly: boolean; // the tool does not change the view
	isDestructive?: boolean; // the tool removes data of the user, for example the marks of the steps of a guide
	call(args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpPrompt {
	name: string;
	title: string;
	description: string;
	arguments: { name: string; description: string; required?: boolean }[];
	text(args: Record<string, string>): string;
}

export interface McpClientInfo {
	name: string;
	version: string;
	time: number;
}

export interface McpServerOptions {
	port: number; // 0 for a free port
	path: string; // for example /mcp
	token: string;
	name: string;
	title: string;
	version: string;
	instructions: string;
	tools: McpTool[];
	prompts: McpPrompt[];
	log?: (text: string) => void;
	onClient?: (client: McpClientInfo) => void; // a client sent initialize
}

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: unknown;
	params?: unknown;
}

// A reply with a JSON-RPC error
class RpcError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

export class McpServer {
	private server?: Server;
	private readonly sockets = new Set<Socket>();
	private boundPort = 0;
	private lastClient?: McpClientInfo;

	constructor(private readonly options: McpServerOptions) {}

	get port(): number {
		return this.boundPort;
	}

	get url(): string {
		return `http://${HOST}:${this.boundPort}${this.options.path}`;
	}

	get isRunning(): boolean {
		return !!this.server?.listening;
	}

	// The client that sent initialize last
	get client(): McpClientInfo | undefined {
		return this.lastClient;
	}

	// Starts the server on the port of the options. If a different program uses that port, for example DataFlow in a
	// different window, the server takes a free port. Returns the port.
	async start(): Promise<number> {
		if (this.server) {
			return this.boundPort;
		}
		try {
			await this.listen(this.options.port);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || this.options.port === 0) {
				throw error;
			}
			this.options.log?.(`Port ${this.options.port} is in use. The MCP server takes a free port.`);
			await this.listen(0);
		}
		return this.boundPort;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.boundPort = 0;
		if (!server) {
			return;
		}
		for (const socket of this.sockets) {
			socket.destroy();
		}
		this.sockets.clear();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => void this.handle(req, res));
			server.on('connection', (socket) => {
				this.sockets.add(socket);
				socket.on('close', () => this.sockets.delete(socket));
			});
			server.once('error', reject);
			server.listen(port, HOST, () => {
				server.off('error', reject);
				server.on('error', (error) => this.options.log?.(`MCP server: ${error}`));
				this.server = server;
				this.boundPort = (server.address() as AddressInfo).port;
				resolve();
			});
		});
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			// DNS rebinding: a web page can send requests to a name that points to 127.0.0.1. Then the host is that name
			const host = req.headers.host ?? '';
			const port = this.boundPort;
			if (![`${HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())) {
				return this.reply(res, 403, { error: 'This host is not allowed.' });
			}
			const origin = req.headers.origin;
			if (origin && ![`http://${HOST}:${port}`, `http://localhost:${port}`].includes(origin.toLowerCase())) {
				return this.reply(res, 403, { error: 'This origin is not allowed.' });
			}
			const url = new URL(req.url ?? '/', `http://${host}`);
			if (url.pathname !== this.options.path) {
				return this.reply(res, 404, { error: 'Not found.' });
			}
			if (!this.isAuthorized(req.headers.authorization)) {
				res.setHeader('WWW-Authenticate', 'Bearer');
				return this.reply(res, 401, { error: 'The token is missing or wrong. Run "DataFlow: Copy MCP Setup" in VS Code.' });
			}
			if (req.method !== 'POST') {
				// no event stream: the server sends no messages of its own, and it keeps no sessions
				res.setHeader('Allow', 'POST');
				return this.reply(res, 405, { error: 'Send JSON-RPC messages with POST.' });
			}
			const body = await readBody(req);
			let message: unknown;
			try {
				message = JSON.parse(body);
			} catch {
				return this.reply(res, 400, rpcError(null, -32700, 'The body is not valid JSON.'));
			}
			// a batch of messages, from a client of version 2025-03-26
			if (Array.isArray(message)) {
				const replies = (await Promise.all(message.map((m) => this.dispatch(m)))).filter((r) => r !== undefined);
				return replies.length > 0 ? this.reply(res, 200, replies) : this.reply(res, 202);
			}
			const reply = await this.dispatch(message);
			return reply ? this.reply(res, 200, reply) : this.reply(res, 202);
		} catch (error) {
			this.options.log?.(`MCP request: ${error}`);
			if (!res.headersSent) {
				this.reply(res, (error as { status?: number }).status ?? 500, { error: String((error as Error).message ?? error) });
			}
		}
	}

	private isAuthorized(header: string | undefined): boolean {
		const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
		if (!match) {
			return false;
		}
		const given = Buffer.from(match[1]);
		const expected = Buffer.from(this.options.token);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}

	private reply(res: ServerResponse, status: number, body?: unknown): void {
		if (body === undefined) {
			res.writeHead(status).end();
			return;
		}
		const text = JSON.stringify(body);
		res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }).end(text);
	}

	// The reply to one message. A notification and a response from the client get no reply.
	async dispatch(raw: unknown): Promise<object | undefined> {
		const message = raw as JsonRpcMessage;
		if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
			// a response of the client, or no JSON-RPC message
			return message && typeof message === 'object' && 'id' in message && !('result' in message || 'error' in message)
				? rpcError(message.id ?? null, -32600, 'The message has no method.')
				: undefined;
		}
		const isNotification = !('id' in message) || message.id === undefined;
		if (isNotification) {
			return undefined;
		}
		const id = message.id ?? null;
		try {
			const result = await this.call(message.method, (message.params ?? {}) as Record<string, unknown>);
			return { jsonrpc: '2.0', id, result };
		} catch (error) {
			if (error instanceof RpcError) {
				return rpcError(id, error.code, error.message);
			}
			return rpcError(id, -32603, String((error as Error).message ?? error));
		}
	}

	private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
		const { options } = this;
		switch (method) {
			case 'initialize': {
				const info = (params.clientInfo ?? {}) as { name?: unknown; version?: unknown };
				this.lastClient = { name: String(info.name ?? 'MCP client'), version: String(info.version ?? ''), time: Date.now() };
				options.onClient?.(this.lastClient);
				const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
				return {
					protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
					capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
					serverInfo: { name: options.name, title: options.title, version: options.version },
					instructions: options.instructions,
				};
			}
			case 'ping':
				return {};
			case 'tools/list':
				return {
					tools: options.tools.map((t) => ({
						name: t.name,
						title: t.title,
						description: t.description,
						inputSchema: t.inputSchema,
						annotations: { title: t.title, readOnlyHint: t.isReadOnly, destructiveHint: t.isDestructive ?? false, idempotentHint: t.isReadOnly, openWorldHint: false },
					})),
				};
			case 'tools/call': {
				const tool = options.tools.find((t) => t.name === params.name);
				if (!tool) {
					throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
				}
				const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
				// an error of the tool goes to the model as a result, so the model can correct the call
				try {
					const result = await tool.call(args);
					return { content: [{ type: 'text', text: result.text }], isError: !!result.isError };
				} catch (error) {
					return { content: [{ type: 'text', text: String((error as Error).message ?? error) }], isError: true };
				}
			}
			case 'prompts/list':
				return {
					prompts: options.prompts.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
				};
			case 'prompts/get': {
				const prompt = options.prompts.find((p) => p.name === params.name);
				if (!prompt) {
					throw new RpcError(-32602, `Unknown prompt: ${String(params.name)}`);
				}
				const args = (params.arguments ?? {}) as Record<string, string>;
				return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.text(args) } }] };
			}
			default:
				throw new RpcError(-32601, `Unknown method: ${method}`);
		}
	}
}

function rpcError(id: JsonRpcId, code: number, message: string): object {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(Object.assign(new Error('The request is too large.'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}
