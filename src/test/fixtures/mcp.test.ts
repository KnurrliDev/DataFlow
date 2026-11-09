import * as assert from 'assert';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import * as vscode from 'vscode';
import type { DataFlowApi } from '../../extension';
import type { SideModel } from '../../side/protocol';
import { activateDataFlow, waitFor } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

// The MCP server on the CMake fixture: a client calls the tools over HTTP, and the side view shows the blocks and the
// notes of the model
suite('MCP server on the fixture', () => {
	const file = () => path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'battery.cpp');
	const lineOf = (text: string) => readFileSync(file(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;

	let api: DataFlowApi;
	let url: string;
	let token: string;
	let id = 0;

	const rpc = async (method: string, params: object = {}): Promise<{ result?: any; error?: { code: number; message: string } }> => {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
		});
		assert.strictEqual(res.status, 200);
		return res.json() as Promise<{ result?: any; error?: { code: number; message: string } }>;
	};

	// A tool call: the result as JSON, or the text of an error of the tool
	const tool = async (name: string, args: object = {}): Promise<{ isError: boolean; text: string; data: any }> => {
		const reply = await rpc('tools/call', { name, arguments: args });
		assert.ok(reply.result, JSON.stringify(reply.error));
		const text = reply.result.content[0].text as string;
		return { isError: !!reply.result.isError, text, data: reply.result.isError ? undefined : JSON.parse(text) };
	};

	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(file());
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		await vscode.commands.executeCommand('dataflow.openSideView');
		await waitFor(() => api.side.file === file() && api.side.tokenVersion !== undefined, 60000, () => `file ${api.side.file}`);
		await api.mcp.start();
		url = api.mcp.url!;
		token = await api.mcp.getToken();
		const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-test', version: '1' } });
		assert.strictEqual(init.result.serverInfo.name, 'dataflow');
	});

	suiteTeardown(() => api?.mcp.stop());

	test('The window has a file for the bridge, and the bridge sends the messages of a client to the server', async function () {
		this.timeout(30000);
		const dir = process.env.DATAFLOW_MCP_REGISTRY!;
		assert.ok(dir.endsWith('mcp-registry'), dir);
		const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
		const entry = JSON.parse(readFileSync(path.join(dir, `window-${process.pid}.json`), 'utf8'));
		assert.deepStrictEqual([entry.pid, entry.url, entry.folders.includes(root)], [process.pid, url, true]);
		// the setup for Claude Code starts the copy of the bridge in the registry folder, with the token in a variable
		const setups = await api.mcp.setups();
		const bridge = path.join(dir, 'bridge.js');
		assert.ok(setups.bridge.endsWith(`DATAFLOW_TOKEN=${token} dataflow -- node "${bridge}"`), setups.bridge);
		assert.deepStrictEqual(JSON.parse(setups.json).mcpServers.dataflow, { command: 'node', args: [bridge], env: { DATAFLOW_TOKEN: token } });

		// a client in a folder of the fixture: the bridge finds this window
		const child = spawn(process.execPath, [bridge], {
			cwd: path.join(root, 'src'),
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DATAFLOW_TOKEN: token },
		});
		const replies: any[] = [];
		createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line)));
		const closed = new Promise((resolve) => child.on('close', resolve));
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_view', arguments: {} } })}\n`);
		child.stdin.end();
		await closed;
		assert.strictEqual(replies.length, 1);
		assert.strictEqual(JSON.parse(replies[0].result.content[0].text).file, file());
	});

	test('Connect to Claude Code adds the plugin to the settings of Claude Code, and the server of the plugin reaches this window', async function () {
		this.timeout(30000);
		// the tests have their own settings of Claude Code, never the settings of the user
		const config = process.env.CLAUDE_CONFIG_DIR!;
		assert.ok(config.endsWith('claude-config'), config);
		const registry = process.env.DATAFLOW_MCP_REGISTRY!;
		const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
		const settingsFile = path.join(config, 'settings.json');
		mkdirSync(config, { recursive: true });
		writeFileSync(settingsFile, '{\n  "model": "opus"\n}\n');
		try {
			await vscode.commands.executeCommand('dataflow.claude.connect');
			const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
			assert.strictEqual(settings.model, 'opus');
			assert.deepStrictEqual(settings.enabledPlugins, { 'dataflow@dataflow-vscode': true });
			assert.strictEqual(settings.extraKnownMarketplaces['dataflow-vscode'].source.path, path.join(registry, 'claude'));
			assert.strictEqual(api.mcp.claudeConnection(), 'connected');
			assert.strictEqual(readFileSync(path.join(registry, 'token'), 'utf8'), token);

			// Claude Code starts the server of the plugin in the folder of the session, with no token in its environment
			const plugin = JSON.parse(readFileSync(path.join(registry, 'claude', 'plugins', 'dataflow', '.claude-plugin', 'plugin.json'), 'utf8'));
			const server = plugin.mcpServers.dataflow;
			assert.strictEqual(server.command, process.execPath);
			const env: NodeJS.ProcessEnv = { ...process.env, ...server.env };
			delete env.DATAFLOW_TOKEN;
			const child = spawn(server.command, server.args, { cwd: path.join(root, 'src'), env });
			const replies: any[] = [];
			createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line)));
			const closed = new Promise((resolve) => child.on('close', resolve));
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_view', arguments: {} } })}\n`);
			child.stdin.end();
			await closed;
			assert.strictEqual(JSON.parse(replies[0]?.result?.content[0].text ?? '{}').file, file(), JSON.stringify(replies));
		} finally {
			await vscode.commands.executeCommand('dataflow.claude.disconnect');
		}
		// disconnect removes only the keys of DataFlow and the files of the plugin
		assert.deepStrictEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), { model: 'opus' });
		assert.ok(!existsSync(path.join(registry, 'claude')) && !existsSync(path.join(registry, 'token')));
		assert.strictEqual(api.mcp.claudeConnection(), 'none');
		assert.ok(api.mcp.isRunning);
	});

	test('The server lists its tools, and get_view gives the file of the editor', async () => {
		const list = await rpc('tools/list');
		assert.deepStrictEqual(list.result.tools.map((t: { name: string }) => t.name), [
			'get_view', 'list_functions', 'get_structure', 'get_flow', 'get_calls', 'get_threads', 'get_hidden', 'get_includes', 'get_outline', 'show_blocks', 'show_flow',
			'highlight', 'comment_lines', 'add_detail', 'clear', 'get_review', 'show_review_plan', 'get_diff', 'show_diff_walk', 'review_step',
		]);
		const prompts = await rpc('prompts/list');
		assert.deepStrictEqual(prompts.result.prompts.map((p: { name: string }) => p.name), ['explain-function', 'guided-review', 'diff-walk']);
		const view = await tool('get_view');
		assert.strictEqual(view.data.file, file());
		assert.strictEqual(view.data.engine, 'ready');
		assert.strictEqual(api.store.state.mcp.state, 'on');
		assert.strictEqual(api.store.state.mcp.client, 'fixture-test');
	});

	test('get_structure gives the statements of process() and the branches of its if chain', async () => {
		const res = await tool('get_structure', { function: 'process' });
		assert.ok(!res.isError, res.text);
		const s = res.data;
		assert.strictEqual(s.function, 'electricity::power_ctrl::process');
		assert.strictEqual(s.lines[0], lineOf('std::optional<Requests> process('));
		const chain = s.statements.find((x: any) => x.kind === 'if' && x.branches?.length === 4);
		assert.ok(chain, JSON.stringify(s.statements.map((x: any) => [x.lines, x.kind])));
		const moving = lineOf('HOMEPOWER_CHARGE_ACTIVE) {');
		const searching = lineOf('HOMEPOWER_METER_READING) {');
		const detected = lineOf('HOMEPOWER_METER_STABLE) {');
		assert.deepStrictEqual(chain.branches.map((b: any) => b.lines), [
			[lineOf('if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING)'), moving - 1], [moving, searching - 1], [searching, detected - 1],
			[detected, lineOf('return requests;') - 1],
		]);
		const start = s.statements.find((x: any) => x.lines[0] === lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)'));
		assert.ok(start?.in?.includes('charge.is_dirty'), JSON.stringify(start));
		assert.ok(start?.threads?.some((t: string) => t.includes('solve_power_plan')), JSON.stringify(start));
		assert.strictEqual(s.statements[s.statements.length - 1].kind, 'return');
	});

	test('show_blocks moves the blocks to whole statements, and the side view shows them', async function () {
		this.timeout(30000);
		const chain = lineOf('if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING)');
		const end = lineOf('return requests;');
		const start = lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)');
		const shift = lineOf('fire_transition(home_battery_ctl, "", true)');
		const res = await tool('show_blocks', {
			function: 'process',
			blocks: [
				{ lines: [lineOf('auto &tariff_plans'), lineOf('auto cur_tariff_plan')], title: 'Find the active tariff plan', summary: 'Stops when no tariff plan is active.' },
				{ lines: [start, start + 2], title: 'Start the solver' },
				{ lines: [shift, shift], title: 'Advance the state machine' },
				{
					lines: [chain, end - 2], title: 'Run the current state', children: [
						{ lines: [chain, lineOf('HOMEPOWER_CHARGE_ACTIVE) {') - 1], title: 'Planning' },
						{ lines: [lineOf('HOMEPOWER_CHARGE_ACTIVE) {'), lineOf('HOMEPOWER_METER_READING) {') - 1], title: 'Moving' },
						{ lines: [lineOf('HOMEPOWER_METER_READING) {'), lineOf('HOMEPOWER_METER_STABLE) {') - 1], title: 'Searching' },
						{ lines: [lineOf('HOMEPOWER_METER_STABLE) {'), end - 2], title: 'Detected' },
					],
				},
				{ lines: [end, end], title: 'Return the commands' },
			],
		});
		assert.ok(!res.isError, res.text);
		assert.strictEqual(res.data.shown, 9);
		// the model ended block 4 on the line before the closing brace of the if chain
		const run = res.data.blocks.find((b: any) => b.id === '4');
		assert.deepStrictEqual([run.lines, run.movedFrom], [[chain, end - 1], [chain, end - 2]]);
		const solver = res.data.blocks.find((b: any) => b.id === '2');
		assert.ok(solver.in.includes('charge.is_dirty'), JSON.stringify(solver));
		assert.ok(solver.items.some((i: string) => i.startsWith('thread:') && i.includes('solve_power_plan')), JSON.stringify(solver));

		await waitFor(() => (api.side.modelLayer?.blocks.length ?? 0) === 9, 10000, () => JSON.stringify(api.side.modelLayer));
		const layer = api.side.modelLayer!;
		assert.strictEqual(layer.fn, 'electricity::power_ctrl::process');
		assert.strictEqual(layer.client, 'fixture-test');
		assert.deepStrictEqual(layer.blocks.map((b) => b.id), ['1', '2', '3', '4', '4a', '4b', '4c', '4d', '5']);
	});

	test('The blocks of the model come back in a new session, also after a change of the file', async function () {
		this.timeout(60000);
		const before = api.store.state.modelLayers[0];
		const stored = api.layers.stored();
		assert.deepStrictEqual(stored.map((s) => s.layer), [before]);
		// a new session: no layers in the store, and a new line at the start of the file
		api.store.update({ modelLayers: [] });
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		try {
			await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '\n'));
			api.layers.restore(stored);
			const restored = api.store.state.modelLayers[0];
			assert.deepStrictEqual(restored.blocks.map((b) => [b.id, b.first, b.last]), before.blocks.map((b) => [b.id, b.first + 1, b.last + 1]));
		} finally {
			await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
		// the revert moves the blocks back
		await waitFor(() => api.side.modelLayer?.blocks[0].first === before.blocks[0].first, 10000,
			() => JSON.stringify(api.side.modelLayer?.blocks[0] ?? null));
	});

	test('highlight colors a line and a block, and show_flow starts Flow Lens on the member', async function () {
		this.timeout(30000);
		const read = lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)');
		const res = await tool('highlight', {
			ranges: [
				{ lines: [read, read], kind: 'problem', note: 'reads is_dirty while the solver can write it' },
				{ block: '4b', kind: 'warning', note: 'safe only if no solver runs in this state' },
			],
		});
		assert.ok(!res.isError, res.text);
		await waitFor(() => (api.side.modelLayer?.notes.length ?? 0) === 2, 10000, () => JSON.stringify(api.side.modelLayer));
		const moving = lineOf('HOMEPOWER_CHARGE_ACTIVE) {');
		assert.deepStrictEqual(api.side.modelLayer!.notes.map((n) => [n.first, n.last, n.kind]),
			[[read, read, 'problem'], [moving, lineOf('HOMEPOWER_METER_READING) {') - 1, 'warning']]);
		assert.strictEqual(api.side.modelLayer!.blocks.length, 9);

		const flow = await tool('show_flow', { line: read, name: 'charge.is_dirty' });
		assert.ok(!flow.isError, flow.text);
		assert.strictEqual(flow.data.kind, 'member');
		assert.match(flow.data.name, /::is_dirty$/);
		// the condition of the if checks the member
		assert.ok(flow.data.refs.some((r: any) => r.line === read && r.role === 'check' && r.thread === 'caller'), JSON.stringify(flow.data.refs));
		assert.ok(flow.data.refs.some((r: any) => r.role === 'write' && r.thread === 'tf::Executor::async'), JSON.stringify(flow.data.refs));
		await waitFor(() => !!api.store.state.trace?.member, 20000, () => 'no member trace');
	});

	test('A wrong call changes nothing and tells the model why', async () => {
		const read = lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)');
		const overlap = await tool('show_blocks', { function: 'process', blocks: [{ lines: [read - 2, read], title: 'A' }, { lines: [read, read + 2], title: 'B' }] });
		assert.ok(overlap.isError);
		assert.match(overlap.text, /overlap/);
		assert.strictEqual(api.side.modelLayer!.blocks.length, 9);
		const unknown = await tool('get_structure', { function: 'nothing_here' });
		assert.ok(unknown.isError);
		assert.match(unknown.text, /No function nothing_here/);
		const outside = await tool('get_view', {});
		assert.ok(!outside.isError);
	});

	test('show_blocks takes five levels of blocks, and comment_lines adds comments in colors', async function () {
		this.timeout(30000);
		const chain = lineOf('if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING)');
		const ready = lineOf('if (home_battery_ctl.charging_future && FINISHED(');
		const converged = lineOf('if (converged) {');
		const again = lineOf('// with no converged schedule, try the next price slot') - 1;
		const moving = lineOf('HOMEPOWER_CHARGE_ACTIVE) {');
		const end = lineOf('return requests;');
		const res = await tool('show_blocks', {
			function: 'process',
			blocks: [{
				lines: [chain, end - 1], title: 'Run the current state', children: [{
					lines: [chain, moving - 1], title: 'Planning', children: [
						{ lines: [ready + 1, ready + 2], title: 'Take the result of the solver' },
						{
							lines: [converged, moving - 2], title: 'Use the result', children: [
								{ lines: [converged, again - 1], title: 'Converged', children: [{ lines: [converged + 2, converged + 6], title: 'Make the commands' }] },
								{ lines: [again, moving - 2], title: 'Plan again' },
							],
						},
					],
				}],
			}],
		});
		assert.ok(!res.isError, res.text);
		// the planning branch has one if with no else. Its children are the statements in that if
		assert.deepStrictEqual(res.data.blocks.map((b: any) => `${b.id} ${b.parent ?? '-'} ${b.lines[0]}-${b.lines[1]}`), [
			`1 - ${chain}-${end - 1}`, `1a 1 ${chain}-${moving - 1}`, `1a1 1a ${ready + 1}-${ready + 2}`, `1a2 1a ${converged}-${moving - 2}`,
			`1a2a 1a2 ${converged}-${again - 1}`, `1a2a1 1a2a ${converged + 2}-${converged + 6}`, `1a2b 1a2 ${again}-${moving - 2}`,
		]);
		await waitFor(() => api.side.modelLayer?.blocks.length === 7, 10000, () => JSON.stringify(api.side.modelLayer?.blocks.map((b) => b.id) ?? null));
		assert.deepStrictEqual(api.side.modelLayer!.blocks.map((b) => b.level), [0, 1, 2, 2, 3, 4, 3]);
		const six = await tool('show_blocks', {
			function: 'process',
			blocks: [{ lines: [chain, end - 1], title: 'A', children: [{ lines: [chain, moving - 1], title: 'B', children: [{ lines: [ready + 1, ready + 2], title: 'C', children: [
				{ lines: [ready + 1, ready + 1], title: 'D', children: [{ lines: [ready + 1, ready + 1], title: 'E', children: [{ lines: [ready + 1, ready + 1], title: 'F' }] }] },
			] }] }] }],
		});
		assert.ok(six.isError);
		assert.match(six.text, /the view shows 5 levels of blocks/);

		const read = lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)');
		const shift = lineOf('fire_transition(home_battery_ctl, "", true)');
		const comments = await tool('comment_lines', {
			comments: [{ line: read, text: 'reads is_dirty before the solver starts', color: 'purple' }, { line: shift, text: 'an event for the state machine' }],
		});
		assert.ok(!comments.isError, comments.text);
		await waitFor(() => api.side.modelLayer?.comments.length === 2, 10000, () => JSON.stringify(api.side.modelLayer?.comments ?? null));
		// the blocks stay
		assert.strictEqual(api.side.modelLayer!.blocks.length, 7);
		// append keeps the old comments, and a new comment on a line replaces the old comment of the line
		const more = await tool('comment_lines', {
			append: true, comments: [{ line: shift, text: 'the event that starts the next state', color: 'green' }, { line: chain, text: 'the state machine' }],
		});
		assert.ok(!more.isError, more.text);
		assert.strictEqual(more.data.commentsInFile, 3);
		assert.deepStrictEqual(api.side.modelLayer!.comments.map((c) => [c.line, c.text, c.color ?? '-']), [
			[read, 'reads is_dirty before the solver starts', 'purple'], [shift, 'the event that starts the next state', 'green'], [chain, 'the state machine', '-'],
		]);
		const wrong = await tool('comment_lines', { comments: [{ line: read, text: 'a', color: 'pink' }] });
		assert.ok(wrong.isError);
		assert.match(wrong.text, /"color" must be one of blue/);
		assert.strictEqual((await tool('get_view')).data.model.comments, 3);
	});

	test('add_detail puts a detail on an expression, and on the selection of the editor', async function () {
		this.timeout(30000);
		const read = lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)');
		const res = await tool('add_detail', {
			line: read, expression: 'charge.is_dirty && !home_battery_ctl.charging_future', title: 'When the solver starts',
			text: '- **is_dirty** is true and no future: the solver starts.\n- a future: no new start.',
		});
		assert.ok(!res.isError, res.text);
		assert.strictEqual(res.data.id, 'd1');
		await waitFor(() => api.side.modelLayer?.details.length === 1, 10000, () => JSON.stringify(api.side.modelLayer?.details ?? null));
		const d = api.side.modelLayer!.details[0];
		assert.deepStrictEqual([d.line, d.code, d.title], [read, 'charge.is_dirty && !home_battery_ctl.charging_future', 'When the solver starts']);

		// the selection of the editor: get_view gives it, and add_detail with no line takes it
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		const shift = lineOf('fire_transition(home_battery_ctl, "", true)');
		const col = editor.document.lineAt(shift - 1).text.indexOf('fire_transition');
		editor.selection = new vscode.Selection(shift - 1, col, shift - 1, col + 'fire_transition'.length);
		const view = await tool('get_view');
		assert.deepStrictEqual(view.data.selection, {
			lines: [shift, shift], start: { line: shift, col: col + 1 }, end: { line: shift, col: col + 16 }, text: 'fire_transition',
		});
		const selected = await tool('add_detail', { text: 'Sends an event to the state machine.' });
		assert.ok(!selected.isError, selected.text);
		assert.deepStrictEqual([selected.data.id, selected.data.code], ['d2', 'fire_transition']);
		assert.deepStrictEqual((await tool('get_view')).data.model.details,
			[`d1 When the solver starts (${read}-${read})`, `d2 fire_transition (${shift}-${shift})`]);
		editor.selection = new vscode.Selection(shift - 1, col, shift - 1, col);
		assert.match((await tool('add_detail', { text: 'x' })).text, /The user selected no code/);
	});

	test('The switch Model hides the layers of the model, and a view tool shows them again', async function () {
		this.timeout(20000);
		assert.strictEqual(api.side.frameState.isModelShown, true);
		await vscode.commands.executeCommand('dataflow.toggleModelLayers');
		assert.strictEqual(api.side.frameState.isModelShown, false);
		assert.strictEqual((await tool('get_view')).data.sideView.modelLayersShown, false);
		// the layers stay, and only the code view hides them
		assert.ok((api.side.modelLayer?.details.length ?? 0) > 0, JSON.stringify(api.side.modelLayer));
		const res = await tool('comment_lines', { append: true, comments: [{ line: lineOf('return requests;'), text: 'the result of the function' }] });
		assert.ok(!res.isError, res.text);
		assert.strictEqual(api.side.frameState.isModelShown, true);
	});

	test('show_blocks keeps the blocks of the other functions, and highlight with append adds notes', async function () {
		this.timeout(30000);
		const before = api.side.modelLayer!.blocks.length;
		const solve = lineOf('std::optional<double> solve_power_plan(');
		const res = await tool('show_blocks', { function: 'solve_power_plan', blocks: [{ lines: [solve + 1, solve + 2], title: 'Prepare the solver' }] });
		assert.ok(!res.isError, res.text);
		assert.strictEqual(res.data.functionsWithBlocks, 2);
		await waitFor(() => api.side.modelLayer?.blocks.length === before + res.data.shown, 10000, () => JSON.stringify(api.side.modelLayer?.blocks.length));
		const fns = [...new Set(api.side.modelLayer!.blocks.map((b) => b.fn))];
		assert.strictEqual(fns.length, 2);
		assert.ok(fns.some((f) => f.endsWith('solve_power_plan')) && fns.some((f) => f.endsWith('::process')), JSON.stringify(fns));
		// each function has a block 1, so a note on block 1 needs the function
		const both = await tool('highlight', { append: true, ranges: [{ block: '1', kind: 'info', note: 'x' }] });
		assert.ok(both.isError);
		assert.match(both.text, /Give "function"/);
		const notes = api.side.modelLayer!.notes.length;
		const one = await tool('highlight', { append: true, ranges: [{ block: '1', function: 'solve_power_plan', kind: 'info', note: 'prepares the solver' }] });
		assert.ok(!one.isError, one.text);
		assert.strictEqual(api.side.modelLayer!.notes.length, notes + 1);
		// get_view gives the blocks of each function
		assert.strictEqual((await tool('get_view')).data.model.functions.length, 2);
	});

	test('The other read tools give the data of the lenses', async function () {
		this.timeout(60000);
		const threads = await tool('get_threads');
		assert.ok(threads.data.items.some((i: any) => i.item === 'charge.is_dirty' && i.verdict === 'Race'), JSON.stringify(threads.data.items));
		const calls = await tool('get_calls', { function: 'process' });
		assert.ok(calls.data.calls.some((c: any) => c.callee.includes('fire_transition') && c.event), JSON.stringify(calls.data.calls));
		// the test build of VS Code has no C++ extension
		assert.deepStrictEqual(calls.data.callersInOtherFiles, []);
		assert.match(calls.data.note, /^No call hierarchy/);
		const functions = await tool('list_functions');
		assert.ok(functions.data.functions.some((f: any) => f.name === 'electricity::power_ctrl::process'), functions.text);
		const variable = await tool('get_flow', { line: lineOf('auto cur_tariff_plan'), name: 'cur_tariff_plan' });
		assert.strictEqual(variable.data.kind, 'variable');
		assert.ok(variable.data.refs.length >= 2, variable.text);
		assert.ok(!(await tool('get_hidden', { function: 'process' })).isError);
		assert.ok((await tool('get_includes')).data.includes.length > 0);
		// the outline of a type by its name, and at the line of its definition in the header
		const header = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'include', 'battery', 'types.hpp');
		const byName = await tool('get_outline', { file: header, name: 'HomeBatteryCtrl' });
		assert.strictEqual(byName.data?.type, 'electricity::power_ctrl::HomeBatteryCtrl', byName.text);
		assert.ok(byName.data.layout.size > 0, byName.text);
		assert.strictEqual(byName.data.members.filter((m: any) => m.kind === 'field').length, 10, byName.text);
		const headerLine = readFileSync(header, 'utf8').split(/\r?\n/).findIndex((l) => l.includes('struct HomeBatteryCtrl {')) + 1;
		const byLine = await tool('get_outline', { file: header, line: headerLine });
		assert.deepStrictEqual([byLine.data?.type, byLine.data?.line], ['electricity::power_ctrl::HomeBatteryCtrl', headerLine], byLine.text);
		assert.ok((await tool('get_outline', { file: header })).isError);
	});

	test('get_calls gives the callers in other files from the call hierarchy of VS Code', async function () {
		this.timeout(30000);
		// a provider for C++ in place of the C/C++ extension: main() in main.cpp calls process() on line 10
		const main = vscode.Uri.file(path.join(path.dirname(file()), 'main.cpp'));
		const name = (line: number) => new vscode.Range(line - 1, 4, line - 1, 8);
		const provider = vscode.languages.registerCallHierarchyProvider({ language: 'cpp' }, {
			prepareCallHierarchy: (doc, pos) =>
				new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'process', '', doc.uri, doc.lineAt(pos.line).range, new vscode.Range(pos, pos)),
			provideCallHierarchyIncomingCalls: () =>
				[new vscode.CallHierarchyIncomingCall(new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'main', '', main, name(4), name(4)), [name(10)])],
			provideCallHierarchyOutgoingCalls: () => [],
		});
		try {
			const calls = await tool('get_calls', { function: 'process' });
			assert.deepStrictEqual(calls.data.callersInOtherFiles, [{ caller: 'main', file: main.fsPath, line: 4, callLines: [10] }]);
			assert.match(calls.data.note, /^callersInOtherFiles comes from the call hierarchy/);
		} finally {
			provider.dispose();
		}
	});

	test('An edit moves the blocks with their code, and clear removes them', async function () {
		this.timeout(60000);
		const before = api.side.modelLayer!;
		const linesOf = (layer: SideModel) => layer.blocks.map((b) => [b.first, b.last, ...b.extra.map((x) => x.line)]);
		const moved = (by: number) => linesOf(before).map((list) => list.map((l) => l + by));
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		try {
			// a new line at the start of the first block moves all blocks and their items one line down
			await editor.edit((edit) => edit.insert(new vscode.Position(before.blocks[0].first - 1, 0), '\n'));
			await waitFor(() => api.side.modelLayer?.blocks[0].first === before.blocks[0].first + 1, 10000,
				() => JSON.stringify(api.side.modelLayer?.blocks[0] ?? null));
			assert.deepStrictEqual(linesOf(api.side.modelLayer!), moved(1));
			assert.deepStrictEqual(api.side.modelLayer!.comments.map((c) => c.line), before.comments.map((c) => c.line + 1));
		} finally {
			await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
		// the revert removes the line again
		await waitFor(() => api.side.modelLayer?.blocks[0].first === before.blocks[0].first, 10000,
			() => JSON.stringify(api.side.modelLayer?.blocks[0] ?? null));
		assert.deepStrictEqual(linesOf(api.side.modelLayer!), moved(0));
		const read = lineOf('if (charge.is_dirty && !home_battery_ctl.charging_future)');
		assert.ok(!(await tool('highlight', { ranges: [{ lines: [read, read], kind: 'info', note: 'a note' }] })).isError);
		await waitFor(() => api.side.modelLayer?.notes.length === 1, 10000, () => JSON.stringify(api.side.modelLayer));
		assert.strictEqual((await tool('clear')).data.removed, 1);
		await waitFor(() => api.side.modelLayer === null, 10000, () => JSON.stringify(api.side.modelLayer));
	});

	test('With no C++ editor, the tools use the file of the side view', async function () {
		this.timeout(60000);
		// a text editor with no C++ hides the editor of the file, as the panel of the MCP client does. The side view keeps
		// its file and the last cursor of the editor
		const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		const cursor = editor.selection.active;
		const other = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'notes' });
		await vscode.window.showTextDocument(other, vscode.ViewColumn.One);
		try {
			assert.strictEqual(api.side.file, file());
			const view = await tool('get_view');
			assert.deepStrictEqual([view.data.file, view.data.cursor], [file(), { line: cursor.line + 1, col: cursor.character + 1 }]);
			const functions = await tool('list_functions');
			assert.ok(!functions.isError, functions.text);
			assert.strictEqual(functions.data.file, file());
		} finally {
			await vscode.window.showTextDocument(other, vscode.ViewColumn.One);
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		}
	});
});
