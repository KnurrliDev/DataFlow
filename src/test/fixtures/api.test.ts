import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type * as Api from '../../../api/dataflow-api';
import type { DataFlowInternals } from '../../extension';
import type { Lens } from '../../state/store';
import { activateDataFlow, waitFor } from './helpers';

// The API for other extensions on the CMake fixture: an extension gets the API from the exports of DataFlow, reads the
// facts of the lenses, and changes the side view
suite('API for other extensions on the fixture', () => {
	const file = () => path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'battery.cpp');
	const lineOf = (text: string) => readFileSync(file(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;
	const PROCESS = 'electricity::power_ctrl::process';

	let internals: DataFlowInternals;
	let exports: Api.DataFlowExports;
	let api: Api.DataFlowApi;
	let lenses: Record<Lens, boolean>;

	suiteSetup(async function () {
		this.timeout(120000);
		internals = await activateDataFlow(file());
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()), vscode.ViewColumn.One);
		exports = vscode.extensions.getExtension<Api.DataFlowExports>('KnurrliDev.dataflow')!.exports;
		api = exports.getApi(1, { client: 'api-test' });
		lenses = { ...internals.store.state.lenses };
	});

	// the later tests of the group start with the same lenses, and with no trace and no layer of the API
	suiteTeardown(async () => {
		for (const [lens, isOn] of Object.entries(lenses)) {
			if (internals.store.state.lenses[lens as Lens] !== isOn) {
				await api.setLens({ lens: lens as Api.LensName, on: isOn });
			}
		}
		await api.clear();
		await api.clearFlow();
	});

	test('The exports give the API with the tools of the MCP server and the state of the engine', async () => {
		assert.throws(() => exports.getApi(2 as 1), /DataFlow has no API version 2/);
		assert.strictEqual(api.engineState, 'ready');
		assert.ok(api.compileDatabases.length > 0, JSON.stringify(api.compileDatabases));
		assert.strictEqual(api.tools.length, 33);
		assert.strictEqual(api.engineError, undefined);
		const view = await api.getView();
		assert.deepStrictEqual([view.file, view.engine], [file(), 'ready']);
		assert.strictEqual((await api.callTool('get_view') as Api.ViewFacts).file, file());
		const functions = await api.listFunctions();
		assert.ok(functions.functions.some((f) => f.name === PROCESS), JSON.stringify(functions.functions.map((f) => f.name)));
	});

	test('getLogic gives the decisions and the path for the choices, and showLogicPath shows the path in Logic Map', async function () {
		this.timeout(60000);
		const logic = await api.getLogic({ function: 'process' });
		assert.strictEqual(logic.function.name, PROCESS);
		const chain = logic.decisions.find((d) => d.kind === 'chain');
		assert.ok(chain, JSON.stringify(logic.decisions));
		assert.ok(chain.options.includes('HOMEPOWER_CHARGE_ACTIVE'), JSON.stringify(chain));
		const choices = { [chain.key]: 'HOMEPOWER_CHARGE_ACTIVE' };
		const chosen = await api.getLogic({ function: 'process', choices });
		assert.strictEqual(chosen.path.find((s) => s.key === chain.key)?.option, 'HOMEPOWER_CHARGE_ACTIVE');
		assert.ok(chosen.decisions.find((d) => d.key === chain.key)?.isChosen);
		// the branch of HOMEPOWER_CHARGE_PLANNING is dead on this path
		assert.ok(chosen.deadLines.includes(lineOf('if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING)') + 1), JSON.stringify(chosen.deadLines));
		await assert.rejects(api.getLogic({ function: 'process', choices: { nope: 'yes' } }), /The function has no decision nope\./);

		const shown = await api.showLogicPath({ function: 'process', choices });
		assert.strictEqual(shown.shown, true);
		const store = internals.store;
		const describe = () => JSON.stringify({ fn: store.state.fn?.qualifiedName, chosen: store.state.logicPath?.chosen, lens: store.state.lenses.logic });
		await waitFor(() => store.state.logicPath?.fn.qualifiedName === PROCESS && store.state.logicPath.chosen.includes(chain.key), 10000, describe);
		// the cursor went to the function, and Logic Map keeps the choice after the update of the cursor
		await waitFor(() => store.state.fn?.qualifiedName === PROCESS, 10000, describe);
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.ok(store.state.logicPath?.chosen.includes(chain.key), describe());
		assert.deepStrictEqual(store.state.logicPath!.view.dead.map((l) => l + 1), chosen.deadLines);
	});

	test('showLine moves the cursor, and onDidChangeView gives the line and its function', async function () {
		this.timeout(30000);
		const line = lineOf('return requests;');
		const seen = new Promise<Api.ViewEvent>((resolve) => {
			const subscription = api.onDidChangeView((e) => {
				if (e.line === line) {
					subscription.dispose();
					resolve(e);
				}
			});
		});
		const res = await api.showLine({ line });
		assert.deepStrictEqual([res.file, res.line, res.text], [file(), line, 'return requests;']);
		const event = await seen;
		assert.deepStrictEqual([event.file, event.function?.name], [file(), PROCESS]);
		await assert.rejects(api.showLine({ line: 100000 }), /battery\.cpp has \d+ lines\./);
	});

	test('setLens turns a lens on and off, and clearFlow removes the trace of showFlow', async function () {
		this.timeout(30000);
		const heatWasOn = internals.store.state.lenses.heat;
		const on = await api.setLens({ lens: 'heat', on: !heatWasOn });
		assert.deepStrictEqual([on.changed, internals.store.state.lenses.heat], [true, !heatWasOn]);
		const back = await api.setLens({ lens: 'heat', on: heatWasOn });
		assert.deepStrictEqual([back.changed, internals.store.state.lenses.heat], [true, heatWasOn]);
		await assert.rejects(api.setLens({ lens: 'colors' as Api.LensName, on: true }), /"lens" must be one of/);

		const flow = await api.showFlow({ line: lineOf('auto cur_tariff_plan'), name: 'cur_tariff_plan' });
		assert.deepStrictEqual([flow.kind, flow.shown], ['variable', true]);
		await waitFor(() => internals.store.state.trace?.variables.some((v) => v.name === 'cur_tariff_plan') === true, 10000, () => 'no trace');
		assert.deepStrictEqual(await api.clearFlow(), { cleared: true });
		assert.strictEqual(internals.store.state.trace, undefined);
		assert.deepStrictEqual(await api.clearFlow(), { cleared: false });
	});

	test('The blocks of the API show the name of its client, and the scan of the call graph sends events', async function () {
		this.timeout(120000);
		const structure = await api.getStructure({ function: 'process' });
		const first = structure.statements[0].lines;
		const blocks = await api.showBlocks({ function: 'process', blocks: [{ lines: first, title: 'Read the tariff plans' }] });
		assert.strictEqual(blocks.shown, 1);
		const layer = internals.store.state.modelLayers.find((l) => l.file === file());
		assert.strictEqual(layer?.client, 'api-test');
		assert.deepStrictEqual(await api.clear({ file: file() }), { removed: 1 });

		const states: string[] = [];
		const subscription = api.onDidChangeCallGraph((c) => states.push(c.state));
		try {
			const scan = await api.scanCallGraph();
			assert.ok(['scanning', 'ready'].includes(scan.state), JSON.stringify(scan));
			await waitFor(() => states.includes('ready'), 90000, () => states.join(', '));
			const stop = await api.stopCallGraph();
			assert.deepStrictEqual([stop.stopped, stop.state], [false, 'ready']);
			assert.ok(stop.lastScan!.functions > 0, JSON.stringify(stop.lastScan));
			// the state with no scan
			const graph = await api.getCallGraph();
			assert.deepStrictEqual([graph.state, graph.lastScan?.functions], ['ready', stop.lastScan!.functions]);
		} finally {
			subscription.dispose();
		}

		// the heat of the lines of process(): only process(), with its reach from the call graph and the signals
		const start = lineOf('std::optional<Requests> process(');
		const heat = await api.getHeat({ lines: [start, start] });
		assert.deepStrictEqual(heat.functions.map((f) => f.name), [PROCESS]);
		const fn = heat.functions[0];
		assert.strictEqual(fn.isReachComplete, true);
		assert.ok(fn.signals.some((s) => s.id === 'decisions' && s.value > 10), JSON.stringify(fn.signals));
		assert.deepStrictEqual(fn.signals.map((s) => s.text), fn.reasons.map((r) => r.replace(/ \(\+\d+ \w+\)$/, '')));
		const none = await api.getHeat({ lines: [1, 1] });
		assert.deepStrictEqual(none.functions, []);
		assert.match(none.note ?? '', /^No function has a line in the lines 1 to 1 of battery\.cpp\.$/);
		await assert.rejects(api.getHeat({ lines: [5, 2] }), /"lines" must be two line numbers from 1/);
	});
});
