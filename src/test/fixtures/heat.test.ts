import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DataFlowApi } from '../../extension';
import type { SideGuide } from '../../side/protocol';
import { activateDataFlow, waitFor } from './helpers';

// The heat score on the review fixture: a git copy of the CMake fixture with the commit of the branch main and the
// commit of the branch review. The commit of review changes one line of solve_power_plan(). battery.cpp and main.cpp
// include types.hpp.
suite('Heat', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	const source = () => path.join(root(), 'src', 'battery.cpp');

	interface HeatResult {
		functions: { name: string; score: number; band: string; flames: number; reach: number; risk: number; history: number; reasons: string[] }[];
		notices: string[];
		callGraph?: string;
	}

	let api: DataFlowApi;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(source());
		if (api.store.state.lenses.review) {
			api.side.receive({ type: 'toggleLens', lens: 'review' });
		}
	});

	test('get_heat gives the score of each function with the reasons of reach, risk and history, the hottest first', async function () {
		this.timeout(60000);
		const res = await api.mcpHost.heat(source(), undefined) as HeatResult;
		assert.strictEqual(res.functions.length, 6);
		const scores = res.functions.map((f) => f.score);
		assert.deepStrictEqual(scores, [...scores].sort((a, b) => b - a));
		for (const f of res.functions) {
			assert.strictEqual(f.score, f.reach + f.risk + f.history, JSON.stringify(f));
			assert.ok(f.flames >= 1 && f.flames <= 5, JSON.stringify(f));
		}

		// the lines of solve_power_plan() come from the commit of main and from the commit of review. Both are new
		const plan = res.functions.find((f) => f.name === 'electricity::power_ctrl::solve_power_plan')!;
		assert.ok(plan.reasons.includes('Changed in 2 commits (+3 history)'), JSON.stringify(plan));
		assert.ok(plan.reasons.includes('Changed in the last 30 days (+2 history)'), JSON.stringify(plan));
		// types.hpp has the declaration of process(), and both source files include it
		const process = res.functions.find((f) => f.name === 'electricity::power_ctrl::process')!;
		assert.ok(process.reasons.includes('types.hpp with the declaration is in 2 of 2 source files (+8 reach)'), JSON.stringify(process));
		assert.ok(process.reasons.some((r) => /^\d+ decisions \(\+\d+ risk\)$/.test(r)), JSON.stringify(process));

		// the first call starts the scan of the call graph and does not wait for it. The scan of two source files can end
		// before the result. get_diff of the tests of the diff walk can also start the scan before this test
		assert.ok(api.store.state.callGraph?.state === 'ready' || /^The (scan of the call graph runs|call graph is not complete)/.test(res.notices[0] ?? ''),
			JSON.stringify(res.notices));
		await waitFor(() => api.store.state.callGraph?.state === 'ready', 60000, () => JSON.stringify(api.store.state.callGraph));
		assert.deepStrictEqual([api.store.state.callGraph?.result?.units, api.store.state.callGraph?.result?.failed], [2, []]);

		// with the call graph: main() in main.cpp calls process()
		const later = await api.mcpHost.heat(source(), 'process') as HeatResult;
		assert.deepStrictEqual(later.functions.map((f) => f.name), ['electricity::power_ctrl::process']);
		assert.ok(later.functions[0].reasons.includes('1 function calls it directly (+2 reach)'), JSON.stringify(later));
		assert.ok(later.functions[0].reasons.includes('Callers in 1 other file (+1 reach)'), JSON.stringify(later));
		assert.ok(!later.notices.some((n) => n.includes('call graph')) && later.callGraph === undefined, JSON.stringify(later));

		// a name that the file does not have
		await assert.rejects(api.mcpHost.heat(source(), 'no_such_function'), /No function no_such_function in battery\.cpp/);
	});

	test('A frame function of the setting puts the functions that it calls on the frame path', async function () {
		this.timeout(60000);
		// main() calls process() in a loop with a fixed number of iterations. Thus main() is no frame function of the engine
		const config = vscode.workspace.getConfiguration('dataflow');
		await config.update('heat.frameFunctions', ['main'], vscode.ConfigurationTarget.Workspace);
		try {
			const res = await api.mcpHost.heat(source(), 'process') as HeatResult;
			const reasons = res.functions[0].reasons;
			assert.ok(reasons.includes('On the frame path: main (frame function of the setting), then electricity::power_ctrl::process (+40 reach)'), JSON.stringify(res));
			assert.ok(reasons.includes('A caller on the frame path calls it in a loop (+10 reach)'), JSON.stringify(res));
		} finally {
			await config.update('heat.frameFunctions', undefined, vscode.ConfigurationTarget.Workspace);
		}
	});

	test('The lens Heat gives the side view the heat of each function, and the lens off removes it', async function () {
		this.timeout(60000);
		assert.strictEqual(api.store.state.lenses.heat, false);
		api.side.receive({ type: 'toggleLens', lens: 'heat' });
		try {
			await waitFor(() => !!api.side.heat && !api.side.heat.isLoading && api.side.heat.functions.length === 6, 30000,
				() => JSON.stringify(api.side.heat)?.slice(0, 300));
			const heat = api.side.heat!;
			assert.deepStrictEqual(heat.functions.map((f) => f.name), ['best_preset', 'log_info', 'initial_power', 'solve_power_plan', 'process', 'stable_readings']);
			assert.ok(heat.functions.every((f) => f.first <= f.nameLine && f.nameLine <= f.last), JSON.stringify(heat.functions));
			assert.strictEqual(heat.error, undefined);
			// the side view gets the data of the call graph
			assert.deepStrictEqual([heat.graph?.state, heat.graph?.units, heat.graph?.failed], ['ready', 2, 0]);

			// the button of the tab starts an update. The first update can parse battery.cpp, because the tests of the diff walk
			// changed its text in the editor after the scan. A second update with no change parses no source file
			for (let i = 0; i < 2; i++) {
				const before = api.store.state.callGraph?.result;
				api.side.receive({ type: 'heatScan' });
				await waitFor(() => api.store.state.callGraph?.state === 'ready' && api.store.state.callGraph.result !== before, 30000,
					() => JSON.stringify(api.store.state.callGraph));
			}
			assert.strictEqual(api.store.state.callGraph?.result?.scanned, 0);
		} finally {
			api.side.receive({ type: 'toggleLens', lens: 'heat' });
		}
		await waitFor(() => api.side.heat === null, 5000, () => JSON.stringify(api.side.heat)?.slice(0, 200));
		assert.strictEqual(api.store.state.heatLayer, undefined);
	});

	test('get_diff and get_review give the heat of the changed functions, and hottestChanges gives them, the hottest first', async function () {
		this.timeout(90000);
		// the branch review changes one line of solve_power_plan(). The call graph is complete, thus the scores stay the same
		const diff = await api.mcpHost.diff('target', ['src']) as {
			files: { file: string; hunks: { id: string; heat?: { function: string; score: number; band: string }[] }[] }[];
			hottestChanges: { function: string; file: string; score: number; band: string; reasons: string[]; hunks: string[] }[];
			suggestedSteps: { hunks: string[]; heat?: number }[];
		};
		const plan = diff.hottestChanges[0];
		assert.deepStrictEqual([diff.hottestChanges.length, plan.function, plan.file, plan.hunks], [1, 'electricity::power_ctrl::solve_power_plan', 'src/battery.cpp', ['h1']]);
		assert.ok(plan.score > 0 && plan.reasons.length > 0 && plan.reasons.length <= 3, JSON.stringify(plan));
		assert.deepStrictEqual(diff.files[0].hunks[0].heat?.map((h) => [h.function, h.score, h.band]), [[plan.function, plan.score, plan.band]]);
		assert.strictEqual(diff.suggestedSteps[0].heat, plan.score);

		// the other files of the folder have no changes, thus they have no changed functions
		const review = await api.mcpHost.review(['src']) as {
			files: { file: string; changedFunctions?: { function: string; score: number }[] }[];
			hottestChanges: { function: string; file: string; score: number }[];
		};
		const files = Object.fromEntries(review.files.map((f) => [f.file, f.changedFunctions?.map((c) => [c.function, c.score])]));
		assert.deepStrictEqual(files['src/battery.cpp'], [[plan.function, plan.score]]);
		assert.ok(review.files.length > 1 && Object.entries(files).every(([f, fns]) => f === 'src/battery.cpp' || fns === undefined), JSON.stringify(files));
		assert.deepStrictEqual(review.hottestChanges.map((c) => [c.function, c.file, c.score]), [[plan.function, 'src/battery.cpp', plan.score]]);
	});

	test('With the lens Heat on, each step of the tab Guide gets the heat of its hottest function', async function () {
		this.timeout(60000);
		const guide = await vscode.commands.executeCommand<SideGuide | undefined>('dataflow.diffWalk.start', 'target');
		try {
			assert.ok(guide);
			// the lens Heat is off: the steps have no heat
			assert.ok(api.side.guideView?.steps.every((s) => s.heat === undefined), JSON.stringify(api.side.guideView?.steps));
			api.side.receive({ type: 'toggleLens', lens: 'heat' });
			await waitFor(() => !!api.side.guideView?.steps[0].heat, 30000, () => JSON.stringify(api.store.state.guideHeat));
			const heat = api.side.guideView!.steps[0].heat!;
			assert.strictEqual(heat.name, 'electricity::power_ctrl::solve_power_plan');
			assert.ok(heat.score > 0 && heat.flames >= 1 && heat.flames <= 5, JSON.stringify(heat));
			// the store keeps the guide with no heat, because the workspace stores the guide
			assert.ok(api.store.state.guide?.steps.every((s) => s.heat === undefined));

			// the lens off removes the heat of the steps
			api.side.receive({ type: 'toggleLens', lens: 'heat' });
			await waitFor(() => api.side.guideView?.steps.every((s) => s.heat === undefined) === true, 5000, () => JSON.stringify(api.side.guideView?.steps));
		} finally {
			if (api.store.state.lenses.heat) {
				api.side.receive({ type: 'toggleLens', lens: 'heat' });
			}
			await vscode.commands.executeCommand('dataflow.guide.close');
		}
	});
});
