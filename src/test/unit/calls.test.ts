import * as assert from 'assert';
import * as path from 'path';
import type { CallFunctionInfo, CallGraphModel, CallSiteInfo } from '../../engine/client';
import { addExternalCallers, buildSideCalls, callFunctionAt, callsOf, callTargetAt, functionLabel, siteKind, wordAt } from '../../lenses/calls';

// A model with the shape of the result of dataflow/calls for battery.cpp of the CMake fixture
const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const MAIN = path.join(ROOT, 'battery.cpp');
const fn = (name: string, where: CallFunctionInfo['where'], line: number, range?: [number, number], more: Partial<CallFunctionInfo> = {}): CallFunctionInfo => ({
	name, qualifiedName: `electricity::power_ctrl::${name}`, kind: 'function', file: where === 'main' ? MAIN : path.join(ROOT, 'types.hpp'),
	line, col: 1, len: name.length, where, isDefined: where === 'main', ...(range ? { range: { begin: range[0], end: range[1] } } : {}), ...more,
});
const call = (from: number, to: number, line: number, result: CallSiteInfo['result'], more: Partial<CallSiteInfo> = {}): CallSiteInfo => ({
	from, to, line, col: 3, result, ...more,
});

function graph(): CallGraphModel {
	return {
		functions: [
			fn('process', 'main', 85, [85, 170]),
			fn('solve_power_plan', 'main', 59, [59, 80]),
			fn('initial_power', 'main', 18, [18, 57]),
			fn('fire_transition', 'project', 165),
			fn('best_preset', 'main', 9, [9, 14]),
			{ ...fn('abs', 'library', 1), qualifiedName: 'std::abs', file: path.join(ROOT, 'cmath') },
			fn('get_if', 'project', 160),
		],
		calls: [
			call(0, 3, 98, 'none', { event: true, writes: ['home_battery_ctl'] }),
			call(0, 3, 111, 'none', { event: true, writes: ['home_battery_ctl'] }),
			call(0, 3, 118, 'none', { event: true, writes: ['home_battery_ctl'] }),
			call(0, 1, 95, 'returned', { async: 'tf::Executor::async', inLambda: true }),
			call(0, 6, 92, 'stored', { into: 'cur_tariff_plan', writes: ['tariff_plans.tariff_plans'] }),
			call(2, 4, 41, 'stored', { into: 'bestFit', optional: 'unchecked', uncheckedLine: 46 }),
			call(1, 2, 63, 'stored', { into: 'kw', optional: 'checked' }),
			call(1, 5, 68, 'used'),
		],
		cached: false,
	};
}

const lineText = () => '  x;';

suite('Call Hierarchy', () => {
	test('The kind of a call: async, event, optional, write, data or call', () => {
		assert.deepStrictEqual(graph().calls.map(siteKind), ['event', 'event', 'event', 'async', 'write', 'warn', 'check', 'data']);
		assert.strictEqual(siteKind(call(0, 1, 1, 'discarded')), 'call');
		assert.strictEqual(siteKind(call(0, 1, 1, 'checked')), 'data');
	});

	test('The labels of functions, methods and lambdas, also with :: in a template argument', () => {
		const g = graph();
		assert.strictEqual(functionLabel(g.functions[0]), 'process()');
		assert.strictEqual(functionLabel({ ...g.functions[0], kind: 'method', qualifiedName: 'DataFlow::WorkerPool::post', name: 'post' }), 'WorkerPool::post()');
		assert.strictEqual(functionLabel({
			...g.functions[0], kind: 'method', name: 'push_back', qualifiedName: 'std::vector<std::basic_string<char>>::push_back',
		}), 'vector::push_back()');
		assert.strictEqual(functionLabel({ ...g.functions[0], kind: 'lambda', qualifiedName: '', name: 'lambda', line: 95 }), 'lambda (line 95)');
	});

	test('One link for each caller and called function, with the kind of its most important call', () => {
		const side = buildSideCalls(graph(), MAIN, 0, lineText);
		const edge = (from: number, to: number) => side.edges.find((e) => e.from === from && e.to === to)!;
		assert.deepStrictEqual([edge(0, 3).kind, edge(0, 3).short, edge(0, 3).sites.map((s) => s.line)], ['event', 'event ×3', [98, 111, 118]]);
		assert.strictEqual(edge(0, 3).long,
			'3 calls of the event function fire_transition(). The setting dataflow.logic.eventFunctions gives the event functions. '
			+ 'The call also writes home_battery_ctl.');
		assert.deepStrictEqual([edge(0, 1).kind, edge(0, 1).short, edge(0, 1).long], [
			'async', 'async on another thread', 'The call on line 95 is in a lambda that tf::Executor::async runs on a different thread.',
		]);
		assert.deepStrictEqual([edge(2, 4).kind, edge(2, 4).long],
			['warn', 'Returns std::optional. The result goes into bestFit. Line 46 reads the value with no check.']);
		assert.deepStrictEqual([edge(1, 2).kind, edge(1, 2).short], ['check', 'optional checked']);
		assert.deepStrictEqual([edge(0, 6).kind, edge(0, 6).short], ['write', 'writes tariff_plans.tariff_plans']);
		assert.deepStrictEqual([edge(1, 5).kind, edge(1, 5).short, edge(1, 5).long], ['data', 'result used', 'The caller uses the result.']);
		assert.deepStrictEqual(edge(0, 1).sites, [{ line: 95, col: 2 }]);
		assert.ok(side.edges.every((e) => e.file === MAIN));
	});

	test('The calls of the function at the cursor get hints, but not the library calls and the calls with no data', () => {
		const process = buildSideCalls(graph(), MAIN, 0, lineText);
		assert.deepStrictEqual(process.hints.map((h) => `${h.line} ${h.kind} ${h.text} ${h.to}`), [
			'92 write get_if() · writes tariff_plans.tariff_plans 6',
			'95 async solve_power_plan() · async on another thread 1',
			'98 event fire_transition() · event 3',
			'111 event fire_transition() · event 3',
			'118 event fire_transition() · event 3',
		]);
		const solve = buildSideCalls(graph(), MAIN, 1, lineText);
		assert.deepStrictEqual(solve.hints.map((h) => h.text), ['initial_power() · optional checked']);
		const init = buildSideCalls(graph(), MAIN, 2, lineText);
		assert.deepStrictEqual(init.hints.map((h) => [h.text, h.kind]), [['best_preset() · optional not checked on line 46', 'warn']]);
	});

	test('An override that a virtual call can run is a link of its own, with no hint', () => {
		const method = (name: string, cls: string): CallFunctionInfo => ({
			...fn(name, 'project', 3), kind: 'method', qualifiedName: `${cls}::${name}`, isDefined: true,
		});
		const model: CallGraphModel = {
			functions: [fn('total', 'main', 6, [6, 12]), method('area', 'Shape'), method('area', 'Square')],
			calls: [
				call(0, 1, 7, 'stored', { into: 'a', writes: ['s'] }),
				call(0, 2, 7, 'stored', { into: 'a', writes: ['s'], virtualOf: 1 }),
				call(0, 2, 8, 'used', { virtualOf: 1 }),
			],
			cached: false,
		};
		const side = buildSideCalls(model, MAIN, 0, lineText);
		const named = side.edges.find((e) => e.to === 1)!;
		const override = side.edges.find((e) => e.to === 2)!;
		assert.deepStrictEqual([named.short, named.isVirtual], ['writes s', undefined]);
		assert.deepStrictEqual([override.short, override.isVirtual, override.sites.map((s) => s.line)], ['virtual call ×2', true, [7, 8]]);
		assert.ok(override.long.startsWith('The call names Shape::area(), a virtual function. Square::area() overrides it, so the call runs '
			+ 'Square::area() if the object is of its class.'), override.long);
		// the hint of line 7 is the hint of the function that the call names
		assert.deepStrictEqual(side.hints.map((h) => `${h.line} ${h.text}`), ['7 Shape::area() · writes s']);
	});

	test('Two functions with the same label get their namespaces', () => {
		const g = graph();
		g.functions.push({ ...fn('initial_power', 'project', 50), qualifiedName: 'charge::initial_power' });
		g.calls.push(call(2, 7, 30, 'stored', { into: 'kw' }));
		const side = buildSideCalls(g, MAIN, 2, lineText);
		assert.deepStrictEqual([side.functions[2].label, side.functions[7].label], ['power_ctrl::initial_power()', 'charge::initial_power()']);
		assert.strictEqual(side.functions[0].label, 'process()');
	});

	test('The function at a line is the innermost function of the main file', () => {
		const g = graph();
		assert.deepStrictEqual([95, 41, 63, 5, 300].map((line) => callFunctionAt(g, line)), [0, 2, 1, -1, -1]);
	});

	test('Show Calls finds the function of a name: its definition, a call of it, or a function with the name', () => {
		const model = graph();
		const texts: Record<number, string> = { 85: 'std::optional<Requests> process(tf::Executor &executor) {', 98: '  fire_transition(home_battery_ctl, "", true);' };
		const text: (l: number) => string | undefined = (l) => texts[l + 1];
		assert.strictEqual(wordAt(texts[98], 5), 'fire_transition');
		assert.strictEqual(wordAt(texts[98], 1), '');
		// the definition of process() on line 85
		assert.strictEqual(callTargetAt(model, MAIN, 85, 26, text), 0);
		// a call of fire_transition() on line 98
		assert.strictEqual(callTargetAt(model, MAIN, 98, 4, text), 3);
		// a name with no definition or call on its line: the function of the graph with the name
		texts[40] = '  // see best_preset';
		assert.strictEqual(callTargetAt(model, MAIN, 40, 12, text), 4);
		texts[41] = '  int other = 0;';
		assert.strictEqual(callTargetAt(model, MAIN, 41, 7, text), -1);
	});

	test('Show Calls lists the calls of a function in the sequence of the lines, with the caller and the kind', () => {
		const items = callsOf(graph(), 3, MAIN, lineText);
		assert.deepStrictEqual(items.map((c) => `${c.line}:${c.col} ${c.caller} ${c.kind}`), ['98:2 process() event', '111:2 process() event', '118:2 process() event']);
		assert.deepStrictEqual(callsOf(graph(), 0, MAIN, lineText), []);
	});

	test('A caller in a different file from the call hierarchy of VS Code is a function of the graph', () => {
		const side = buildSideCalls(graph(), MAIN, 0, lineText);
		const other = path.join(ROOT, 'main.cpp');
		const out = addExternalCallers(side, 0, [
			{ name: 'main(int, char **)', file: other, line: 10, col: 4, sites: [{ line: 12, col: 6 }] },
			{ name: 'run', file: MAIN, line: 200, col: 0, sites: [{ line: 201, col: 2 }] },
		]);
		const added = out.functions[out.functions.length - 1];
		assert.deepStrictEqual([added.label, added.where, added.file], ['main()', 'other', other]);
		const edge = out.edges.find((e) => e.kind === 'other')!;
		assert.deepStrictEqual([edge.from, edge.to, edge.short, edge.file, edge.sites], [added.id, 0, 'from main.cpp', other, [{ line: 12, col: 6 }]]);
		assert.strictEqual(out.functions.length, side.functions.length + 1);
		// a second answer replaces the callers of the first answer
		assert.strictEqual(addExternalCallers(out, 0, []).edges.filter((e) => e.kind === 'other').length, 0);
	});
});
