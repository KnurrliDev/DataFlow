import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type * as Api from '../../../api/dataflow-api';
import type { DataFlowInternals } from '../../extension';
import type { SideGuide } from '../../side/protocol';
import { activateDataFlow, waitFor } from './helpers';

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
	// each test starts with no guide. The guides of a test stay in the stack until they close
	setup(() => internals.store.update({ guide: undefined, guidesBelow: [] }));
	suiteTeardown(async () => {
		await api.clearRipple();
		internals.store.update({ guide: undefined, guidesBelow: [] });
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
		const seen: (Api.GuideEvent | null)[] = [];
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
			assert.deepStrictEqual(closed, { closed: true, id: plan.id, kind: 'review', title: 'The new threshold', steps: 2, progress: '1 of 2 steps reviewed', shows: null });

			const last = seen.filter((g) => g !== null).pop()!;
			assert.deepStrictEqual([last.title, last.currentStep, last.steps.map((s) => s.status)], ['The new threshold', 2, ['todo', 'ok']]);
			assert.strictEqual(seen[seen.length - 1], null);
			// the causes of the events: the start, the mark and the note of the step, then the step that shows
			assert.deepStrictEqual(seen.filter((g) => g !== null).map((g) => `${g!.change} ${g!.by}`), ['start api-review', 'mark api-review', 'step api-review']);
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
				{ closed: true, id: walk.id, kind: 'diff walk', title: 'Only the counter', steps: 1, progress: '0 of 1 steps reviewed', shows: null });
		} finally {
			await vscode.window.showTextDocument(editor.document);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	});

	const planOf = (title: string): Api.ReviewPlanArgs => {
		const changed = lineOf('if (cost < 1e-4)');
		const caller = lineOf('executor.async(');
		return {
			title,
			steps: [
				{ title: 'Check the threshold', file: source(), lines: [changed, changed], text: 'The threshold.' },
				{ title: 'Check the caller', file: source(), lines: [caller, caller], text: 'The caller.' },
			],
		};
	};

	test('The guides of two clients and of the user stay in a stack, and a client changes a guide of a different owner only with force', async function () {
		this.timeout(90000);
		const other = vscode.extensions.getExtension<Api.DataFlowExports>('KnurrliDev.dataflow')!.exports.getApi(1, { client: 'api-review-2' });
		const seen: string[] = [];
		const subscription = api.onDidChangeGuide((g) => seen.push(g ? `${g.title}: ${g.change} by ${g.by}` : 'none'));
		try {
			// the walk of the user at the bottom, the plan of the first client, then the plan of the second client on the top
			const walk = await vscode.commands.executeCommand<SideGuide | undefined>('dataflow.diffWalk.start', 'target');
			assert.ok(walk);
			const mine = await api.showReviewPlan(planOf('My plan'));
			const theirs = await other.showReviewPlan(planOf('Their plan'));
			assert.deepStrictEqual([mine.shown, theirs.shown], [1, 1]);
			const view = await api.getView();
			assert.deepStrictEqual(view.guides?.map((g) => `${g.id} ${g.owner} ${g.kind}`),
				[`${theirs.id} api-review-2 review`, `${mine.id} api-review review`, `${walk.id} user diff walk`]);
			assert.deepStrictEqual([view.review?.id, view.review?.owner], [theirs.id, 'api-review-2']);

			// a change of a guide of a different owner needs force. A step with no change goes to the step
			await assert.rejects(api.reviewStep({ step: 1, status: 'ok' }), new RegExp(`The guide ${theirs.id} "Their plan" belongs to api-review-2, not to your client\\.`));
			await assert.rejects(api.closeGuide({ id: walk.id }), /belongs to user, not to your client\. The view did not change\. If the user asked you to close it/);
			assert.strictEqual((await api.reviewStep({ step: 2 })).isShown, true);
			// my plan under the top guide changes in place, and the view stays
			const inPlace = await api.reviewStep({ id: mine.id, step: 1, status: 'issue', label: 'risk 4', data: { risk: 4 } });
			assert.deepStrictEqual([inPlace.isShown, inPlace.status, internals.store.state.guide?.id], [false, 'issue', theirs.id]);
			assert.deepStrictEqual(internals.store.state.guidesBelow.find((g) => g.id === mine.id)?.steps[0].label, 'risk 4');
			// a step with no change on my plan under the top guide: the plan goes to the step at its place
			const moved = await api.reviewStep({ id: mine.id, step: 2 });
			assert.deepStrictEqual([moved.isShown, internals.store.state.guidesBelow.find((g) => g.id === mine.id)?.current], [false, 1]);
			// a plan with the id of my guide replaces it in its place
			const replaced = await api.showReviewPlan({ ...planOf('My new plan'), id: mine.id });
			assert.deepStrictEqual([replaced.id, replaced.shown], [mine.id, 0]);
			assert.match(replaced.note, new RegExp(`It is under the guide ${theirs.id} "Their plan"`));
			await assert.rejects(api.showReviewPlan({ ...planOf('x'), id: theirs.id }), /belongs to api-review-2\. A plan replaces only a guide of your client/);
			await assert.rejects(api.reviewStep({ id: 'g999', step: 1 }), /No guide has the id g999\. The guides are /);
			// force closes their plan, and my new plan shows again
			const closed = await api.closeGuide({ force: true });
			assert.deepStrictEqual([closed.closed, closed.closed && closed.shows?.id], [true, mine.id]);
			assert.strictEqual(internals.store.state.guide?.title, 'My new plan');

			// the stack has a maximum of 5 guides. The command of the user and a client get no space
			for (const n of [1, 2, 3]) {
				await other.showReviewPlan(planOf(`Plan ${n}`));
			}
			await assert.rejects(other.showReviewPlan(planOf('Plan 4')), /The side view has 5 guides, the maximum/);
			assert.strictEqual(await vscode.commands.executeCommand('dataflow.diffWalk.start', 'target'), undefined);
		} finally {
			subscription.dispose();
		}
		// the events of the first client: each change of the top guide with its cause and its author
		assert.deepStrictEqual(seen, [
			'Changes of review against main: start by user',
			'My plan: start by api-review',
			'Their plan: start by api-review-2',
			'Their plan: step by api-review',
			'My new plan: close by api-review',
			'Plan 1: start by api-review-2',
			'Plan 2: start by api-review-2',
			'Plan 3: start by api-review-2',
		]);
	});

	test('The note of the user, a guide that the user brings to the top, and a close of the user give events of the user', async function () {
		this.timeout(60000);
		const first = await api.showReviewPlan(planOf('First'));
		const second = await api.showReviewPlan(planOf('Second'));
		const seen: string[] = [];
		const subscription = api.onDidChangeGuide((g) => seen.push(g ? `${g.title}: ${g.change} by ${g.by}${g.steps[0].userNote ? ` (${g.steps[0].userNote})` : ''}` : 'none'));
		try {
			internals.side.receive({ type: 'guideUserNote', index: 0, note: '  Why ten times?  ' });
			assert.strictEqual(internals.store.state.guide?.steps[0].userNote, 'Why ten times?');
			// the tab Guide names the guide under the top guide
			assert.deepStrictEqual(internals.side.guideView?.below?.map((g) => [g.id, g.title, g.owner]), [[first.id, 'First', 'api-review']]);
			internals.side.receive({ type: 'guideShow', id: first.id });
			await waitFor(() => internals.store.state.guide?.id === first.id, 5000, () => String(internals.store.state.guide?.id));
			internals.side.receive({ type: 'guideClose' });
			await waitFor(() => internals.store.state.guide?.id === second.id, 5000, () => String(internals.store.state.guide?.id));
			// the facts give the note of the user
			assert.strictEqual((await api.getView()).review?.steps[0].userNote, 'Why ten times?');
		} finally {
			subscription.dispose();
		}
		assert.deepStrictEqual(seen, ['Second: userNote by user (Why ten times?)', 'First: show by user', 'Second: close by user (Why ten times?)']);
	});

	test('A step in a text file opens in the text editor, a step of a new file waits for the file, and an edit moves the steps of the text file', async function () {
		this.timeout(60000);
		const cmake = path.join(root(), 'CMakeLists.txt');
		const isFile = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
		const plan = await api.showReviewPlan({
			title: 'Files that are not C++',
			steps: [
				{ title: 'Read the build', file: 'CMakeLists.txt', lines: [2, 2], text: 'The project.', label: 'risk 2', data: { writer: 'model' } },
				{ title: 'Write the fake solver', newFile: 'tests/fake_solver.hpp', text: 'A new header for the tests.' },
				{ title: 'Back to the code', file: source(), lines: [lineOf('if (cost < 1e-4)'), lineOf('if (cost < 1e-4)')], text: 'The threshold.' },
			],
		});
		assert.deepStrictEqual(plan.steps.map((s) => [path.basename(s.file), s.fileKind]), [['CMakeLists.txt', 'text'], ['fake_solver.hpp', 'new'], ['battery.cpp', undefined]]);
		// step 1 opens CMakeLists.txt in the text editor. The side view keeps its C++ file
		await waitFor(() => vscode.window.visibleTextEditors.some((e) => isFile(e.document.uri.fsPath, cmake)), 5000, () => 'no editor of CMakeLists.txt');
		assert.strictEqual(path.basename(internals.side.file ?? ''), 'battery.cpp');
		// step 2: the new file is not there, so no editor opens
		const step2 = await api.reviewStep({ step: 2 });
		assert.deepStrictEqual([step2.isShown, internals.store.state.guide?.current], [true, 1]);
		const facts = (await api.getView()).review!;
		assert.deepStrictEqual(facts.steps.map((s) => [s.file, s.fileKind ?? 'cpp']), [['CMakeLists.txt', 'text'], ['fake_solver.hpp', 'new'], ['battery.cpp', 'cpp']]);
		assert.deepStrictEqual([facts.steps[0].label, facts.steps[0].data, facts.steps[1].lines], ['risk 2', { writer: 'model' }, [1, 1]]);
		// an edit above the step in CMakeLists.txt moves the step
		const doc = await vscode.workspace.openTextDocument(cmake);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(0, 0), '# a new first line\n');
		await vscode.workspace.applyEdit(edit);
		try {
			await waitFor(() => internals.store.state.guide?.steps[0].first === 3, 5000, () => JSON.stringify(internals.store.state.guide?.steps[0]).slice(0, 300));
		} finally {
			await vscode.window.showTextDocument(doc);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	});

	test('getDiff with allFiles gives the changes of a text file that is not a C or C++ file, and a walk shows them in the text editor', async function () {
		this.timeout(90000);
		const cmake = path.join(root(), 'CMakeLists.txt');
		const doc = await vscode.workspace.openTextDocument(cmake);
		const editor = await vscode.window.showTextDocument(doc);
		await editor.edit((b) => b.insert(new vscode.Position(2, 0), '# a new comment\n'));
		try {
			const cppOnly = await api.getDiff({ base: 'uncommitted' });
			assert.ok(!cppOnly.files.some((f) => f.file === 'CMakeLists.txt'), JSON.stringify(cppOnly.files.map((f) => f.file)));
			const all = await api.getDiff({ base: 'uncommitted', allFiles: true });
			const file = all.files.find((f) => f.file === 'CMakeLists.txt');
			assert.ok(file, JSON.stringify(all.files.map((f) => f.file)));
			assert.deepStrictEqual([file.isCpp, file.hunks.length, file.hunks[0].lines, file.hunks[0].functions, file.hunks[0].heat], [false, 1, [3, 3], undefined, undefined]);
			const walk = await api.showDiffWalk({ title: 'The build', steps: [{ title: 'A new comment', text: 'x', hunks: [file.hunks[0].id] }], allHunks: false });
			assert.deepStrictEqual(walk.steps.map((s) => [path.basename(s.file), s.fileKind]), [['CMakeLists.txt', 'text']]);
			assert.deepStrictEqual(internals.store.state.guide?.steps[0].diff?.added, [[3, 3]]);
		} finally {
			await vscode.window.showTextDocument(doc);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	});

	test('A mark keeps the files, and getDiff and startRipple with the mark give the changes since the mark', async function () {
		this.timeout(120000);
		const fire = lineOf('fire_transition(home_battery_ctl, "", true);');
		const mark = await api.markBase({ name: 'step-1', paths: ['src'] });
		assert.deepStrictEqual([mark.name, mark.paths], ['step-1', ['src']]);
		assert.ok(mark.files >= 3 && mark.bytes > 0, JSON.stringify(mark));
		assert.deepStrictEqual((await api.getView()).marks?.map((m) => m.name), ['step-1']);
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(source()));
		await editor.edit((b) => b.insert(new vscode.Position(fire, 0), '  int cycle = 0;\n'));
		try {
			// only the change after the mark. The change of the branch is in the mark too
			const diff = await api.getDiff({ base: 'mark:step-1' });
			assert.deepStrictEqual(diff.files.map((f) => [f.file, f.hunks.map((h) => h.lines)]), [['src/battery.cpp', [[fire + 1, fire + 1]]]]);
			assert.strictEqual(diff.base, 'mark step-1');
			// Change Ripple of the same changes, then of a different base with paths
			const ripple = await api.startRipple({ base: 'mark:step-1' });
			assert.strictEqual(ripple.state, 'ready', JSON.stringify(ripple).slice(0, 400));
			assert.deepStrictEqual(ripple.changes?.map((c) => [c.file, c.lines]), [['src/battery.cpp', [fire + 1]]]);
			const uncommitted = await api.startRipple({ base: 'uncommitted', paths: ['src/battery.cpp'] });
			assert.deepStrictEqual(uncommitted.changes?.map((c) => c.lines), [[fire + 1]]);
			// a mark that the client does not have
			await assert.rejects(api.getDiff({ base: 'mark:none' }), /Your client has no mark none\. Its marks are step-1\./);
			const none = await api.startRipple({ base: 'mark:none' });
			assert.deepStrictEqual([none.state, none.message], ['failed', 'Your client has no mark none. Its marks are step-1. mark_base makes a mark.']);
		} finally {
			await vscode.window.showTextDocument(editor.document);
			await vscode.commands.executeCommand('workbench.action.files.revert');
			await api.clearRipple();
		}
		await assert.rejects(api.markBase({ name: 'outside', paths: ['../elsewhere'] }), /These paths are not in a folder of the project: \.\.\/elsewhere\. No mark changed\./);
		assert.deepStrictEqual(await api.deleteMark({ name: 'step-1' }), { deleted: true, marks: [] });
	});
});
