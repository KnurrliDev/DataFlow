import * as assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FileResult, PlaceModel } from '../../engine/client';
import { callGraphFacts, DataFlowMcpHost, type HostDeps } from '../../mcp/host';
import { StateStore } from '../../state/store';

// The facts of a line and of the call graph for the model and for the API, from the data of the engine: the names in
// scope at a line, and the main loops
suite('Place and main loops', () => {
	test('get_call_graph gives the main loops of the last complete scan', () => {
		const facts = callGraphFacts({
			state: 'ready', done: 2, total: 2,
			result: {
				units: 2, scanned: 2, isComplete: true, functions: 5, calls: 4, ms: 10, failed: [],
				frames: [{ name: 'update', file: '/p/main.cpp', line: 3, reason: 'called in the main loop of main' }],
				mainLoops: [{ function: 'main', file: '/p/main.cpp', line: 12 }],
			},
		});
		assert.deepStrictEqual(facts.lastScan?.mainLoops, [{ function: 'main', file: '/p/main.cpp', line: 12 }]);
		assert.deepStrictEqual(facts.lastScan?.frames, [{ function: 'update', file: '/p/main.cpp', line: 3, reason: 'called in the main loop of main' }]);
	});

	test('get_place gives the names in scope, and isMainLoop for a loop of a complete call graph', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-place-'));
		// VS Code opens an .inc file as plain text. A C++ file would start DataFlow before the test "The extension is not
		// active before its command starts"
		const file = path.join(dir, 'main.inc');
		writeFileSync(file, ['int main() {', '  int count = 0;', '  while (true) {', '    ++count;', '  }', '}', ''].join('\n'));
		const store = new StateStore();
		const model: FileResult & PlaceModel = {
			file, parsed: true, parseMs: 1, parseCount: 1, errorCount: 0, errors: [], analysisMs: 1,
			function: { name: 'main', qualifiedName: 'main', kind: 'function', range: { begin: { line: 1, col: 1 }, end: { line: 6, col: 1 } } },
			isInBody: true,
			around: [{ kind: 'while', first: 3, last: 5, text: 'true', isOpenLoop: true, isMainLoop: true }],
			locks: [],
			inScope: [{ name: 'count', type: 'int', kind: 'local' }],
			isInScopeCapped: true,
			reach: { callers: 0, transitiveCallers: 0, callerFiles: 0 },
			callGraph: { state: 'ready' },
		};
		const deps = {
			store,
			engine: () => ({ currentState: 'ready', threads: () => Promise.reject(new Error('no threads')) }),
			roots: () => [dir],
			flushChange: () => undefined,
			asyncFunctions: () => [],
			place: async () => model,
		} as unknown as HostDeps;
		try {
			const facts = await new DataFlowMcpHost(deps).place(file, 4);
			assert.deepStrictEqual(facts.around, [{ kind: 'while', lines: [3, 5], text: 'true', isOpenLoop: true, isMainLoop: true }]);
			assert.deepStrictEqual([facts.inScope, facts.isInScopeCapped], [[{ name: 'count', type: 'int', kind: 'local' }], true]);

			// with no complete call graph, a loop has no isMainLoop. The names in scope need no call graph
			model.around = [{ kind: 'while', first: 3, last: 5, text: 'true', isOpenLoop: true }];
			model.isInScopeCapped = undefined;
			model.reach = null;
			model.callGraph = { state: 'none' };
			const before = await new DataFlowMcpHost(deps).place(file, 4);
			assert.deepStrictEqual([before.around[0].isMainLoop, before.isInScopeCapped, before.inScope, before.isReachComplete],
				[undefined, undefined, [{ name: 'count', type: 'int', kind: 'local' }], false]);
		} finally {
			store.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
