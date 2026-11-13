import * as assert from 'assert';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { DataFlowInternals } from '../../extension';
import type { SideGuide } from '../../side/protocol';
import { activateDataFlow, waitFor } from './helpers';

// The diff walk on the review fixture: a git copy of the CMake fixture. The branch review changes the threshold in
// solve_power_plan() from 1e-5 to 1e-4, and the base branch is main. The tests use the command of DataFlow and the
// tools of the MCP host.
suite('Diff walk', () => {
	const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
	const source = () => path.join(root(), 'src', 'battery.cpp');
	const extra = () => path.join(root(), 'src', 'extra.cpp');
	const lineOf = (text: string) => readFileSync(source(), 'utf8').split(/\r?\n/).findIndex((l) => l.includes(text)) + 1;
	const isFile = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

	let api: DataFlowInternals;
	suiteSetup(async function () {
		this.timeout(120000);
		api = await activateDataFlow(source());
	});
	suiteTeardown(async () => {
		await vscode.commands.executeCommand('dataflow.guide.close');
		rmSync(extra(), { force: true });
	});

	const walk = async (base: string): Promise<SideGuide> => {
		const guide = await vscode.commands.executeCommand<SideGuide | undefined>('dataflow.diffWalk.start', base);
		assert.ok(guide, `no walk against ${base}`);
		return guide;
	};

	test('The walk of the branch has a step for the changed function, with the diff and the changed characters', async function () {
		this.timeout(60000);
		const guide = await walk('target');
		const changed = lineOf('if (cost < 1e-4)');
		assert.strictEqual(guide.kind, 'diff');
		assert.strictEqual(guide.title, 'Changes of review against main');
		// main is the merge base itself, so the base has no text "merge base"
		assert.match(guide.base ?? '', /^main \([0-9a-f]{7}\)$/);
		assert.match(guide.baseCommit ?? '', /^[0-9a-f]{40}$/);
		assert.deepStrictEqual(guide.steps.map((s) => [s.title, s.name, s.first, s.last]), [['Changes in solve_power_plan()', 'battery.cpp', changed, changed]]);
		assert.strictEqual(guide.steps[0].text, '1 line added, 1 line removed in `electricity::power_ctrl::solve_power_plan`.');
		const diff = guide.steps[0].diff!;
		assert.deepStrictEqual([diff.plus, diff.minus], [1, 1]);
		assert.deepStrictEqual(diff.added, [[changed, changed]]);
		assert.deepStrictEqual(diff.removed, [{ at: changed, count: 1, texts: ['      if (cost < 1e-5) {'] }]);
		const added = diff.rows.find((r) => r.kind === 'added')!;
		const removed = diff.rows.find((r) => r.kind === 'removed')!;
		assert.strictEqual(added.text.slice(...added.changed!), '4');
		assert.strictEqual(removed.text.slice(...removed.changed!), '5');
		assert.ok(diff.rows.some((r) => r.kind === 'context'));
		// the side view and the text editor show the lines of step 1
		assert.strictEqual(api.store.state.guide?.seq, guide.seq);
		assert.ok(api.side.isOpen);
		await waitFor(() => isFile(api.side.file, source()), 10000, () => `side view: ${api.side.file}`);
		const shown = vscode.window.visibleTextEditors.find((e) => isFile(e.document.uri.fsPath, source()));
		assert.strictEqual(shown?.selection.active.line, changed - 1);
	});

	test('A walk against a branch has the two branches in its title, and a walk against a commit gives the changes since the commit', async function () {
		this.timeout(60000);
		const changed = lineOf('if (cost < 1e-4)');
		const branch = await walk('main');
		assert.strictEqual(branch.title, 'Changes of review against main');
		assert.match(branch.base ?? '', /^main \([0-9a-f]{7}\)$/);
		assert.deepStrictEqual(branch.steps.map((s) => [s.title, s.first]), [['Changes in solve_power_plan()', changed]]);
		// HEAD~1 is the commit of main, but it is not a branch
		const commit = await walk('HEAD~1');
		assert.strictEqual(commit.title, 'Changes since HEAD~1');
		assert.match(commit.base ?? '', /^HEAD~1 \([0-9a-f]{7}\)$/);
		assert.strictEqual(commit.baseCommit, branch.baseCommit);
	});

	test('The walk of the changes that are not committed has the text of an editor and a file that git does not track', async function () {
		this.timeout(60000);
		const fire = lineOf('fire_transition(home_battery_ctl, "", true);');
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(source()));
		await editor.edit((b) => b.insert(new vscode.Position(fire, 0), '  int cycle = 0;\n'));
		writeFileSync(extra(), 'int extra_value() {\n  return 3;\n}\n');
		try {
			const guide = await walk('uncommitted');
			assert.strictEqual(guide.title, 'Changes that are not committed');
			assert.match(guide.base ?? '', /^HEAD \([0-9a-f]{7}\)$/);
			// the committed change is not in the walk. The new line is in process(), and extra.cpp is a new file
			assert.deepStrictEqual(guide.steps.map((s) => [s.title, s.name, s.first, s.last]), [
				['Changes in process()', 'battery.cpp', fire + 1, fire + 1],
				['New file extra.cpp', 'extra.cpp', 1, 3],
			]);
			assert.deepStrictEqual(guide.steps[0].diff!.added, [[fire + 1, fire + 1]]);
			assert.strictEqual(guide.steps[1].text, 'A new file with 3 lines.');
		} finally {
			await vscode.window.showTextDocument(editor.document);
			await vscode.commands.executeCommand('workbench.action.files.revert');
			rmSync(extra(), { force: true });
		}
		assert.ok(!editor.document.isDirty);
	});

	test('An edit moves the steps and their diff, and Next goes to the next step', async function () {
		this.timeout(60000);
		const guide = await walk('target');
		const changed = lineOf('if (cost < 1e-4)');
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(source()));
		await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// one\n// two\n'));
		try {
			await waitFor(() => api.store.state.guide?.steps[0].first === changed + 2, 5000, () => JSON.stringify(api.store.state.guide?.steps[0]).slice(0, 300));
			const step = api.store.state.guide!.steps[0];
			assert.deepStrictEqual(step.diff!.added, [[changed + 2, changed + 2]]);
			assert.deepStrictEqual(step.diff!.removed.map((r) => r.at), [changed + 2]);
			assert.strictEqual(api.store.state.guide!.seq, guide.seq);
		} finally {
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	});

	test('The model gets the hunks with get_diff, show_diff_walk shows its plan with the hunks that the plan does not name, and close_guide closes the walk', async function () {
		this.timeout(90000);
		const changed = lineOf('if (cost < 1e-4)');
		const fire = lineOf('fire_transition(home_battery_ctl, "", true);');
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(source()));
		await editor.edit((b) => b.insert(new vscode.Position(fire, 0), '  int cycle = 0;\n'));
		try {
			// the default base: the changes that are not committed
			const own = await api.mcpHost.diff(undefined, undefined) as { files: { hunks: { id: string; lines: number[] }[] }[] };
			assert.deepStrictEqual(own.files.map((f) => f.hunks.map((h) => [h.id, ...h.lines])), [[['h1', fire + 1, fire + 1]]]);

			const facts = await api.mcpHost.diff('target', ['src']) as {
				base: string; files: { file: string; hunks: { id: string; lines: number[]; functions?: string[]; diff?: string }[] }[];
				suggestedSteps: { title: string; hunks: string[] }[];
			};
			assert.match(facts.base, /^main \([0-9a-f]{7}\)$/);
			assert.deepStrictEqual(facts.files.map((f) => f.file), ['src/battery.cpp']);
			const [h1, h2] = facts.files[0].hunks;
			assert.deepStrictEqual([h1.id, h1.lines, h1.functions], ['h1', [changed, changed], ['electricity::power_ctrl::solve_power_plan']]);
			assert.deepStrictEqual([h2.id, h2.lines, h2.functions], ['h2', [fire + 1, fire + 1], ['electricity::power_ctrl::process']]);
			assert.ok(h1.diff?.includes(`-      |       if (cost < 1e-5) {\n+${String(changed).padStart(5)} |       if (cost < 1e-4) {`), h1.diff);
			assert.deepStrictEqual(facts.suggestedSteps.map((s) => [s.title, s.hunks]), [['Changes in solve_power_plan()', ['h1']], ['Changes in process()', ['h2']]]);

			// a wrong plan: the view does not change
			const before = api.store.state.guide?.seq;
			await assert.rejects(api.mcpHost.showDiffWalk({ steps: [{ title: 'x', text: 'y', hunks: ['h7'] }] }), /h7 is not in the diff\. The hunks of get_diff are h1 to h2\./);
			assert.strictEqual(api.store.state.guide?.seq, before);

			// a plan with the second hunk only: DataFlow adds a step for the first hunk
			const result = await api.mcpHost.showDiffWalk({
				title: 'A counter for the cycles', summary: 'process() counts the cycles.',
				steps: [{ title: 'Count the cycle', text: 'The new variable `cycle` counts nothing yet.', hunks: ['h2'], kind: 'change', checks: ['Is cycle used?'] }],
			}) as { steps: { title: string; addedByDataFlow?: boolean }[]; addedSteps: { hunks: string[] }[] };
			assert.deepStrictEqual(result.steps.map((s) => [s.title, s.addedByDataFlow ?? false]), [['Count the cycle', false], ['Changes in solve_power_plan()', true]]);
			assert.deepStrictEqual(result.addedSteps.map((s) => s.hunks), [['h1']]);
			const guide = api.store.state.guide!;
			assert.strictEqual(guide.kind, 'diff');
			assert.strictEqual(guide.title, 'A counter for the cycles');
			assert.deepStrictEqual(guide.steps.map((s) => [s.first, s.kind]), [[fire + 1, 'change'], [changed, undefined]]);

			// review_step goes to step 2 with a note, and get_view gives the walk
			const step = await api.mcpHost.reviewStep(2, 'The limit is ten times larger.', 'question') as { status: string; progress: string };
			assert.deepStrictEqual([step.status, step.progress], ['question', '1 of 2 steps reviewed: 1 question']);
			const view = await api.mcpHost.view() as { review: { kind: string; currentStep: number; steps: { added: number; removed: number }[] } };
			assert.deepStrictEqual([view.review.kind, view.review.currentStep], ['diff walk', 2]);
			assert.deepStrictEqual(view.review.steps.map((s) => [s.added, s.removed]), [[1, 0], [1, 1]]);

			// close_guide: a different kind or a wrong value does not close the walk. Then the walk closes, and a second
			// call finds no guide
			await assert.rejects(api.mcpHost.closeGuide('review'), /The side view shows a diff walk, not a guided review\. The view did not change\./);
			await assert.rejects(api.mcpHost.closeGuide('walk'), /"kind" must be one of "review", "diff walk"\./);
			assert.strictEqual(api.store.state.guide?.title, 'A counter for the cycles');
			assert.deepStrictEqual(await api.mcpHost.closeGuide('diff walk'),
				{ closed: true, kind: 'diff walk', title: 'A counter for the cycles', steps: 2, progress: '1 of 2 steps reviewed: 1 question' });
			assert.strictEqual(api.store.state.guide, undefined);
			assert.deepStrictEqual(await api.mcpHost.closeGuide(undefined), { closed: false, note: 'No guided review or diff walk shows, so the view did not change.' });

			// a base that git does not find
			await assert.rejects(api.mcpHost.diff('no-such-branch', undefined), /Git does not find the commit no-such-branch/);
		} finally {
			await vscode.window.showTextDocument(editor.document);
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
	});
});
