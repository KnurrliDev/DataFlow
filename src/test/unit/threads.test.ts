import * as assert from 'assert';
import * as path from 'path';
import type { ThreadsAccessInfo, ThreadsItemInfo, ThreadsModel } from '../../engine/client';
import { buildSideThreads, overlaps, threadPairs } from '../../lenses/threads';

// A model with the shape of the result of dataflow/threads for the fixture: process() starts solve_power_plan() with
// tf::Executor::async on line 95, and get() on line 102 joins it. The engine counts lines from 1 and columns in UTF-8
// bytes from 1.
const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const CPP = path.join(ROOT, 'battery.cpp');
const TEXT: Record<number, string> = {
	61: '  while (charge.is_dirty) {',
	76: '  charge.is_dirty = false;',
	94: '  if (charge.is_dirty && !home_battery_ctl.charging_future) {',
	116: '          auto res = compute_and_store_schedule(cur_tariff_plan, settings, charge);',
	129: '        auto res = compute_and_store_schedule(cur_tariff_plan, settings, charge);',
	196: '        last_read[tapTopic] = meterread;',
};
const lineText = (line: number) => TEXT[line + 1];

function access(line: number, name: string, thread: number, role: ThreadsAccessInfo['role'], extra: Partial<ThreadsAccessInfo> = {}): ThreadsAccessInfo {
	return {
		file: CPP, line, col: TEXT[line].indexOf(name) + 1, len: name.length, role, thread, fn: thread < 0 ? 0 : 1, path: `charge.${name}`, sub: [],
		locks: [], order: {}, guards: [], via: [], ...extra,
	};
}

function model(items: ThreadsItemInfo[], repeated = false): ThreadsModel {
	return {
		threads: [{
			via: 'tf::Executor::async', name: 'lambda', handle: 'home_battery_ctl.charging_future', isRepeated: repeated, isJoined: false, fn: 0,
			runs: 2, at: { file: CPP, line: 95, col: 5 }, joins: [{ file: CPP, line: 102, col: 49, kind: 'get', fn: 0 }],
		}],
		items,
		captures: [],
		functions: [
			{ name: 'process', qualifiedName: 'process', kind: 'function', file: CPP, line: 85, first: 85, last: 170, threads: [-1] },
			{ name: 'solve_power_plan', qualifiedName: 'solve_power_plan', kind: 'function', file: CPP, line: 59, first: 59, last: 78, threads: [0] },
			{ name: 'lambda', qualifiedName: '', kind: 'lambda', file: CPP, line: 95, first: 95, last: 95, threads: [0] },
		],
		isTruncated: false, analysisMs: 1, cached: false,
	};
}

const item = (label: string, refs: ThreadsAccessInfo[], extra: Partial<ThreadsItemInfo> = {}): ThreadsItemInfo => ({
	key: label, label, kind: 'member', type: 'bool', isAtomic: false, refs, ...extra,
});

suite('Threads and races', () => {
	test('Two accesses overlap if the steps of one start with the steps of the other', () => {
		assert.ok(overlaps([], ['schedule', 'kw']));
		assert.ok(overlaps(['[]', 'schedule'], ['[]', 'schedule', 'kw']));
		assert.ok(!overlaps(['[]', 'schedule'], ['[]', 'last_cost']));
	});

	test('A write and a read on two threads with no lock and no order are a race. A condition of the caller makes a check', () => {
		const is_dirty = item('charge.is_dirty', [
			access(76, 'is_dirty', 0, 'write'),
			access(94, 'is_dirty', -1, 'check'),
			access(129, 'charge', -1, 'mayWrite', { whole: true, guards: [{ text: 'home_battery_ctl.state == HOMEPOWER_CHARGE_ACTIVE', isNegated: false }] }),
			access(116, 'charge', -1, 'mayWrite', { whole: true, order: { after: [0], ready: [0] } }),
			access(61, 'is_dirty', 0, 'check'),
		]);
		assert.deepStrictEqual(threadPairs(model([is_dirty]), is_dirty).map((p) => [is_dirty.refs[p.a].line, is_dirty.refs[p.b].line, p.kind]),
			[[76, 94, 'race'], [76, 129, 'check'], [129, 61, 'check']]);
	});

	test('A common lock, an order, two reads, other data and the same thread are not pairs. A repeated thread races with itself', () => {
		const pairsOf = (refs: ThreadsAccessInfo[], repeated = false) => {
			const it = item('x', refs);
			return threadPairs(model([it], repeated), it).length;
		};
		const write = access(76, 'is_dirty', 0, 'write');
		assert.strictEqual(pairsOf([{ ...write, locks: ['mutex_'] }, access(94, 'is_dirty', -1, 'read', { locks: ['mutex_'] })]), 0);
		for (const order of [{ after: [0] }, { before: [0] }, { empty: [0] }, { ready: [0] }]) {
			assert.strictEqual(pairsOf([write, access(94, 'is_dirty', -1, 'read', { order })]), 0, JSON.stringify(order));
		}
		assert.strictEqual(pairsOf([access(61, 'is_dirty', 0, 'read'), access(94, 'is_dirty', -1, 'read')]), 0);
		assert.strictEqual(pairsOf([{ ...write, sub: ['a'] }, access(94, 'is_dirty', -1, 'read', { sub: ['b'] })]), 0);
		assert.strictEqual(pairsOf([write, access(61, 'is_dirty', 0, 'read')]), 0);
		assert.strictEqual(pairsOf([write, access(61, 'is_dirty', 0, 'read')], true), 1);
		assert.strictEqual(pairsOf([{ ...write, atomic: true }, access(94, 'is_dirty', -1, 'read', { atomic: true })]), 0);
	});

	test('The side view has the items with their verdicts, the lanes, the possible fix, the marks and the tags', () => {
		const swap = { thread: 0, from: 'charge.is_dirty && !home_battery_ctl.charging_future', to: '!home_battery_ctl.charging_future && charge.is_dirty' };
		const is_dirty = item('charge.is_dirty', [access(76, 'is_dirty', 0, 'write'), access(94, 'is_dirty', -1, 'check', { swap })]);
		const optimizers = item('charge.optimizers', [
			access(76, 'is_dirty', 0, 'write', { sub: ['[]'], path: 'charge.optimizers[]' }),
			access(129, 'charge', -1, 'mayWrite', { whole: true, guards: [{ text: 'home_battery_ctl.state == HOMEPOWER_CHARGE_ACTIVE', isNegated: false }] }),
			access(116, 'charge', -1, 'mayWrite', { whole: true, order: { after: [0] }, via: [] }),
		], { type: 'std::map<int, Optimizer>' });
		const lastData = item('last_read', [access(196, 'last_read', -1, 'write')], { kind: 'static', type: 'std::map<std::string, MeterRead>' });
		const m = model([lastData, optimizers, is_dirty]);
		m.captures = [{ thread: 0, fn: 0, vars: [{ file: CPP, line: 85, col: 70, name: 'charge', kind: 'reference' }] }];
		const side = buildSideThreads(m, CPP, lineText);

		assert.deepStrictEqual(side.items.map((i) => [i.label, i.verdict, i.pill]), [
			['charge.is_dirty', 'race', 'Race'],
			['charge.optimizers', 'check', 'Check'],
			['charge, captured by [&]', 'check', 'Check'],
			['last_read', 'safe', 'Safe now'],
		]);
		assert.deepStrictEqual(side.counts, { race: 1, check: 2, safe: 1 });

		const race = side.items[0];
		assert.deepStrictEqual([race.caller, race.worker, race.protection], ['reads 94', 'writes 76', 'none']);
		assert.deepStrictEqual(race.fix && [race.fix.line, race.fix.before, race.fix.after], [94, swap.from, swap.to]);
		assert.strictEqual(race.summary,
			'Line 94 reads charge.is_dirty on the caller thread, and the worker thread can write it on line 76 at the same time. No lock, no atomic and no join puts the two accesses in sequence.');
		// the marks have UTF-16 columns from 0, and an access of a pair has a hint after the code
		assert.deepStrictEqual(race.marks.map((m) => [m.line, m.start, m.end, m.lane, m.pair, m.hint]), [
			[76, 9, 17, 'worker', 'race', 'race with line 94'],
			[94, 13, 21, 'caller', 'race', 'race with line 76'],
		]);
		// the lanes: the start, the pair, the join
		assert.deepStrictEqual(race.steps.map((s) => s.kind === 'access' ? `${s.kind} ${s.lane} ${s.line}` : s.kind === 'pair'
			? `pair ${s.verdict} ${s.caller.line} ${s.worker.line}` : `${s.kind} ${s.dir} ${s.line}`),
		['sync start 95', 'pair race 94 76', 'sync join 102']);

		// the call on line 116 comes after get(): it is a step after the join, in sequence
		const check = side.items[1];
		assert.deepStrictEqual(check.steps.map((s) => s.kind === 'access' ? `${s.lane} ${s.line} ${s.isOrdered}` : s.kind === 'pair' ? `pair ${s.verdict}` : s.dir),
			['start', 'pair check', 'join', 'caller 116 true']);
		assert.ok(check.summary.endsWith('It is safe only if no worker thread runs when home_battery_ctl.state == HOMEPOWER_CHARGE_ACTIVE. The engine cannot see this.'), check.summary);
		assert.strictEqual(check.protection, 'get() on line 102, for line 116');

		// the worker thread runs solve_power_plan() and the lambda. The start and the join have tags
		assert.deepStrictEqual(side.lanes, [{ first: 59, last: 78, threads: [0], isCaller: false }, { first: 95, last: 95, threads: [0], isCaller: false }]);
		assert.deepStrictEqual(side.tags.map((t) => [t.line, t.kind, t.text]), [
			[95, 'start', 'starts lambda on line 95'],
			[102, 'join', 'get() waits for lambda on line 95'],
		]);
	});

	test('A capture of a local object by reference in a thread that can outlive its function dangles', () => {
		const m = model([]);
		m.captures = [{ thread: 0, fn: 0, vars: [{ file: CPP, line: 90, col: 10, name: 'result', kind: 'object' }] }];
		const side = buildSideThreads(m, CPP, lineText);
		assert.deepStrictEqual(side.items.map((i) => [i.label, i.verdict, i.pill]), [['result, captured by [&]', 'race', 'Dangling']]);
		assert.ok(side.items[0].summary.includes('the local objects end there'), side.items[0].summary);
	});
});
