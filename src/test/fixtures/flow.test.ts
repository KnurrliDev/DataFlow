import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activateDataFlow, openAt, waitFor } from './helpers';

// Acceptance scenario 1 on the CMake fixture: Flow Lens on bestFit in initial_power() marks line 46 as an unchecked
// optional access. The side view shows the trace. Phase S2 tests the side view in more detail.
suite('P2 acceptance scenario 1: Flow Lens', () => {
	const file = () => path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'battery.cpp');

	test('Flow Lens marks the unchecked access to bestFit', async function () {
		this.timeout(120000);
		const api = await activateDataFlow(file());
		const state = () => JSON.stringify({ engine: api.store.state.engine, trace: api.store.state.trace?.view });

		await openAt(file(), 41, 12);
		const t0 = Date.now();
		await vscode.commands.executeCommand('dataflow.traceVariable');
		const first = Date.now() - t0;
		await waitFor(() => api.store.state.trace?.view.name === 'bestFit', 30000, state);
		const view = api.store.state.trace!.view;
		assert.deepStrictEqual(view.findings, [{ line: 45, text: 'optional not checked here' }]);
		assert.deepStrictEqual(view.marks.filter((m) => m.finding).map((m) => m.line), [45]);

		// The side view opens. Each mark covers the name of the variable, so the columns are correct. Lines start at 1
		await waitFor(() => api.side.flow?.name === 'bestFit', 5000, state);
		const flow = api.side.flow!;
		const doc = vscode.window.activeTextEditor!.document;
		for (const mark of flow.marks) {
			assert.strictEqual(doc.getText(new vscode.Range(mark.line - 1, mark.start, mark.line - 1, mark.end)), 'bestFit', JSON.stringify(mark));
		}
		assert.deepStrictEqual(flow.findings, [{ line: 46, text: 'optional not checked here' }]);

		// The rail starts with the dot of the definition on line 41. The segment to line 46 is a problem segment.
		assert.ok(flow.lanes[0].nodes.some((n) => n.line === 41 && n.isDef), JSON.stringify(flow.lanes[0].nodes));
		assert.ok(flow.lanes[0].segments.some((s) => s.to === 46 && s.isProblem), JSON.stringify(flow.lanes[0].segments));
		assert.ok(!flow.lanes[0].segments.some((s) => s.to <= 42 && s.isProblem), JSON.stringify(flow.lanes[0].segments));

		// A second variable of the same function. The flow model comes from the cache of the extension.
		await openAt(file(), 40, 9);
		const t1 = Date.now();
		await vscode.commands.executeCommand('dataflow.traceVariable');
		const cached = Date.now() - t1;
		assert.strictEqual(api.store.state.trace?.view.name, 'usePreset');
		console.log(`trace: first ${first} ms, from the cache ${cached} ms`);

		// The next tests start with bestFit.
		await openAt(file(), 41, 12);
		await vscode.commands.executeCommand('dataflow.traceVariable');
		assert.strictEqual(api.store.state.trace?.view.name, 'bestFit');
	});

	test('After an edit, the trace moves with the code', async function () {
		this.timeout(60000);
		const api = await activateDataFlow(file());
		const state = () => JSON.stringify(api.store.state.trace?.view.findings);
		const editor = vscode.window.activeTextEditor!;
		try {
			await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '// a line from the test\n'));
			await waitFor(() => api.store.state.trace?.view.findings[0]?.line === 46, 15000, state);
			assert.strictEqual(api.store.state.trace?.view.name, 'bestFit');
		} finally {
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
		await waitFor(() => api.store.state.trace?.view.findings[0]?.line === 45, 15000, state);
	});

	// Flow Lens always follows the cursor. There is no setting for it
	test('Flow Lens traces the variable at the cursor', async function () {
		this.timeout(60000);
		const api = await activateDataFlow(file());
		const state = () => JSON.stringify({ trace: api.store.state.trace?.view.name });
		await openAt(file(), 51, 47);
		await waitFor(() => api.store.state.trace?.view.name === 'startPlans', 15000, state);
		const view = api.store.state.trace!.view;
		assert.strictEqual(view.counts.mayWrite, 5);
		assert.deepStrictEqual(view.findings, []);
		assert.strictEqual(view.lanes.length, 1);
	});

	test('Clear Trace removes the trace from the side view', async () => {
		const api = await activateDataFlow(file());
		await vscode.commands.executeCommand('dataflow.clearTrace');
		assert.strictEqual(api.store.state.trace, undefined);
		assert.strictEqual(api.side.flow, null);
	});
});
