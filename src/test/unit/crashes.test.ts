import * as assert from 'assert';
import { CrashMemory, describeRequest, requestOf, restartsBefore, STABLE_MS } from '../../engine/crashes';

// The requests that stopped the engine: the request of the stop line is blocked at once, a request in flight at 2 stops
// is blocked, and 2 blocked requests of a file block the file

const fileKey = (file: string): string => file.replace(/\//g, '\\').toLowerCase();
const cost = (file: string) => requestOf('dataflow/cost', { file, minCopyBytes: 16 });
const flow = (file: string, fn: string) => requestOf('dataflow/flow', { file, function: fn, line: 3, readFunctions: [] });

suite('Requests that stopped the engine', () => {
	test('blocks the request of the stop line of the engine, and no other request', () => {
		const memory = new CrashMemory(fileKey);
		memory.begin(1, cost('C:/p/a.cpp'));
		memory.begin(2, flow('C:/p/a.cpp', 'run'));
		memory.onStderr('dataflow-engine: the engine stopped in request 1\n');
		const stop = memory.onStop();
		assert.deepEqual(stop.culprit, cost('C:/p/a.cpp'));
		assert.deepEqual([stop.blocked, stop.blockedFiles, stop.inFlight.length], [[cost('C:/p/a.cpp')], [], 2]);

		// the same request with other params and the same file in a different case stays blocked. Other requests go
		assert.match(memory.reasonToSkip(requestOf('dataflow/cost', { file: 'c:/P/A.cpp', minCopyBytes: 64 })) ?? '',
			/^The engine stopped on Hidden C\+\+ \(dataflow\/cost\) of A\.cpp, so DataFlow does not send this request again/);
		assert.equal(memory.reasonToSkip(flow('C:/p/a.cpp', 'run')), undefined);
		assert.equal(memory.reasonToSkip(cost('C:/p/b.cpp')), undefined);
	});

	test('finds the stop line in two pieces of stderr, and takes the last stop line', () => {
		const memory = new CrashMemory(fileKey);
		memory.begin(7, cost('C:/p/a.cpp'));
		memory.begin(8, flow('C:/p/b.cpp', 'run'));
		memory.onStderr('dataflow-engine: the engine stopped in request 7\nother text\n');
		memory.onStderr('dataflow-engine: the engine stop');
		memory.onStderr('ped in request 8\n');
		assert.deepEqual(memory.onStop().blocked, [flow('C:/p/b.cpp', 'run')]);
	});

	test('with no stop line, blocks a request that was in flight at 2 stops, and a reply clears a suspect', () => {
		const memory = new CrashMemory(fileKey);
		memory.begin(1, cost('C:/p/a.cpp'));
		memory.begin(2, flow('C:/p/a.cpp', 'run'));
		const first = memory.onStop();
		assert.deepEqual([first.culprit, first.blocked, first.inFlight.length], [undefined, [], 2]);

		// after the restart, the flow of run gets a reply, so it is no suspect now
		memory.begin(1, flow('C:/p/a.cpp', 'run'));
		memory.end(1);
		memory.begin(2, cost('C:/p/a.cpp'));
		memory.begin(3, flow('C:/p/a.cpp', 'run'));
		assert.deepEqual(memory.onStop().blocked, [cost('C:/p/a.cpp')]);
		assert.ok(memory.reasonToSkip(cost('C:/p/a.cpp')));
		assert.equal(memory.reasonToSkip(flow('C:/p/a.cpp', 'run')), undefined);
	});

	test('blocks all requests of a file after 2 blocked requests of the file, for example after a crash in its parse', () => {
		const memory = new CrashMemory(fileKey);
		memory.begin(1, requestOf('dataflow/functionAt', { file: 'C:/p/a.cpp', line: 4, col: 2 }));
		memory.onStderr('dataflow-engine: the engine stopped in request 1\n');
		assert.deepEqual(memory.onStop().blockedFiles, []);
		memory.begin(1, cost('C:/p/a.cpp'));
		memory.onStderr('dataflow-engine: the engine stopped in request 1\n');
		assert.deepEqual(memory.onStop().blockedFiles, ['C:/p/a.cpp']);
		assert.match(memory.reasonToSkip(requestOf('dataflow/tokens', { file: 'c:/p/A.cpp' })) ?? '',
			/^The engine stopped on 2 requests for A\.cpp, so DataFlow does not send requests for this file again/);
		assert.equal(memory.reasonToSkip(cost('C:/p/b.cpp')), undefined);
	});

	test('a request for a different function is a different request, and a request with no file is no suspect', () => {
		const memory = new CrashMemory(fileKey);
		memory.begin(1, flow('C:/p/a.cpp', '~Holder'));
		memory.onStderr('dataflow-engine: the engine stopped in request 1\n');
		memory.onStop();
		assert.ok(memory.reasonToSkip(flow('C:/p/a.cpp', '~Holder')));
		assert.equal(memory.reasonToSkip(flow('C:/p/a.cpp', 'Holder::Holder')), undefined);

		// the scan of the call graph runs for a long time, so it is in flight at most stops
		for (let i = 0; i < 3; ++i) {
			memory.begin(1, requestOf('dataflow/callGraph', { roots: ['C:/p'] }));
			assert.deepEqual(memory.onStop().blocked, []);
		}
		assert.equal(memory.reasonToSkip(requestOf('dataflow/callGraph', { roots: ['C:/p'] })), undefined);
	});

	test('the count of the restarts starts again after the engine ran for 5 minutes with no stop', () => {
		assert.equal(restartsBefore(2, 1000, 1000 + STABLE_MS - 1), 2);
		assert.equal(restartsBefore(2, 1000, 1000 + STABLE_MS), 0);
		assert.equal(restartsBefore(1, undefined, 1000 + STABLE_MS), 1);
	});

	test('describes a request with its lens, its function and its file', () => {
		assert.equal(describeRequest(flow('C:/p/holder.cpp', '~Holder')), 'Flow Lens (dataflow/flow) for ~Holder of holder.cpp');
		assert.equal(describeRequest(requestOf('dataflow/functionAt', { file: 'C:/p/a.cpp' })), 'dataflow/functionAt of a.cpp');
		assert.equal(describeRequest(requestOf('dataflow/callGraph', { roots: [] })), 'Heat (dataflow/callGraph)');
	});
});
