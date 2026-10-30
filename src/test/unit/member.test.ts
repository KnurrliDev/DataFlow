import * as assert from 'assert';
import * as path from 'path';
import type { MemberModel, MemberReference } from '../../engine/client';
import { classScope, findIncluder, includeLine, isSourceFile, searchClassFiles } from '../../lenses/classFiles';
import {
	bodyLabel, buildMemberView, memberLabel, memberRefAt, memberStorage, memberSummary, mergeMemberModels, sameFile, threadEntries, threadOf,
} from '../../lenses/member';
import { buildSideMemberFlow } from '../../side/flowLayer';
import type { TraceState } from '../../state/store';

// A model with the shape of the result of dataflow/member for WorkerPool::isStopping_: the class in a header, and its
// member functions in a source file. The worker lambda runs on the threads of a loop, and run() runs on runner_.
// The engine counts lines from 1 and columns in UTF-8 bytes from 1.
const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const H = path.join(ROOT, 'worker_pool.h');
const CPP = path.join(ROOT, 'worker_pool.cpp');
const H_TEXT: Record<number, string> = { 19: '    bool isStopping_ = false;', 33: '      return isStopping_;' };
const CPP_TEXT: Record<number, string> = {
	15: '            cv_.wait(lock, [this]() { return isStopping_ || !jobs_.empty(); });',
	21: '          done_ += 1;',
	37: '      isStopping_ = true;',
	54: '    while (!isStopping_) std::this_thread::yield();',
};
const textOf = (texts: Record<number, string>) => (line: number) => texts[line + 1] ?? '';

function ref(file: string, line: number, fn: number, role: MemberReference['role'], locks?: string[], name = 'isStopping_'): MemberReference {
	const texts = file === H ? H_TEXT : CPP_TEXT;
	return { file, line, col: texts[line].indexOf(name) + 1, len: name.length, fn, role, ...(locks ? { locks } : {}) };
}

function poolModel(refs?: MemberReference[]): MemberModel {
	return {
		member: {
			name: 'isStopping_', type: 'bool', className: 'WorkerPool', qualifiedClass: 'demo::WorkerPool', access: 'private', isAtomic: false,
			isSync: false, init: 'false', decl: { file: H, line: 19, col: 10, len: 11 },
		},
		fields: [{ name: 'jobs_', type: 'std::deque<Job>', line: 15 }, { name: 'isStopping_', type: 'bool', line: 19 }],
		functions: [
			{ name: 'WorkerPool', qualifiedName: 'demo::WorkerPool::WorkerPool', kind: 'constructor', file: CPP, line: 7, outer: -1, thread: -1 },
			{ name: 'lambda', qualifiedName: '', kind: 'lambda', file: CPP, line: 10, outer: 0, thread: 0 },
			{ name: 'lambda', qualifiedName: '', kind: 'lambda', file: CPP, line: 15, outer: 1, thread: 0 },
			{ name: 'destroy', qualifiedName: 'demo::WorkerPool::destroy', kind: 'method', file: CPP, line: 34, outer: -1, thread: -1 },
			{ name: 'is_stopping', qualifiedName: 'demo::WorkerPool::is_stopping', kind: 'method', file: H, line: 31, outer: -1, thread: -1 },
			{ name: 'run', qualifiedName: 'demo::WorkerPool::run', kind: 'method', file: CPP, line: 53, outer: -1, thread: 1 },
		],
		threads: [
			{ via: 'std::thread', file: CPP, line: 10, isRepeated: true },
			{ via: 'std::thread', file: CPP, line: 7, isRepeated: false },
		],
		refs: refs ?? [
			ref(H, 19, -1, 'def'),
			ref(CPP, 15, 2, 'read', ['mutex_']),
			ref(CPP, 37, 3, 'write', ['mutex_']),
			ref(CPP, 54, 5, 'check'),
			ref(H, 33, 4, 'read', ['mutex_']),
		],
		edges: [],
		function: null,
	};
}

function trace(model: MemberModel, at?: { file: string; line: number }): TraceState {
	return {
		file: CPP, view: buildMemberView(model, CPP, textOf(CPP_TEXT)), variables: [], pulse: 2, isSelected: true, member: { model, at },
	};
}

suite('Flow Lens for data members', () => {
	test('The view of a file has the accesses in that file, and the line of the declaration only in its own file', () => {
		const model = poolModel();
		const cpp = buildMemberView(model, CPP, textOf(CPP_TEXT));
		assert.deepStrictEqual(cpp.marks.map((m) => [m.line, m.role]), [[14, 'read'], [36, 'write'], [53, 'check']]);
		assert.strictEqual(cpp.declLine, -1);
		assert.strictEqual(cpp.marks[1].start, CPP_TEXT[37].indexOf('isStopping_'));
		const h = buildMemberView(model, H, textOf(H_TEXT));
		assert.deepStrictEqual(h.marks.map((m) => m.line), [18, 32]);
		assert.strictEqual(h.declLine, 18);
		assert.strictEqual(h.storage, 'private member of WorkerPool');
	});

	test('A rail connects only the accesses of one file', () => {
		const model = poolModel([ref(CPP, 37, 3, 'write'), ref(CPP, 54, 3, 'check'), ref(H, 33, 4, 'read')]);
		model.edges = [[0, 1], [0, 2]];
		const view = buildMemberView(model, CPP, textOf(CPP_TEXT));
		assert.deepStrictEqual(view.edges, [[0, 1]]);
		assert.deepStrictEqual(view.lanes.map((l) => [l.from, l.to, l.color]), [[36, 53, 'write']]);
	});

	test('The access at a position, and the comparison of the paths of the engine and of VS Code', () => {
		const model = poolModel();
		assert.strictEqual(memberRefAt(model, CPP, 36, 8, textOf(CPP_TEXT)), 2);
		assert.strictEqual(memberRefAt(model, CPP, 36, 2, textOf(CPP_TEXT)), undefined);
		assert.strictEqual(memberRefAt(model, H, 36, 8, textOf(H_TEXT)), undefined);
		if (process.platform === 'win32') {
			assert.ok(sameFile('c:\\proj\\worker_pool.h', 'C:/PROJ/worker_pool.h'));
		}
		assert.ok(!sameFile(H, CPP));
	});

	test('The names and the threads of the bodies', () => {
		const model = poolModel();
		assert.deepStrictEqual([-1, 0, 2, 3].map((fn) => bodyLabel(model, fn)), ['declaration', 'WorkerPool()', 'WorkerPool(), lambda', 'destroy()']);
		assert.strictEqual(threadOf(model, 3), undefined);
		const worker = threadOf(model, 2)!;
		assert.strictEqual(worker.label, 'std::thread');
		assert.strictEqual(worker.title, 'Runs on the threads that std::thread starts on line 10 of worker_pool.cpp.');
		model.functions[3].thread = 1;
		model.functions[3].threadCall = { file: CPP, line: 12 };
		assert.strictEqual(threadOf(model, 3)!.title,
			'Runs on the thread that std::thread starts on line 7 of worker_pool.cpp, through the call on line 12 of worker_pool.cpp. '
			+ 'Other callers can run it on other threads.');
	});

	test('A write and a read on two threads with no common lock are a possible race', () => {
		const summary = memberSummary(poolModel());
		assert.deepStrictEqual({ ...summary, verdict: undefined }, {
			files: 2, functions: 4, threads: 'the caller and 2 thread starts', locks: '1 of 4 without a lock', verdict: undefined,
		});
		assert.strictEqual(summary.verdict?.kind, 'race');
		assert.strictEqual(summary.verdict?.text, 'destroy() writes isStopping_ on line 37, on the caller thread. run() can read it at the same time '
			+ 'on line 54, on the thread of std::thread. No common lock protects the two accesses.');
		assert.deepStrictEqual(summary.verdict?.places, [{ file: CPP, line: 37 }, { file: CPP, line: 54 }]);
	});

	test('A common lock, an atomic member and a member that the threads only read are safe', () => {
		const locked = poolModel(poolModel().refs.filter((r) => r.line !== 54));
		const summary = memberSummary(locked);
		assert.strictEqual(summary.locks, 'all under mutex_');
		assert.deepStrictEqual(summary.verdict, { kind: 'safe', text: 'Each access holds mutex_, so the threads do not race on isStopping_.', places: [] });

		const atomic = poolModel();
		atomic.member.isAtomic = true;
		assert.strictEqual(memberSummary(atomic).locks, 'atomic');
		assert.strictEqual(memberSummary(atomic).verdict?.text, 'isStopping_ is atomic, so the threads do not race on it.');

		const sync = poolModel();
		sync.member.isSync = true;
		assert.strictEqual(memberSummary(sync).locks, 'synchronization object');
		assert.strictEqual(memberSummary(sync).verdict?.text, 'isStopping_ is a synchronization object. Threads can use it at the same time.');

		// two functions give the object and its mutex different names
		const named = poolModel([
			{ ...ref(CPP, 37, 3, 'write', ['_pool.mutex_']), object: '_pool' },
			{ ...ref(CPP, 15, 2, 'read', ['pool->mutex_']), object: 'pool' },
		]);
		assert.deepStrictEqual(memberSummary(named).verdict?.kind, 'safe');

		// the write in the constructor runs before a worker thread can use the object
		const reads = poolModel([ref(H, 19, -1, 'def'), ref(CPP, 37, 0, 'write'), ref(CPP, 15, 2, 'read')]);
		assert.deepStrictEqual(memberSummary(reads).verdict,
			{ kind: 'safe', text: 'The threads only read isStopping_, so they do not race on it.', places: [] });

		// one thread only: no check
		assert.strictEqual(memberSummary(poolModel([ref(CPP, 37, 3, 'write'), ref(H, 33, 4, 'read')])).verdict, undefined);
	});

	test('A write with no lock in a body that a loop runs on more than one thread races with itself', () => {
		const model = poolModel([ref(CPP, 21, 1, 'write', undefined, 'done_')]);
		model.member.name = 'done_';
		const verdict = memberSummary(model).verdict;
		assert.strictEqual(verdict?.kind, 'race');
		assert.strictEqual(verdict?.text, 'WorkerPool(), lambda writes done_ on line 21, on a thread of std::thread. Two of these threads can do '
			+ 'this at the same time, and no lock protects the access.');
	});

	test('The side view of a source file has the tag of the declaration on the access of the cursor, or on the shortest line', () => {
		const model = poolModel();
		const flow = buildSideMemberFlow(trace(model, { file: CPP, line: 54 }), CPP, textOf(CPP_TEXT))!;
		assert.deepStrictEqual(flow.tags, [{
			line: 54, kind: 'decl', text: 'worker_pool.h:19 · WorkerPool::isStopping_ = false',
			title: 'bool demo::WorkerPool::isStopping_. Click to open worker_pool.h at line 19.', file: H, target: 19, col: 9,
		}]);
		assert.deepStrictEqual(flow.marks.map((m) => m.line), [15, 37, 54]);
		assert.strictEqual(flow.fn, 'demo::WorkerPool');
		assert.deepStrictEqual(flow.variables.map((v) => [v.name, v.declLine, v.isCurrent]), [['jobs_', 15, false], ['isStopping_', 19, true]]);
		assert.strictEqual(buildSideMemberFlow(trace(model), CPP, textOf(CPP_TEXT))!.tags![0].line, 37);
		// the line of the cursor is long, so the tag goes on the shortest line
		assert.strictEqual(buildSideMemberFlow(trace(model, { file: CPP, line: 15 }), CPP, textOf(CPP_TEXT))!.tags![0].line, 37);

		// the accesses of each file, the file of the declaration first
		const member = flow.member!;
		assert.deepStrictEqual(member.groups.map((g) => [g.name, g.isShown, g.refs.map((r) => r.line)]),
			[['worker_pool.h', false, [19, 33]], ['worker_pool.cpp', true, [15, 37, 54]]]);
		assert.deepStrictEqual(member.groups[1].refs[0], {
			line: 15, col: CPP_TEXT[15].indexOf('isStopping_'), role: 'read', fn: 'WorkerPool(), lambda', isDecl: false, thread: 'std::thread',
			threadTitle: 'Runs on the threads that std::thread starts on line 10 of worker_pool.cpp.', locks: ['mutex_'], object: undefined,
		});
		assert.strictEqual(member.verdict?.places[0].name, 'worker_pool.cpp');

		// the files of the trace, with the first access of each file. The search for the other source files still runs
		assert.deepStrictEqual(member.files.map((f) => [f.name, f.state, f.count, f.first?.line, f.isShown]),
			[['worker_pool.h', 'trace', 2, 33, false], ['worker_pool.cpp', 'trace', 3, 15, true]]);
		assert.strictEqual(member.search, 'searching');
		const STATE = path.join(ROOT, 'worker_pool_state.cpp');
		const withOthers = { ...trace(model), member: { model, others: [{ file: STATE, mentions: 2, state: 'found' as const }] } };
		const found = buildSideMemberFlow(withOthers, CPP, textOf(CPP_TEXT))!.member!;
		assert.deepStrictEqual(found.files[2], { file: STATE, name: 'worker_pool_state.cpp', state: 'found', count: 2, isShown: false, error: undefined });
		assert.strictEqual(found.search, 'done');
	});

	test('The side view of the header has a tag for the accesses in the source file. A file with no access has no trace', () => {
		const model = poolModel();
		const flow = buildSideMemberFlow(trace(model), H, textOf(H_TEXT))!;
		assert.deepStrictEqual(flow.tags, [{
			line: 19, kind: 'file', text: '3 accesses in worker_pool.cpp', title: 'Click to open worker_pool.cpp at line 15.', file: CPP, target: 15,
			col: CPP_TEXT[15].indexOf('isStopping_'),
		}]);
		assert.deepStrictEqual(flow.marks.map((m) => [m.line, m.role]), [[19, 'def'], [33, 'read']]);
		assert.strictEqual(buildSideMemberFlow(trace(model), path.join(ROOT, 'other.cpp'), () => ''), null);
	});

	test('The search finds the source files with Class::, also with template arguments, and counts the mentions of the member', async () => {
		const texts: Record<string, string> = {
			'a.cpp': 'void WorkerPool::post() { isStopping_ = true; isStopping_ = false; }',
			'b.cpp': 'bool WorkerPool :: is_stopping() { return isStopping_; } // isStopping_2 is a different name',
			'c.cpp': 'void OtherWorkerPool::run() {}',
			'd.cpp': 'template <class T> void WorkerPool<T>::run() {}',
			'e.cpp': 'int main() { WorkerPool p; }',
		};
		const found = await searchClassFiles(Object.keys(texts), async (f) => texts[f], 'WorkerPool', 'isStopping_', undefined, 2);
		assert.deepStrictEqual(found, [{ file: 'a.cpp', mentions: 2 }, { file: 'b.cpp', mentions: 1 }, { file: 'd.cpp', mentions: 0 }]);
		assert.deepStrictEqual(['x.cpp', 'x.inc', 'x.cc', 'x.h', 'x.hpp'].map(isSourceFile), [true, true, true, false, false]);
		assert.deepStrictEqual(await searchClassFiles(['missing.cpp'], async () => undefined, 'WorkerPool', 'isStopping_'), []);
	});

	test('The search skips a class with the same name in a different namespace', async () => {
		const texts: Record<string, string> = {
			'a.cpp': 'namespace electricity {\nvoid WorkerPool::post() { isStopping_ = true; }\n}',
			'b.cpp': 'void electricity::WorkerPool::run() {}',
			'c.cpp': 'using namespace electricity;\nvoid WorkerPool::stop() {}',
			'd.cpp': 'namespace power {\nvoid WorkerPool::post() { isStopping_ = true; }\n}',
			'e.cpp': 'namespace electricity2 {\nvoid WorkerPool::post() {}\n}',
		};
		const scope = classScope('electricity::WorkerPool', 'WorkerPool');
		assert.deepStrictEqual(scope, ['electricity']);
		const found = await searchClassFiles(Object.keys(texts), async (f) => texts[f], 'WorkerPool', 'isStopping_', undefined, 2, scope);
		assert.deepStrictEqual(found.map((f) => f.file), ['a.cpp', 'b.cpp', 'c.cpp']);
		// outer classes, template arguments with a namespace, and an anonymous namespace
		assert.deepStrictEqual(classScope('a::b::Outer::Inner', 'Inner'), ['a', 'b', 'Outer']);
		assert.deepStrictEqual(classScope('ns::Pool<other::Item, std::pair<int, int>>', 'Pool'), ['ns']);
		assert.deepStrictEqual(classScope('(anonymous namespace)::Local', 'Local'), []);
		assert.deepStrictEqual(classScope('WorkerPool', 'WorkerPool'), []);
		assert.deepStrictEqual(classScope('electricity', ''), []);
	});

	test('The trace of a different translation unit adds the accesses of its main file, with their functions, threads and edges', () => {
		const primary = poolModel();
		const STATE = path.join(ROOT, 'worker_pool_state.cpp');
		const extra: MemberModel = {
			...poolModel([
				ref(H, 19, -1, 'def'),
				ref(H, 33, 0, 'read', ['mutex_']),
				{ file: STATE, line: 7, col: 12, len: 11, fn: 1, role: 'read', locks: ['mutex_'] },
				{ file: STATE, line: 12, col: 5, len: 11, fn: 2, role: 'write' },
				{ file: STATE, line: 13, col: 9, len: 11, fn: 2, role: 'read' },
			]),
			functions: [
				{ name: 'is_stopping', qualifiedName: 'demo::WorkerPool::is_stopping', kind: 'method', file: H, line: 31, outer: -1, thread: -1 },
				{ name: 'state', qualifiedName: 'demo::WorkerPool::state', kind: 'method', file: STATE, line: 6, outer: -1, thread: -1 },
				{ name: 'lambda', qualifiedName: '', kind: 'lambda', file: STATE, line: 11, outer: 1, thread: 0 },
			],
			threads: [{ via: 'std::async', file: STATE, line: 11, isRepeated: false }],
			edges: [[3, 4]],
		};
		const merged = mergeMemberModels(primary, [{ file: STATE, model: extra }, { file: CPP, model: extra }]);
		const added = merged.refs.slice(primary.refs.length);
		assert.deepStrictEqual(added.map((r) => [path.basename(r.file), r.line, r.role]), [['worker_pool_state.cpp', 7, 'read'], ['worker_pool_state.cpp', 12, 'write'], ['worker_pool_state.cpp', 13, 'read']]);
		const fns = merged.functions.slice(primary.functions.length);
		assert.deepStrictEqual(fns.map((f) => [f.name, f.outer, f.thread]), [['state', -1, -1], ['lambda', primary.functions.length, primary.threads.length]]);
		assert.deepStrictEqual(merged.threads.slice(primary.threads.length).map((t) => t.via), ['std::async']);
		assert.deepStrictEqual(merged.edges.slice(primary.edges.length), [[primary.refs.length + 1, primary.refs.length + 2]]);
		assert.deepStrictEqual(added.map((r) => r.fn), [primary.functions.length, primary.functions.length + 1, primary.functions.length + 1]);
		// the first trace keeps its own data
		assert.deepStrictEqual(merged.refs.slice(0, primary.refs.length), primary.refs);
		assert.strictEqual(memberSummary(merged).files, 3);
	});

	test('The search also finds a file that includes the header and names the member. A global has only this search', async () => {
		const texts: Record<string, string> = {
			'a.cpp': '#include "core/worker_pool.h"\nvoid stop(WorkerPool& p) { p.isStopping_ = true; }',
			'b.cpp': '#include <worker_pool.h>\nvoid run() {}',
			'c.cpp': 'void other() { isStopping_ = 1; }',
			'd.cpp': 'void WorkerPool::run() {}',
		};
		const read = async (f: string) => texts[f];
		assert.deepStrictEqual(await searchClassFiles(Object.keys(texts), read, 'WorkerPool', 'isStopping_', H),
			[{ file: 'a.cpp', mentions: 1 }, { file: 'd.cpp', mentions: 0 }]);
		assert.deepStrictEqual(await searchClassFiles(Object.keys(texts), read, '', 'isStopping_', H), [{ file: 'a.cpp', mentions: 1 }]);
		assert.deepStrictEqual(await searchClassFiles(Object.keys(texts), read, '', 'isStopping_'), []);
	});

	test('The source file of a unity build that includes an .inc file', async () => {
		const texts: Record<string, string> = {
			'app/z_code.cpp': '#include "parts/panel.inc"\n#include "parts/menu.inc"',
			'app/a_code.cpp': '#include "parts/other.inc"',
			'app/parts/panel.inc': '// includes nothing',
		};
		const read = async (f: string) => texts[f];
		assert.strictEqual(await findIncluder(Object.keys(texts), read, 'app/parts/panel.inc'), 'app/z_code.cpp');
		assert.strictEqual(await findIncluder(Object.keys(texts), read, 'app/parts/none.inc'), undefined);

		// the line of the #include, from 1. 0 if the text has none
		assert.strictEqual(includeLine(texts['app/z_code.cpp'], 'app/parts/menu.inc'), 2);
		assert.strictEqual(includeLine('#include <app/parts/menu.inc>\r\n', 'menu.inc'), 1);
		assert.strictEqual(includeLine(texts['app/z_code.cpp'], 'app/parts/none.inc'), 0);
	});

	test('The runs of the engine: a join puts two accesses in sequence, and a function on two threads can race with itself', () => {
		// destroy() writes after the join of the worker threads: no race with the read of the worker lambda
		const ordered = poolModel([
			ref(H, 19, -1, 'def'),
			{ ...ref(CPP, 15, 2, 'read'), runs: [{ thread: 0 }] },
			{ ...ref(CPP, 37, 3, 'write'), runs: [{ thread: -1, ordered: [0] }] },
		]);
		const safe = memberSummary(ordered).verdict!;
		assert.strictEqual(safe.kind, 'safe');
		assert.strictEqual(safe.text, 'A join, a start or a check of a thread handle puts the accesses in sequence, so the threads do not race on isStopping_.');

		// is_stopping() writes, and the caller and the thread of run() call it: two runs of one access
		const twice = poolModel([ref(H, 19, -1, 'def'), { ...ref(H, 33, 4, 'write'), runs: [{ thread: -1 }, { thread: 1 }] }]);
		const race = memberSummary(twice);
		assert.strictEqual(race.threads, 'the caller and 1 thread start');
		assert.strictEqual(race.verdict?.kind, 'race');
		assert.strictEqual(race.verdict?.text, 'is_stopping() writes isStopping_ on line 33, on the caller thread. is_stopping() can write it at the same '
			+ 'time on line 33, on the thread of std::thread. No common lock protects the two accesses.');
		assert.deepStrictEqual(race.verdict?.places, [{ file: H, line: 33 }]);

		// a lock on the way from the caller: the run has it, the lock guard of the access is not necessary
		const locked = poolModel([ref(H, 19, -1, 'def'), { ...ref(H, 33, 4, 'write'), runs: [{ thread: -1, locks: ['pool.mutex_'] }, { thread: 1, locks: ['mutex_'] }] }]);
		const summary = memberSummary(locked);
		assert.strictEqual(summary.verdict?.kind, 'safe');
		assert.strictEqual(summary.locks, 'all under pool.mutex_');
	});

	test('A thread with the same start in two units is one thread, and the runs of the other unit get the threads of the merge', () => {
		const primary = poolModel();
		primary.threads[1].calls = ['demo::WorkerPool::state'];
		assert.deepStrictEqual(threadEntries(primary), [{ function: 'demo::WorkerPool::state', via: 'std::thread', file: CPP, line: 7, isRepeated: false }]);
		const STATE = path.join(ROOT, 'worker_pool_state.cpp');
		const extra: MemberModel = {
			...poolModel([{ file: STATE, line: 7, col: 12, len: 11, fn: 0, role: 'read', runs: [{ thread: 0, ordered: [1] }] }]),
			functions: [{ name: 'state', qualifiedName: 'demo::WorkerPool::state', kind: 'method', file: STATE, line: 6, outer: -1, thread: 0 }],
			threads: [primary.threads[1], { via: 'std::async', file: STATE, line: 9, isRepeated: false }],
		};
		const merged = mergeMemberModels(primary, [{ file: STATE, model: extra }]);
		assert.strictEqual(merged.threads.length, primary.threads.length + 1);
		assert.strictEqual(merged.functions[merged.functions.length - 1].thread, 1);
		assert.deepStrictEqual(merged.refs[merged.refs.length - 1].runs, [{ thread: 1, ordered: [primary.threads.length] }]);
	});

	test('The labels of a static data member and of a global variable', () => {
		const model = poolModel();
		model.member = { ...model.member, kind: 'static', access: 'public', name: 'hits_', className: 'Stats', qualifiedClass: 'demo::Stats' };
		assert.deepStrictEqual([memberStorage(model), memberLabel(model)], ['public static member of Stats', 'Stats::hits_']);
		model.member = { ...model.member, kind: 'global', name: 'g_counter', className: '', qualifiedClass: 'demo' };
		assert.deepStrictEqual([memberStorage(model), memberLabel(model)], ['global variable in demo', 'demo::g_counter']);
		model.member = { ...model.member, qualifiedClass: '' };
		assert.deepStrictEqual([memberStorage(model), memberLabel(model)], ['global variable', 'g_counter']);
	});
});

