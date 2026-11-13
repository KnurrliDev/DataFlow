import * as assert from 'assert';
import * as vscode from 'vscode';
import type * as Api from '../../../api/dataflow-api';
import { ApiDeps, ApiEvents, createApi } from '../../api/api';
import type { CompileDbInfo } from '../../cdb/manager';
import type { EngineFunction } from '../../engine/client';
import { DataFlowMcpHost, type HostDeps } from '../../mcp/host';
import { createTools } from '../../mcp/tools';
import { withCurrent, withStatus } from '../../review/guide';
import { dropGuide, pushGuide, setGuide, setStack, stackOf } from '../../review/stack';
import type { SideGuide } from '../../side/protocol';
import { Lens, StateStore } from '../../state/store';

// The API for other extensions with a store and no engine: the versions, the tools, the errors and the events
suite('API for other extensions', () => {
	const fn = (name: string, first: number, last: number): EngineFunction => ({
		name, qualifiedName: `ns::${name}`, kind: 'function', range: { begin: { line: first, col: 1 }, end: { line: last, col: 2 } },
	});

	let store: StateStore;
	let place: { doc: vscode.TextDocument; pos: vscode.Position } | undefined;
	let logs: string[];
	let deps: ApiDeps;
	let events: ApiEvents;

	setup(() => {
		store = new StateStore();
		place = undefined;
		logs = [];
		// only the dependencies of the tools of the tests. A tool that needs the engine fails, as with no engine
		const hostDeps = {
			store,
			engine: () => undefined,
			ripple: () => ({}),
			stopCallGraph: () => false,
			setLens: (lens: Lens, isOn: boolean) => store.update({ lenses: { ...store.state.lenses, [lens]: isOn } }),
		} as unknown as HostDeps;
		deps = { store, hostDeps, currentPlace: () => place, log: (message) => logs.push(message) };
		events = new ApiEvents(deps);
	});

	teardown(() => {
		events.dispose();
		store.dispose();
	});

	test('getApi gives version 1 with the tools of the MCP server, and a different version throws', () => {
		const api = createApi(deps, events, 1, { client: ' my-extension ' });
		assert.strictEqual(api.version, 1);
		assert.strictEqual(api.engineState, 'stopped');
		assert.deepStrictEqual(api.compileDatabases, []);
		assert.strictEqual(api.tools.length, 38);
		assert.deepStrictEqual(api.tools.filter((t) => t.isDestructive).map((t) => t.name), ['close_guide']);
		assert.ok(api.tools.find((t) => t.name === 'get_logic')?.isReadOnly);
		assert.ok(!api.tools.find((t) => t.name === 'set_lens')?.isReadOnly);
		assert.deepStrictEqual(logs, ['The extension "my-extension" uses the API of DataFlow.']);
		createApi(deps, events, 1);
		assert.strictEqual(logs[1], 'The extension "extension" uses the API of DataFlow.');
		assert.throws(() => createApi(deps, events, 2), /DataFlow has no API version 2\. Use version 1\./);
	});

	test('The methods run the tools, and a wrong call rejects with the reason', async () => {
		const api = createApi(deps, events, 1, { client: 'my-extension' });
		// the state of the call graph, with no scan
		assert.deepStrictEqual(await api.getCallGraph(), { state: 'none' });
		store.update({ callGraph: { state: 'scanning', done: 1, total: 4 } });
		assert.deepStrictEqual(await api.getCallGraph(), {
			state: 'scanning', done: 1, total: 4, note: 'The scan runs. get_heat gives the callers and the frame paths after its end.',
		});
		store.update({ callGraph: undefined });
		assert.deepStrictEqual(await api.getRipple(), {
			state: 'none', note: 'No review of Change Ripple shows. Call start_ripple, or ask the user to run "DataFlow: Review Changes".',
		});
		assert.deepStrictEqual(await api.setLens({ lens: 'heat', on: true }), {
			lens: 'heat', on: true, changed: true, lenses: ['flow', 'logic', 'cost', 'includes', 'calls', 'threads', 'heat'],
		});
		assert.strictEqual((await api.setLens({ lens: 'heat', on: true })).changed, false);
		assert.deepStrictEqual(await api.callTool('stop_call_graph'), { stopped: false, state: 'none' });
		await assert.rejects(api.setLens({ lens: 'colors' as Api.LensName, on: true }), /"lens" must be one of flow, logic, cost, review, includes, calls, threads, heat\./);
		await assert.rejects(api.callTool('get_colors'), /DataFlow has no tool get_colors\./);
		await assert.rejects(api.callTool('get_view', ['a'] as unknown as Record<string, unknown>), /The arguments of get_view must be an object\./);
		await assert.rejects(api.getStructure({ function: 'process' }), /The DataFlow engine is not ready\./);
	});

	test('The engine error gives the reason of a failed engine, and of a stopped engine with no compile database after the search', () => {
		const api = createApi(deps, events, 1);
		const errors: (string | undefined)[] = [];
		const subscription = api.onDidChangeEngineState((e) => errors.push(e.error));
		// before the first search of the compile databases, the stopped engine has no error
		assert.strictEqual(api.engineError, undefined);
		store.update({ isDatabaseSearchDone: true });
		const noDatabase = 'No compile database. Run "DataFlow: Select Compile Database", or set dataflow.compileCommands.';
		assert.strictEqual(api.engineError, noDatabase);
		store.update({ engine: 'failed', message: 'The engine did not start: no engine' });
		assert.strictEqual(api.engineError, 'The engine did not start: no engine');
		store.update({ engine: 'failed', message: undefined });
		assert.strictEqual(api.engineError, 'The engine stopped. See the DataFlow log.');
		const db: CompileDbInfo = { path: 'C:/p/build/compile_commands.json', source: 'found', folder: 'C:/p/build' };
		store.update({ engine: 'starting', databases: [db] });
		assert.strictEqual(api.engineError, undefined);
		subscription.dispose();
		assert.deepStrictEqual(errors, [noDatabase, 'The engine did not start: no engine', 'The engine stopped. See the DataFlow log.', undefined]);
	});

	test('The events: the state of the engine, the cursor, the guide and the scan of the call graph', () => {
		const api = createApi(deps, events, 1);
		const seen: string[] = [];
		const subscriptions = [
			api.onDidChangeEngineState((e) => seen.push(`engine ${e.state} ${e.compileDatabases.join(',')}`)),
			api.onDidChangeView((e) => seen.push(`view ${e.function?.name ?? '-'} ${e.line}`)),
			api.onDidChangeGuide((g) => seen.push(g ? `guide ${g.title} ${g.currentStep} ${g.progress}` : 'guide closed')),
			api.onDidChangeCallGraph((c) => seen.push(`graph ${c.state} ${c.done ?? ''}`)),
		];
		store.update({ engine: 'starting' });
		store.update({ parsing: ['a.cpp'] }); // no event
		const db: CompileDbInfo = { path: 'C:/p/build/compile_commands.json', source: 'found', folder: 'C:/p/build' };
		store.update({ engine: 'ready', databases: [db] });

		// the view changes with an update of the cursor. The same function on the same line gives no event
		const doc = { uri: vscode.Uri.file('C:/p/src/a.cpp') } as vscode.TextDocument;
		place = { doc, pos: new vscode.Position(4, 0) };
		store.update({ file: doc.uri.fsPath, fn: fn('run', 3, 9) });
		store.update({ file: doc.uri.fsPath, fn: fn('run', 3, 9) });
		place = { doc, pos: new vscode.Position(6, 2) };
		store.update({ errorCount: 0 }); // no update of the cursor: no event
		store.update({ file: doc.uri.fsPath, fn: fn('run', 3, 9) });
		store.update({ fn: null });

		const guide = {
			title: 'Plan', current: 0, seq: 1,
			steps: [{ title: 'Read', file: doc.uri.fsPath, name: 'a.cpp', first: 3, last: 4, status: 'todo' }, { title: 'Check', file: doc.uri.fsPath, name: 'a.cpp', first: 6, last: 7, status: 'todo' }],
		} as unknown as SideGuide;
		store.update({ guide });
		store.update({ guide: { ...guide, current: 1, steps: [{ ...guide.steps[0], status: 'ok' }, guide.steps[1]] } });
		store.update({ guide: undefined });
		store.update({ callGraph: { state: 'scanning', done: 2, total: 5 } });
		subscriptions.forEach((s) => s.dispose());
		store.update({ engine: 'stopped' }); // no listener

		assert.deepStrictEqual(seen, [
			'engine starting ',
			'engine ready C:/p/build/compile_commands.json',
			'view ns::run 5',
			'view ns::run 7',
			'view - 7',
			'guide Plan 1 0 of 2 steps reviewed',
			'guide Plan 2 1 of 2 steps reviewed',
			'guide closed',
			'graph scanning 2',
		]);
	});

	test('The guide event gives the cause of the change and its author, also for a change with no cause in the store', () => {
		const api = createApi(deps, events, 1);
		const seen: string[] = [];
		const subscription = api.onDidChangeGuide((g) => seen.push(g ? `${g.id} ${g.change} ${g.by} ${g.currentStep}` : 'none'));
		const step = (title: string) => ({ title, file: 'C:/p/src/a.cpp', name: 'a.cpp', first: 1, last: 2, text: 'x', checks: [], status: 'todo' as const });
		const make = (seq: number, owner: string): SideGuide => ({ id: `g${seq}`, owner, title: `Plan ${seq}`, current: 0, seq, steps: [step('A'), step('B')] });
		setStack(store, pushGuide(stackOf(store.state), make(1, 'user')), 'start', 'user');
		setStack(store, pushGuide(stackOf(store.state), make(2, 'ext-a')), 'start', 'ext-a');
		setGuide(store, withStatus(store.state.guide!, 1, 'ok'), 'mark', 'user');
		// a change with no cause in the store: the difference of the guides gives the change, and the user is its author
		store.update({ guide: withCurrent(store.state.guide!, 1) });
		setStack(store, dropGuide(stackOf(store.state), 'g2'), 'close', 'ext-a');
		setStack(store, dropGuide(stackOf(store.state), 'g1'), 'close', 'user');
		subscription.dispose();
		assert.deepStrictEqual(seen, ['g1 start user 1', 'g2 start ext-a 1', 'g2 mark user 1', 'g2 step user 2', 'g1 close ext-a 1', 'none']);
		assert.strictEqual(store.state.guideSeq, 2);
	});

	test('A click on a button goes to the API objects of the client of the item, and an MCP client cannot add buttons', async () => {
		const a = createApi(deps, events, 1, { client: 'ext-a' });
		const b = createApi(deps, events, 1, { client: 'ext-b' });
		const seen: string[] = [];
		const subscriptions = [
			a.onDidInvokeAction((e) => seen.push(`a ${e.kind} ${e.action} ${e.item} ${e.line}`)),
			b.onDidInvokeAction((e) => seen.push(`b ${e.kind} ${e.action} ${e.step}`)),
		];
		assert.strictEqual(events.invokeAction('ext-a', { kind: 'note', action: 'fix', item: 'n2', line: 4 }), true);
		assert.strictEqual(events.invokeAction('ext-b', { kind: 'step', action: 'run', step: 2 }), true);
		// a client with no API object gets no click
		assert.strictEqual(events.invokeAction('ext-c', { kind: 'detail', action: 'open' }), false);
		subscriptions.forEach((s) => s.dispose());
		assert.strictEqual(events.invokeAction('ext-a', { kind: 'note', action: 'fix' }), true);
		assert.deepStrictEqual(seen, ['a note fix n2 4', 'b step run 2']);

		// an MCP client gets no event for a click, so its tools refuse buttons before they change the view
		const mcpTools = createTools(new DataFlowMcpHost({ ...deps.hostDeps, client: () => 'claude-code' }));
		const call = (name: string, args: Record<string, unknown>) => mcpTools.find((t) => t.name === name)!.call(args);
		const actions = [{ id: 'fix', title: 'Fix it' }];
		await assert.rejects(call('highlight', { ranges: [{ lines: [1, 1], kind: 'info', note: 'x', actions }] }), /"actions" need the API for extensions\./);
		await assert.rejects(call('add_detail', { line: 1, text: 'x', actions }), /"actions" need the API for extensions\./);
		await assert.rejects(call('show_review_plan', { steps: [{ title: 'A', lines: [1, 1], text: 'x', actions }] }), /"actions" need the API for extensions\./);
		assert.deepStrictEqual(store.state.modelLayers, []);
	});
});
