import * as assert from 'assert';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { IncomingHttpHeaders, request } from 'http';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import { chooseWindow, forward, readWindows, TOKEN_FILE, tokenOf, WindowEntry, windowFileName } from '../../mcp/bridge';
import { nameColumn } from '../../mcp/host';
import { McpServer, McpTool, PROTOCOL_VERSIONS } from '../../mcp/server';

const TOKEN = 'test-token-0123456789';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Reply {
	status: number;
	headers: IncomingHttpHeaders;
	body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// A request to the server, with the token unless the headers replace it
function send(port: number, body: unknown, headers: Record<string, string> = {}, method = 'POST', path = '/mcp'): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
		const req = request({
			host: '127.0.0.1', port, path, method,
			headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}`, ...headers },
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) : undefined });
			});
		});
		req.on('error', reject);
		req.end(data);
	});
}

const rpc = (method: string, params: object = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

suite('MCP server', () => {
	let server: McpServer;
	let client: string | undefined;
	const tools: McpTool[] = [
		{ name: 'echo', title: 'Echo', description: 'Gives the arguments back.', inputSchema: { type: 'object' }, isReadOnly: true, call: async (args) => ({ text: JSON.stringify(args) }) },
		{ name: 'fail', title: 'Fail', description: 'Fails.', inputSchema: { type: 'object' }, isReadOnly: false, call: async () => { throw new Error('The engine is not ready.'); } },
	];

	suiteSetup(async () => {
		server = new McpServer({
			port: 0, path: '/mcp', token: TOKEN, name: 'dataflow', title: 'DataFlow', version: '0.1.0', instructions: 'Call get_view first.', tools,
			prompts: [{ name: 'explain', title: 'Explain', description: 'Explains a function.', arguments: [{ name: 'function', description: 'The function.' }], text: (a) => `Explain ${a.function}.` }],
			onClient: (c) => { client = c.name; },
		});
		await server.start();
	});

	suiteTeardown(() => server.stop());

	test('The server refuses a request without the token, from a web page, or to a different host', async () => {
		const port = server.port;
		assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		const noToken = await send(port, rpc('ping'), { Authorization: '' });
		assert.strictEqual(noToken.status, 401);
		assert.strictEqual(noToken.headers['www-authenticate'], 'Bearer');
		assert.strictEqual((await send(port, rpc('ping'), { Authorization: 'Bearer wrong-token-0123456789' })).status, 401);
		assert.strictEqual((await send(port, rpc('ping'), { Origin: 'https://evil.example' })).status, 403);
		assert.strictEqual((await send(port, rpc('ping'), { Host: `evil.example:${port}` })).status, 403);
		assert.strictEqual((await send(port, rpc('ping'), {}, 'POST', '/other')).status, 404);
		const get = await send(port, undefined, {}, 'GET');
		assert.strictEqual(get.status, 405);
		assert.strictEqual(get.headers.allow, 'POST');
		// a page of the same origin, and localhost, are allowed
		assert.strictEqual((await send(port, rpc('ping'), { Origin: `http://localhost:${port}` })).status, 200);
		assert.strictEqual((await send(port, rpc('ping'), { Host: `localhost:${port}` })).status, 200);
	});

	test('initialize agrees to a known version of the protocol and gives the instructions', async () => {
		const reply = await send(server.port, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } }));
		assert.strictEqual(reply.status, 200);
		assert.strictEqual(reply.body.id, 1);
		assert.strictEqual(reply.body.result.protocolVersion, '2025-06-18');
		assert.deepStrictEqual(reply.body.result.serverInfo, { name: 'dataflow', title: 'DataFlow', version: '0.1.0' });
		assert.strictEqual(reply.body.result.instructions, 'Call get_view first.');
		assert.ok(reply.body.result.capabilities.tools);
		assert.strictEqual(client, 'test-client');
		assert.strictEqual(server.client?.name, 'test-client');

		const unknown = await send(server.port, rpc('initialize', { protocolVersion: '1999-01-01' }));
		assert.strictEqual(unknown.body.result.protocolVersion, PROTOCOL_VERSIONS[0]);

		// a notification gets no reply
		const notification = await send(server.port, { jsonrpc: '2.0', method: 'notifications/initialized' });
		assert.strictEqual(notification.status, 202);
		assert.strictEqual(notification.body, undefined);
	});

	test('The tools: the list, a call, a failure of a tool, and an unknown tool', async () => {
		const list = await send(server.port, rpc('tools/list'));
		assert.deepStrictEqual(list.body.result.tools.map((t: { name: string }) => t.name), ['echo', 'fail']);
		assert.strictEqual(list.body.result.tools[0].annotations.readOnlyHint, true);
		assert.strictEqual(list.body.result.tools[1].annotations.readOnlyHint, false);

		const call = await send(server.port, rpc('tools/call', { name: 'echo', arguments: { line: 5 } }));
		assert.deepStrictEqual(call.body.result, { content: [{ type: 'text', text: '{"line":5}' }], isError: false });

		// the model gets the error of the tool as a result, so it can correct the call
		const fail = await send(server.port, rpc('tools/call', { name: 'fail', arguments: {} }));
		assert.deepStrictEqual(fail.body.result, { content: [{ type: 'text', text: 'The engine is not ready.' }], isError: true });

		const unknown = await send(server.port, rpc('tools/call', { name: 'nothing' }));
		assert.strictEqual(unknown.body.error.code, -32602);
		assert.strictEqual((await send(server.port, rpc('resources/read'))).body.error.code, -32601);
	});

	test('The prompts, a batch, and a body that is not JSON', async () => {
		const prompts = await send(server.port, rpc('prompts/list'));
		assert.deepStrictEqual(prompts.body.result.prompts.map((p: { name: string }) => p.name), ['explain']);
		const prompt = await send(server.port, rpc('prompts/get', { name: 'explain', arguments: { function: 'process' } }));
		assert.strictEqual(prompt.body.result.messages[0].content.text, 'Explain process.');

		const batch = await send(server.port, [rpc('ping', {}, 1), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('ping', {}, 2)]);
		assert.deepStrictEqual(batch.body.map((r: { id: number }) => r.id), [1, 2]);

		const bad = await send(server.port, '{ not json');
		assert.strictEqual(bad.status, 400);
		assert.strictEqual(bad.body.error.code, -32700);
	});

	test('A server takes a free port if the port is in use', async () => {
		const second = new McpServer({ port: server.port, path: '/mcp', token: TOKEN, name: 'dataflow', title: 'DataFlow', version: '0.1.0', instructions: '', tools, prompts: [] });
		try {
			const port = await second.start();
			assert.ok(port > 0 && port !== server.port, `${port}`);
			assert.strictEqual((await send(port, rpc('ping'))).status, 200);
		} finally {
			await second.stop();
		}
	});

	test('The host finds a name on a line, also a member after its object', () => {
		assert.strictEqual(nameColumn('  if (charge.is_dirty && !x) {', 'charge.is_dirty'), 13);
		assert.strictEqual(nameColumn('  p->opt = 1;', 'p.opt'), 5);
		assert.strictEqual(nameColumn('int count = 0;', 'count'), 4);
		assert.strictEqual(nameColumn('  account = count;', 'count'), 12);
		assert.strictEqual(nameColumn('int count = 0;', 'missing'), -1);
	});
});

// The bridge for a client that starts a local program. Each window with a server has a file in the registry folder
suite('MCP bridge', () => {
	let server: McpServer;
	let dir: string;
	const echo: McpTool = {
		name: 'echo', title: 'Echo', description: 'Gives the arguments back.', inputSchema: { type: 'object' }, isReadOnly: true,
		call: async (args) => ({ text: JSON.stringify(args) }),
	};
	const entry = (pid: number, url: string, folders: string[], focused: number): WindowEntry => ({ pid, url, folders, focused });

	suiteSetup(async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-bridge-'));
		server = new McpServer({ port: 0, path: '/mcp', token: TOKEN, name: 'dataflow', title: 'DataFlow', version: '0.1.0', instructions: '', tools: [echo], prompts: [] });
		await server.start();
		writeFileSync(path.join(dir, windowFileName(process.pid)), JSON.stringify(entry(process.pid, server.url, [dir], 1)));
	});

	suiteTeardown(async () => {
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test('The bridge takes the window of the folder of the client, else the window that had the focus last', () => {
		const app = entry(1, 'app', [path.resolve('/work/app')], 10);
		const lib = entry(2, 'lib', [path.resolve('/work/app/lib')], 5);
		const other = entry(3, 'other', [path.resolve('/other')], 20);
		const windows = [app, lib, other];
		assert.strictEqual(chooseWindow(windows, path.resolve('/work/app/src'))?.url, 'app');
		// the longest folder that has the folder of the client
		assert.strictEqual(chooseWindow(windows, path.resolve('/work/app/lib/x'))?.url, 'lib');
		// two windows with a folder in the folder of the client: the window with the last focus
		assert.strictEqual(chooseWindow(windows, path.resolve('/work'))?.url, 'app');
		assert.strictEqual(chooseWindow(windows, path.resolve('/elsewhere'))?.url, 'other');
		assert.strictEqual(chooseWindow([], path.resolve('/work')), undefined);
	});

	test('The registry has only the windows whose process runs', () => {
		const stale = path.join(dir, windowFileName(0x7ffffff0));
		writeFileSync(stale, JSON.stringify(entry(0x7ffffff0, 'http://127.0.0.1:1/mcp', [dir], 2)));
		writeFileSync(path.join(dir, 'bridge.js'), '// not a window');
		try {
			assert.deepStrictEqual(readWindows(dir).map((w) => w.url), [server.url]);
		} finally {
			rmSync(stale);
		}
	});

	test('The bridge sends each line to the server and writes each reply on one line', async function () {
		this.timeout(20000);
		// the compiled bridge with the Node.js of VS Code, as a client starts it with node
		const bridge = path.join(__dirname, '..', '..', 'mcp', 'bridge.js');
		const child = spawn(process.execPath, [bridge, '--folder', dir], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DATAFLOW_TOKEN: TOKEN, DATAFLOW_MCP_REGISTRY: dir },
		});
		const replies: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
		createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line)));
		const closed = new Promise((resolve) => child.on('close', resolve));
		child.stdin.write(`${JSON.stringify(rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'bridge-test', version: '1' } }, 1))}\n`);
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
		child.stdin.write(`${JSON.stringify(rpc('tools/call', { name: 'echo', arguments: { a: 1 } }, 2))}\n`);
		child.stdin.end();
		await closed;
		// a notification gets no reply
		assert.deepStrictEqual(replies.map((r) => r.id).sort(), [1, 2]);
		assert.strictEqual(replies.find((r) => r.id === 1).result.serverInfo.name, 'dataflow');
		assert.strictEqual(replies.find((r) => r.id === 2).result.content[0].text, '{"a":1}');
		assert.strictEqual(server.client?.name, 'bridge-test');
	});

	test('With no window or with a wrong token, the bridge answers a request with an error', async () => {
		const empty = mkdtempSync(path.join(os.tmpdir(), 'dataflow-bridge-empty-'));
		try {
			const none = JSON.parse((await forward(JSON.stringify(rpc('ping', {}, 7)), dir, TOKEN, empty))!);
			assert.deepStrictEqual([none.id, none.error.code], [7, -32000]);
			assert.match(none.error.message, /^No VS Code window runs the DataFlow MCP server/);
			assert.strictEqual(await forward(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), dir, TOKEN, empty), undefined);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
		const wrong = JSON.parse((await forward(JSON.stringify(rpc('ping', {}, 8)), dir, 'wrong-token', dir))!);
		assert.match(wrong.error.message, /token is missing or wrong/);
		const missing = JSON.parse((await forward(JSON.stringify(rpc('ping', {}, 9)), dir, '', dir))!);
		assert.match(missing.error.message, /^The token is missing/);
	});

	test('After a change of the server, the bridge tells the client that the list of the tools changed', async function () {
		this.timeout(30000);
		// a registry folder of its own: the window gets a new server, as after a reload with a new version of DataFlow
		const reg = mkdtempSync(path.join(os.tmpdir(), 'dataflow-bridge-watch-'));
		const extra: McpTool = { ...echo, name: 'extra', description: 'A new tool.' };
		const servers = [[echo], [echo, extra], [echo, extra]].map((tools) =>
			new McpServer({ port: 0, path: '/mcp', token: TOKEN, name: 'dataflow', title: 'DataFlow', version: '0.1.0', instructions: '', tools, prompts: [] }));
		await Promise.all(servers.map((s) => s.start()));
		const useServer = (s: McpServer) => writeFileSync(path.join(reg, windowFileName(process.pid)), JSON.stringify(entry(process.pid, s.url, [reg], 1)));
		useServer(servers[0]);
		const bridge = path.join(__dirname, '..', '..', 'mcp', 'bridge.js');
		const child = spawn(process.execPath, [bridge, '--folder', reg], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DATAFLOW_TOKEN: TOKEN, DATAFLOW_MCP_REGISTRY: reg, DATAFLOW_BRIDGE_CHECK_MS: '100' },
		});
		const closed = new Promise((resolve) => child.on('close', resolve));
		const lines: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
		createInterface({ input: child.stdout }).on('line', (line) => lines.push(JSON.parse(line)));
		const replyOf = (id: number) => lines.find((l) => l.id === id);
		const changes = () => lines.filter((l) => l.method === 'notifications/tools/list_changed').length;
		const until = async (isDone: () => boolean) => {
			for (const end = Date.now() + 10000; !isDone(); await sleep(50)) {
				assert.ok(Date.now() < end, JSON.stringify(lines));
			}
		};
		try {
			child.stdin.write(`${JSON.stringify(rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'watch-test', version: '1' } }, 1))}\n`);
			child.stdin.write(`${JSON.stringify(rpc('tools/list', {}, 2))}\n`);
			await until(() => !!replyOf(1) && !!replyOf(2));
			assert.deepStrictEqual(replyOf(1).result.capabilities.tools, { listChanged: true });
			assert.deepStrictEqual(replyOf(2).result.tools.map((t: { name: string }) => t.name), ['echo']);

			// a reload: the window has a new server with one more tool. The new server also gets the initialize of the client
			useServer(servers[1]);
			await until(() => changes() === 1);
			assert.strictEqual(servers[1].client?.name, 'watch-test');
			child.stdin.write(`${JSON.stringify(rpc('tools/list', {}, 3))}\n`);
			await until(() => !!replyOf(3));
			assert.deepStrictEqual(replyOf(3).result.tools.map((t: { name: string }) => t.name), ['echo', 'extra']);

			// a different server with the same tools, for example a window with the focus: no notification
			useServer(servers[2]);
			await until(() => servers[2].client?.name === 'watch-test');
			await sleep(300);
			assert.strictEqual(changes(), 1);
		} finally {
			child.stdin.end();
			await closed;
			await Promise.all(servers.map((s) => s.stop()));
			rmSync(reg, { recursive: true, force: true });
		}
	});

	test('With no DATAFLOW_TOKEN, the bridge reads the token file of the registry folder', async function () {
		this.timeout(20000);
		const file = path.join(dir, TOKEN_FILE);
		writeFileSync(file, `${TOKEN}\n`);
		try {
			assert.strictEqual(tokenOf(dir), TOKEN);
			// the plugin of Claude Code starts the bridge with the registry folder and with no token
			const bridge = path.join(__dirname, '..', '..', 'mcp', 'bridge.js');
			const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DATAFLOW_MCP_REGISTRY: dir };
			delete env.DATAFLOW_TOKEN;
			const child = spawn(process.execPath, [bridge, '--folder', dir], { env });
			const replies: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
			createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line)));
			const closed = new Promise((resolve) => child.on('close', resolve));
			child.stdin.write(`${JSON.stringify(rpc('tools/call', { name: 'echo', arguments: { b: 2 } }, 3))}\n`);
			child.stdin.end();
			await closed;
			assert.strictEqual(replies[0]?.result?.content[0].text, '{"b":2}', JSON.stringify(replies));
		} finally {
			rmSync(file, { force: true });
		}
	});
});
