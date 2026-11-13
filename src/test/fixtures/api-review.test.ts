import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type * as Api from '../../../api/dataflow-api';
import type { DataFlowInternals } from '../../extension';
import { activateDataFlow } from './helpers';

// The API for other extensions on the review fixture: a git copy of the CMake fixture. The branch review changes the
// threshold in solve_power_plan() from 1e-5 to 1e-4, and the base branch is main. An extension runs Change Ripple,
// reads its facts, and follows a guided review with the events of the guide
suite('API for other extensions: Change Ripple and the guide', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	const source = () => path.join(root(), 'src', 'battery.cpp');
	const lineOf = (text: string) => readFileSync(source(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;

	let internals: DataFlowInternals;
	let api: Api.DataFlowApi;
	suiteSetup(async function () {
		this.timeout(120000);
		internals = await activateDataFlow(source());
		api = vscode.extensions.getExtension<Api.DataFlowExports>('KnurrliDev.dataflow')!.exports.getApi(1, { client: 'api-review' });
	});
	suiteTeardown(async () => {
		await api.clearRipple();
		await api.closeGuide();
	});

	test('startRipple runs Change Ripple and gives its facts, getRipple gives them again, and clearRipple closes it', async function () {
		this.timeout(90000);
		const facts = await api.startRipple();
		assert.strictEqual(facts.state, 'ready', JSON.stringify(facts).slice(0, 500));
		assert.match(facts.base ?? '', /^main \(merge base [0-9a-f]{7}\)$/);
		const [change] = facts.changes!;
		assert.deepStrictEqual([change.file, change.function, change.lines], ['src/battery.cpp', 'electricity::power_ctrl::solve_power_plan', [lineOf('if (cost < 1e-4)')]]);
		const body = change.bodies.find((b) => b.depth === 0)!;
		assert.ok(body.lines.includes(lineOf('return res;')), JSON.stringify(body.lines));
		assert.ok(body.exits.some((e) => e.kind === 'return'), JSON.stringify(body.exits));
		assert.ok(change.bodies.some((b) => b.steps.some((s) => s.kind === 'async' && s.line === lineOf('executor.async('))), JSON.stringify(change.bodies.map((b) => b.function)));
		// the test build of VS Code has no call hierarchy provider
		assert.match(facts.notice ?? '', /call hierarchy/);
		assert.deepStrictEqual(await api.getRipple(), facts);

		assert.deepStrictEqual(await api.clearRipple(), { cleared: true });
		assert.strictEqual(internals.store.state.review, undefined);
		assert.strictEqual((await api.getRipple()).state, 'none');
		assert.deepStrictEqual(await api.clearRipple(), { cleared: false });
	});

	test('onDidChangeGuide follows a guided review of the API: the plan, a step with a mark, and the close', async function () {
		this.timeout(60000);
		const seen: (Api.GuideFacts | null)[] = [];
		const subscription = api.onDidChangeGuide((g) => seen.push(g));
		try {
			const changed = lineOf('if (cost < 1e-4)');
			const plan = await api.showReviewPlan({
				title: 'The new threshold', summary: 'solve_power_plan() accepts a larger cost.',
				steps: [
					{ title: 'Check the threshold', file: source(), lines: [changed, changed], text: 'The threshold is ten times larger.', kind: 'change' },
					{ title: 'Check the caller', file: source(), lines: [lineOf('executor.async('), lineOf('executor.async(')], text: 'process() starts the solver.', kind: 'ripple' },
				],
			});
			assert.deepStrictEqual(plan.steps.map((s) => s.title), ['Check the threshold', 'Check the caller']);
			assert.strictEqual(internals.store.state.guide?.client, 'api-review');
			const step = await api.reviewStep({ step: 2, status: 'ok', note: 'The caller keeps the result.' });
			assert.deepStrictEqual([step.status, step.progress], ['ok', '1 of 2 steps reviewed']);
			const closed = await api.closeGuide({ kind: 'review' });
			assert.deepStrictEqual(closed, { closed: true, kind: 'review', title: 'The new threshold', steps: 2, progress: '1 of 2 steps reviewed' });

			const last = seen.filter((g) => g !== null).pop()!;
			assert.deepStrictEqual([last.title, last.currentStep, last.steps.map((s) => s.status)], ['The new threshold', 2, ['todo', 'ok']]);
			assert.strictEqual(seen[seen.length - 1], null);
		} finally {
			subscription.dispose();
		}
	});

	test('showDiffWalk with allHunks false shows only the hunks of the plan, and names the other hunks', async function () {
		this.timeout(90000);
		const fire = lineOf('fire_transition(home_battery_ctl, "", true);');
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(source()));
		await editor.edit((b) => b.insert(new vscode.Position(fire, 0), '  int cycle = 0;\n'));
		try {
			const diff = await api.getDiff({ base: 'target', paths: ['src'] });
			const ids = diff.files.flatMap((f) => f.hunks.map((h) => h.id));
			assert.deepStrictEqual(ids, ['h1', 'h2'], JSON.stringify(diff.files));
			// the heat of the changed functions tells if their reach is complete
			assert.ok(diff.files.flatMap((f) => f.hunks).every((h) => (h.heat ?? []).every((x) => typeof x.isReachComplete === 'boolean')));
			const walk = await api.showDiffWalk({
				title: 'Only the counter', steps: [{ title: 'Count the cycle', text: 'A new counter.', hunks: ['h2'] }], allHunks: false,
			});
			assert.deepStrictEqual([walk.steps.map((s) => s.title), walk.notShown, walk.addedSteps], [['Count the cycle'], ['h1'], undefined]);
			assert.deepStrictEqual(internals.store.state.guide?.steps.map((s) => s.title), ['Count the cycle']);
			assert.deepStrictEqual(await api.closeGuide({ kind: 'diff walk' }),
				{ closed: true, kind: 'diff walk', title: 'Only the counter', steps: 1, progress: '0 of 1 steps reviewed' });
		} finally {
			await vscode.window.showTextDocument(editor.document);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	});
});
