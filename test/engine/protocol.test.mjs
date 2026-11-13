// Protocol tests for dataflow-engine. Run them with: npm run test:engine
// They use the engine in build/engine and the databases that scripts/prepare-fixtures.mjs writes.
// DATAFLOW_ENGINE, DATAFLOW_CMAKE_DB and DATAFLOW_QMAKE_DB can select other files.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startEngine } from './engine-client.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const defaults = {
	DATAFLOW_ENGINE: path.join(repo, 'build', 'engine', process.platform === 'win32' ? 'dataflow-engine.exe' : 'dataflow-engine'),
	DATAFLOW_CMAKE_DB: path.join(repo, 'test', 'fixtures', 'battery', 'build', 'compile_commands.json'),
	DATAFLOW_QMAKE_DB: path.join(repo, 'build', 'fixtures', 'battery-qmake', 'compile_commands.json'),
};
const env = (name) => process.env[name] ?? defaults[name];
const fixture = path.join(repo, 'test/fixtures/battery/src/battery.cpp');
const header = path.join(repo, 'test/fixtures/battery/include/battery/types.hpp');
const qtFile = path.join(repo, 'test/fixtures/battery-qmake/battery_qt.cpp');

let engine;
before(async () => {
	engine = startEngine(env('DATAFLOW_ENGINE'));
	// no resourceDir: the engine finds the builtin headers of clang next to itself
	const init = await engine.send('initialize', {
		compileCommands: [env('DATAFLOW_CMAKE_DB'), env('DATAFLOW_QMAKE_DB')],
		maxThreads: 4,
		cacheSize: 4,
	});
	assert.equal(init.error, undefined, JSON.stringify(init.error));
	assert.equal(init.result.databases.length, 2);
	assert.ok(init.result.databases.every((d) => d.files > 0), JSON.stringify(init.result.databases));
	assert.equal(init.result.threads, 4);
});
after(async () => { await engine.close(); });

test('lists the functions of a file', async () => {
	const res = await engine.send('dataflow/functions', { file: fixture });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
	const names = res.result.functions.map((f) => f.qualifiedName);
	assert.deepEqual(names, [
		'electricity::power_ctrl::best_preset', 'electricity::power_ctrl::log_info',
		'electricity::power_ctrl::initial_power', 'electricity::power_ctrl::solve_power_plan',
		'electricity::power_ctrl::process', 'electricity::power_ctrl::stable_readings',
	]);
});

test('finds the function under the cursor', async () => {
	const at = async (line, col) => (await engine.send('dataflow/functionAt', { file: fixture, line, col })).result;
	assert.equal((await at(46, 10)).function.name, 'initial_power');
	assert.equal((await at(70, 5)).function.name, 'solve_power_plan');
	assert.equal((await at(3, 1)).function, null);
});

test('uses the cache when the text did not change', async () => {
	const res = await engine.send('dataflow/functionAt', { file: fixture, line: 46, col: 10 });
	assert.equal(res.result.parsed, false);
});

test('finds a function in a header through the inferred command', async () => {
	const res = await engine.send('dataflow/functionAt', { file: header, line: 50, col: 30 });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
	assert.equal(res.result.function.qualifiedName, 'charge::isValidKw');
});

test('parses unsaved text, and the reparse is faster than the first parse', async () => {
	const first = await engine.send('dataflow/functions', { file: fixture });
	const text = readFileSync(fixture, 'utf8') + '\nint added_by_test() { return 1; }\n';
	engine.notify('textDocument/didOpen', { file: fixture, text, version: 1 });
	const res = await engine.send('dataflow/functions', { file: fixture });
	assert.equal(res.result.parsed, true);
	assert.ok(res.result.functions.some((f) => f.name === 'added_by_test'));
	console.log(`first parse ${Math.round(first.result.parseMs)} ms (count ${first.result.parseCount}), reparse ${Math.round(res.result.parseMs)} ms`);
	engine.notify('textDocument/didClose', { file: fixture });
	const closed = await engine.send('dataflow/functions', { file: fixture });
	assert.ok(!closed.result.functions.some((f) => f.name === 'added_by_test'));
});

test('runs requests for two files at the same time', async () => {
	const start = Date.now();
	const [qt, cfg] = await Promise.all([
		engine.send('dataflow/optionalAccess', { file: qtFile, function: 'describe' }),
		engine.send('dataflow/cfg', { file: fixture, function: 'initial_power' }),
	]);
	assert.equal(qt.error, undefined, JSON.stringify(qt.error));
	assert.deepEqual(qt.result.unchecked.map((u) => u.range.begin.line), [22]);
	assert.equal(cfg.result.cfg.blocks.length, 11);
	console.log(`two files in parallel: ${Date.now() - start} ms (qt parse ${Math.round(qt.result.parseMs)} ms)`);
});

test('cancels a request', async () => {
	engine.notify('textDocument/didOpen', { file: qtFile, text: readFileSync(qtFile, 'utf8') + '\n', version: 7 });
	const { id, reply } = engine.request('dataflow/functions', { file: qtFile });
	engine.notify('$/cancelRequest', { id });
	const res = await reply;
	assert.equal(res.error?.code, -32800, JSON.stringify(res));
	engine.notify('textDocument/didClose', { file: qtFile });
});

test('computes the flow of a function', async () => {
	const res = await engine.send('dataflow/flow', { file: fixture, line: 46, col: 10 });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	const { variables, refs, edges } = res.result;
	const refsOf = (name, declLine) => {
		const v = variables.findIndex((x, i) => x.name === name && (!declLine || refs[x.declRef].line === declLine));
		return { v, list: refs.map((r, i) => ({ ...r, i })).filter((r) => r.var === v) };
	};
	const show = (name, declLine) => refsOf(name, declLine).list.map((r) => `${r.line}:${r.col} ${r.role}${r.finding ? ` [${r.finding}]` : ''}`).join(', ');
	console.log(`bestFit:    ${show('bestFit')}`);
	console.log(`startPlans: ${show('startPlans')}`);
	console.log(`kw (30):    ${show('kw', 30)}`);
	console.log(`kw (52):    ${show('kw', 52)}`);
	console.log(`usePreset:  ${show('usePreset')}`);

	// bestFit: a declaration, a check, reads through the accessors, and the unchecked access on line 46
	const roles = (name, declLine) => refsOf(name, declLine).list.map((r) => `${r.line} ${r.role}`);
	const best = refsOf('bestFit');
	assert.ok(variables[best.v].type.includes('optional'), variables[best.v].type);
	assert.equal(variables[best.v].storage, 'local');
	assert.deepEqual(roles('bestFit'), ['41 def', '42 check', '44 read', '44 read', '44 read', '46 read']);
	const finding = best.list.filter((r) => r.finding);
	assert.deepEqual(finding.map((r) => [r.line, r.finding]), [[46, 'unchecked optional access']]);

	// the declaration reaches each later reference of bestFit
	const declRef = variables[best.v].declRef;
	for (const r of best.list.filter((x) => x.line > 41)) {
		assert.ok(edges.some(([from, to]) => from === declRef && to === r.i), `no edge to line ${r.line}`);
	}

	// push_back, begin and end can change startPlans. std::format, operator[] and return only read
	assert.deepEqual(roles('startPlans'),
		['27 def', '31 mayWrite', '36 mayWrite', '43 mayWrite', '49 mayWrite', '49 mayWrite', '51 read', '52 read']);
	assert.deepEqual(roles('kw', 52), ['52 def', '54 check', '55 read']);

	// a possible write adds a definition, and the old definitions still reach later uses
	const read51 = refsOf('startPlans').list.find((r) => r.line === 51).i;
	const reaching = edges.filter(([, to]) => to === read51).map(([from]) => refs[from].line).sort((a, b) => a - b);
	assert.deepEqual(reaching, [27, 31, 36, 43, 49, 49]);

	// two different variables with the name kw
	assert.equal(variables.filter((v) => v.name === 'kw').length, 2);
	assert.ok(refsOf('usePreset').list.some((r) => r.line === 40 && r.role === 'check'));
	assert.equal(variables[refsOf('filter').v].storage, 'parameter, by value');
	assert.equal(res.result.hasCfg, true);
});

test('drops the variables that only the macros of other files use', async () => {
	// a header with macros as in a test framework: a macro declares a variable and uses it in its own body
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-macros-'));
	const macros = path.join(dir, 'macros.hpp').replace(/\\/g, '/');
	writeFileSync(macros, [
		'#define DF_CHECK(e) do { const bool df_ok = (e); (void)df_ok; } while (0)',
		'#define DF_MAKE int made = 1',
	].join('\n') + '\n');
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length;
	const extra = [
		`#include "${macros}"`,
		'int df_macro_probe(int value) {',
		'  DF_CHECK(value > 0);',
		'  DF_MAKE;',
		'  return made + value;',
		'}',
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 5 });
	const res = await engine.send('dataflow/flow', { file: fixture, line: first + 2, col: 3 });
	engine.notify('textDocument/didClose', { file: fixture });
	rmSync(dir, { recursive: true, force: true });
	assert.equal(res.error, undefined, JSON.stringify(res.error));

	// df_ok is only in the body of DF_CHECK. made is in the body of DF_MAKE, but the return reads it
	const { variables, refs } = res.result;
	assert.deepEqual(variables.map((v) => v.name).sort(), ['made', 'value']);
	const made = variables.findIndex((v) => v.name === 'made');
	assert.deepEqual(refs.filter((r) => r.var === made).map((r) => `${r.line - first} ${r.role}`), ['3 def', '4 read']);
	assert.ok(variables.every((v) => refs[v.declRef].var === variables.indexOf(v)));
});

test('flow: a template range for loop, unevaluated operands, lambdas, read functions, the cache and overloads', async () => {
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length; // the line of the first added line
	const extra = [
		'template <class T>', // +0
		'int df_sum_all(const T& t) {',
		'  int s = 0;',
		'  for (const auto& x : t) s += x;',
		'  return s;',
		'}', // +5
		'int df_unevaluated(int v) {',
		'  const auto size = sizeof(v);',
		'  decltype(v) w = v;',
		'  static_assert(sizeof(v) == 4);',
		'  const bool n = noexcept(v + 1);', // +10
		'  return int(size) + w + int(n);',
		'}',
		'int df_lambda() {',
		'  int a = 1;',
		'  auto l = [&]() { return a + 1; };', // +15
		'  a = 2;',
		'  auto m = [&]() { a = 3; };',
		'  m();',
		'  return l() + a;',
		'}', // +20
		'// a function with no body that gets a non-const reference',
		'void df_show(int& v);',
		'int df_reads() {',
		'  int z = 1;',
		'  df_show(z);', // +25
		'  return z;',
		'}',
		'int df_over(int a) { return a + 1; }',
		'int df_over(double a) { return int(a) + 2; }',
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 9 });
	try {
		const flow = async (params) => {
			const res = await engine.send('dataflow/flow', { file: fixture, ...params });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			return res.result;
		};
		const refsOf = (model, name) => {
			const v = model.variables.findIndex((x) => x.name === name);
			return model.refs.map((r, i) => ({ ...r, i })).filter((r) => r.var === v);
		};
		const roles = (model, name) => refsOf(model, name).map((r) => `${r.line - first} ${r.role}`);
		const reaching = (model, ref) => model.edges.filter(([, to]) => to === ref.i).map(([from]) => model.refs[from].line - first).sort((a, b) => a - b);

		// a range for loop on a dependent range: clang makes no cfg for it, the engine does. x is a reference to const,
		// so the dependent += cannot change it
		const sum = await flow({ line: first + 2, col: 3 });
		assert.equal(sum.hasCfg, true);
		const s = refsOf(sum, 's');
		assert.deepEqual(roles(sum, 's'), ['2 def', '3 write', '4 read']);
		assert.deepEqual(reaching(sum, s[2]), [2, 3]);
		assert.deepEqual(roles(sum, 'x'), ['3 def', '3 read']);
		assert.deepEqual(reaching(sum, refsOf(sum, 'x')[1]), [3]);
		const logic = await engine.send('dataflow/logic', { file: fixture, line: first + 2, col: 3 });
		assert.ok(logic.result.blocks.length > 2, JSON.stringify(logic.result.blocks));

		// sizeof, decltype, static_assert and noexcept do not run their operands
		assert.deepEqual(roles(await flow({ line: first + 7, col: 3 }), 'v'), ['6 def', '8 read']);

		// a read in a lambda gets the definitions at the lambda. a write in a lambda does not replace the old value
		const lambda = await flow({ line: first + 14, col: 3 });
		const a = refsOf(lambda, 'a');
		assert.deepEqual(roles(lambda, 'a'), ['14 def', '15 read', '16 write', '17 write', '19 read']);
		assert.deepEqual(reaching(lambda, a[1]), [14]);
		assert.deepEqual(reaching(lambda, a[4]), [16, 17]);

		// a non-const reference is a possible write, unless the function is in readFunctions. the engine keeps the model
		const plain = await flow({ line: first + 24, col: 3 });
		assert.deepEqual(roles(plain, 'z'), ['24 def', '25 mayWrite', '26 read']);
		assert.equal(plain.cached, false);
		assert.equal((await flow({ line: first + 24, col: 3 })).cached, true);
		const read = await flow({ line: first + 24, col: 3, readFunctions: ['df_show'] });
		assert.equal(read.cached, false);
		assert.deepEqual(roles(read, 'z'), ['24 def', '25 read', '26 read']);

		// a name selects the first overload, a name and a line select the nearest overload
		assert.equal((await flow({ function: 'df_over' })).function.range.begin.line, first + 28);
		assert.equal((await flow({ function: 'df_over', line: first + 29 })).function.range.begin.line, first + 29);
		assert.equal((await flow({ function: 'df_over', line: first + 40 })).function.range.begin.line, first + 29);
	} finally {
		engine.notify('textDocument/didClose', { file: fixture });
	}
});

test('templates: data members and calls of dependent expressions', async () => {
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length;
	const extra = [
		'template <class T>', // +0
		'struct DfBucket {',
		'  bool isFlat_ = false;',
		'  std::vector<T> vals_;',
		'  T median_{};',
		'  T last() const { return vals_.back(); }', // +5
		'};',
		'template <class T>',
		'bool df_equal(const T a, const T b) { return a == b; }',
		'template <class T>',
		'void df_fill(DfBucket<T>& _b, const T* _map, int _n) {', // +10
		'  int k = 0;',
		'  for (int i = 0; i < _n; ++i) {',
		'    _b.vals_[k] = _map[i];',
		'    k++;',
		'  }', // +15
		'  _b.isFlat_ = df_equal<T>(_b.vals_.front(), _b.last());',
		'  if (_b.isFlat_) _b.median_ = _b.vals_.front();',
		'}',
		'template <class T>',
		'void df_call(DfBucket<T>& _b, const T* _map) { df_fill(_b, _map, 4); }', // +20
		'void df_use() {',
		'  DfBucket<float> b;',
		'  const float m[4] = {1, 2, 3, 4};',
		'  df_call(b, m);',
		'  b.isFlat_ = false;', // +25
		'}',
		'namespace df_ns {',
		'  struct Tag {};',
		'  template <class T> void df_adl(Tag, T) {}',
		'}', // +30
		'template <class T> void df_adl_call(df_ns::Tag t, T v) { df_adl(t, v); }',
		'void df_take(int a, const char* name) {}',
		'void df_take(int a, double scale) {}',
		'template <class T> void df_pick(T v) { df_take(v, 2.5); }',
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 11 });
	try {
		const send = async (method, params) => {
			const res = await engine.send(method, { file: fixture, ...params });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			return res.result;
		};

		// the member at an access through an object of a dependent type. the access in df_use goes through a
		// specialization of the template, and it belongs to the same member
		const lineOf = (offset) => base.split('\n').length + offset;
		const member = await send('dataflow/member', { line: lineOf(16), col: 6, asyncFunctions: [] });
		assert.ok(member.member, 'no member at _b.isFlat_');
		assert.equal(member.member.className, 'DfBucket');
		// df_call gets b by reference, so the call on line 24 can change b.isFlat_
		const refs = member.refs.map((r, i) => ({ ...r, i })).filter((r) => r.file.endsWith('battery.cpp'));
		const roles = refs.sort((x, y) => x.line - y.line).map((r) => `${r.line - first} ${r.role}${r.whole ? ' whole' : ''}`);
		assert.deepEqual(roles, ['2 def', '16 write', '17 check', '24 mayWrite whole', '25 write']);

		// a rail from the write to the check, through the same object _b
		const write = refs.find((r) => r.line === lineOf(16));
		const check = refs.find((r) => r.line === lineOf(17));
		assert.ok(member.edges.some(([from, to]) => from === write.i && to === check.i), JSON.stringify(member.edges));

		// the same member by the class and the name
		const byName = await send('dataflow/member', { className: 'DfBucket', member: 'isFlat_', asyncFunctions: [] });
		assert.equal(byName.refs.length, member.refs.length);

		// the structure: the paths of the data members, and the indexes are reads
		const structure = await send('dataflow/structure', { line: lineOf(11), col: 3 });
		const at = (line, path) => structure.accesses.filter((a) => a.line === lineOf(line) && a.path === path).map((a) => a.role);
		assert.deepEqual(at(13, '_b.vals_'), ['write']);
		assert.deepEqual(at(13, 'k'), ['read']);
		assert.deepEqual(at(13, 'i'), ['read']);
		assert.deepEqual(at(16, '_b.isFlat_'), ['write']);
		assert.deepEqual(at(17, '_b.isFlat_'), ['read']); // the structure has no role check
		assert.deepEqual(at(17, '_b.median_'), ['write']);
		assert.deepEqual(at(16, '_b.vals_'), ['read']);

		// the flow of the local variables: the index k is a read
		const flow = await send('dataflow/flow', { line: lineOf(11), col: 3 });
		const k = flow.variables.findIndex((v) => v.name === 'k');
		assert.deepEqual(flow.refs.filter((r) => r.var === k).map((r) => `${r.line - first} ${r.role}`), ['11 def', '13 read', '14 write']);

		// the calls of templates with dependent arguments
		const calls = await send('dataflow/calls', { eventFunctions: [], asyncFunctions: [], roots: [] });
		const name = (i) => calls.functions[i].qualifiedName;
		const edges = calls.calls.map((c) => `${name(c.from)} -> ${name(c.to)}`);
		assert.ok(edges.includes('df_call -> df_fill'), edges.filter((e) => e.startsWith('df_')).join('\n'));
		assert.ok(edges.includes('df_fill -> df_equal'), edges.filter((e) => e.startsWith('df_')).join('\n'));
		assert.ok(edges.includes('df_use -> df_call'), edges.filter((e) => e.startsWith('df_')).join('\n'));

		// a name with no namespace: the namespaces of the arguments give the function, as in the instantiation
		assert.ok(edges.includes('df_adl_call -> df_ns::df_adl'), edges.filter((e) => e.startsWith('df_')).join('\n'));

		// two overloads with the same number of parameters: the argument 2.5 has no dependent type, and only the
		// overload with the parameter double can take it
		const take = calls.calls.filter((c) => name(c.from) === 'df_pick').map((c) => calls.functions[c.to].range?.begin - first);
		assert.deepEqual(take, [33]);
	} finally {
		engine.notify('textDocument/didClose', { file: fixture });
	}
});

test('a change of the whole object is a definition on the rail of a data member', async () => {
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length;
	const extra = [
		'struct DfState {', // +0
		'  int count_ = 0;',
		'  int other_ = 0;',
		'};',
		'void df_reset(DfState& s);',
		'void df_whole() {', // +5
		'  DfState st;',
		'  st.count_ = 1;',
		'  st.other_ = 2;',
		'  df_reset(st);',
		'  int a = st.count_;', // +10
		'  st = DfState{};',
		'  int b = st.count_;',
		'}',
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 14 });
	try {
		const res = await engine.send('dataflow/member', { file: fixture, line: first + 7, col: 6, asyncFunctions: [] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		const { member, refs, edges } = res.result;
		assert.equal(member?.name, 'count_');

		// the call that gets st by reference may write count_. the assignment of st writes it. a write of other_ is not
		// a change of count_
		const at = (r) => `${r.line - first} ${r.role}${r.whole ? ` all of ${r.object}` : ''}`;
		const mine = refs.map((r, i) => ({ ...r, i })).filter((r) => r.file.endsWith('battery.cpp') && r.line >= first);
		assert.deepEqual(mine.sort((x, y) => x.line - y.line).map(at),
			['1 def', '7 write', '9 mayWrite all of st', '10 read', '11 write all of st', '12 read']);

		// the rails: the read on line +10 gets the write and the call. the assignment of st ends the rail of the first
		// write, so the read on line +12 gets the assignment only
		const index = (offset) => mine.find((r) => r.line === first + offset).i;
		const into = (offset) => edges.filter(([, to]) => to === index(offset)).map(([from]) => refs[from].line - first).sort((x, y) => x - y);
		assert.deepEqual(into(10), [7, 9]);
		assert.deepEqual(into(12), [11]);
	} finally {
		engine.notify('textDocument/didClose', { file: fixture });
	}
});

test('computes the logic model of a function', async () => {
	const res = await engine.send('dataflow/logic', {
		file: fixture, function: 'process', eventFunctions: ['fire_transition'], nullableFunctions: ['get_if'],
	});
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	const m = res.result;
	assert.equal(m.errorCount, 0, m.errors.join('\n'));
	const lines = readFileSync(fixture, 'utf8').split(/\r?\n/);
	const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;

	// the else-if chain compares home_battery_ctl.state with 4 constants
	assert.deepEqual(m.chains.map((c) => [c.subject, c.items.map((i) => i.value), c.hasElse]), [['home_battery_ctl.state',
		['HOMEPOWER_CHARGE_PLANNING', 'HOMEPOWER_CHARGE_ACTIVE', 'HOMEPOWER_METER_READING', 'HOMEPOWER_METER_STABLE'], false]]);

	// each call of fire_transition with a literal that is not empty is an event. fire_transition(..., "") is not one
	assert.deepEqual(m.events.map((e) => e.label).sort(),
		['_ended', '_full', '_measured', '_planned', '_planned', '_saved', '_timeout', 'stop', 'stop']);
	const detected = m.events.find((e) => e.label === '_measured');
	assert.deepEqual([detected.line, detected.len], [lineOf('"_measured"'), '"_measured"'.length]);

	// the && in the condition of the future check is a part of that decision, in the CHARGE_PLANNING branch
	const future = m.decisions.find((d) => d.text.startsWith('home_battery_ctl.charging_future'));
	assert.equal(future.condBlocks.length, 1);
	assert.deepEqual([m.decisions[future.parent].text, future.parentBranch], ['home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING', 'yes']);

	// the loop over the pending data has the choices enter and skip
	assert.deepEqual(m.decisions.filter((d) => d.kind === 'loop').map((d) => d.branches.map((b) => b.label)), [['enter', 'skip']]);

	// cur_tariff_plan comes from get_if, and the dereference has no null check
	assert.deepEqual(m.nullable.map((n) => [n.var, n.source, n.at.line, n.derefs.map((d) => d.line), n.checks.length]),
		[['cur_tariff_plan', 'get_if', lineOf('auto cur_tariff_plan = get_if'), [lineOf('*cur_tariff_plan)')], 0]]);

	// the return statements of the function with the text of the value. The mark is the keyword
	const start = lineOf('std::optional<Requests> process(');
	const returnLines = lines.map((l, i) => (i + 1 > start && /^\s*return\b/.test(l) ? i + 1 : 0)).filter((n) => n > 0);
	const returns = [...m.returns].sort((a, b) => a.line - b.line);
	assert.deepEqual(returns.map((r) => r.line), returnLines.filter((n) => n <= m.function.range.end.line));
	assert.deepEqual([...new Set(returns.map((r) => r.value))].sort(), ['requests', 'std::nullopt']);
	assert.ok(returns.every((r) => r.len === 'return'.length && r.block >= 0), JSON.stringify(returns));
});

test('logic: a change through a local reference, a local pointer or an iterator is an effect on its object', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-alias-'));
	const lines = [
		'#include <map>',
		'#include <vector>',
		'struct Store {',
		'  std::vector<int> data;',
		'  std::map<int, int> index;',
		'  void put(int x, std::vector<int>& out) {',
		'    auto& d = data;',
		'    d.push_back(x);',
		'    int* p = &index[x];',
		'    *p = 1;',
		'    auto it = index.find(x);',
		'    it->second = 2;',
		'    auto& o = out;',
		'    o.clear();',
		'    std::vector<int> local;',
		'    auto& l = local;',
		'    l.push_back(x);',
		'    const auto& c = data;',
		'    int y = c[0];',
		'    (void)y;',
		'  }',
		'};',
	];
	const file = path.join(dir, 'store.cpp');
	writeFileSync(file, lines.join('\n') + '\n');
	const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/logic', { file, function: 'Store::put' });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		// a write through a local variable that a data member or a parameter initializes. The local vector and the
		// const reference give no effect
		assert.deepEqual(res.result.effects.map((e) => `${e.line} ${e.target} ${e.action} ${e.kind}`), [
			`${lineOf('d.push_back(x);')} d push_back member`, `${lineOf('*p = 1;')} *p = member`,
			`${lineOf('it->second = 2;')} it->second = member`, `${lineOf('o.clear();')} o clear parameter`,
		]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('logic: constant events, null checks of smart pointers, effects, and a lambda with its own logic', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-logic-'));
	const lines = [
		'#include <memory>',
		'#include <optional>',
		'#include <string_view>',
		'#include <vector>',
		'',
		'void fire_transition(int& state, std::string_view to);',
		'enum class Mode { Idle, Busy };',
		'void set_mode(Mode m);',
		'struct Widget { int value = 0; };',
		'Widget* find_raw(int id);',
		'std::shared_ptr<Widget> find_shared(int id);',
		'std::optional<int> find_value(int id);',
		'bool is_valid(const Widget* w);',
		'constexpr const char* kDetected = "detected";',
		'constexpr std::string_view kMoved = "moved";',
		'int g_count = 0;',
		'',
		'struct Machine {',
		'  int state = 0;',
		'  std::vector<int> items;',
		'  int total = 0;',
		'',
		'  void step(int id, std::vector<int>& out, int* sum) {',
		'    fire_transition(state, kDetected);',
		'    fire_transition(state, kMoved);',
		'    set_mode(Mode::Busy);',
		'    Widget* w = find_raw(id);',
		'    if (is_valid(w)) total += w->value;',
		'    auto s = find_shared(id);',
		'    if (s != nullptr) total += s->value;',
		'    total += s->value;',
		'    auto v = find_value(id);',
		'    if (v.has_value()) total += *v;',
		'    items.push_back(id);',
		'    out.push_back(total);',
		'    *sum = total;',
		'    ++g_count;',
		'    int local = 0;',
		'    local++;',
		'    int x = items[0];',
		'    items[0] = x;',
		'    auto add = [&](int k) {',
		'      if (k > 0) local += k;',
		'      else total -= k;',
		'    };',
		'    add(id);',
		'  }',
		'};',
	];
	const file = path.join(dir, 'machine.cpp');
	writeFileSync(file, lines.join('\n') + '\n');
	const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const options = { eventFunctions: ['fire_transition', 'set_mode'], nullableFunctions: ['find_raw', 'find_shared', 'find_value'], checkFunctions: ['is_valid'] };
		const res = await own.send('dataflow/logic', { file, function: 'Machine::step', ...options });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		const m = res.result;
		assert.equal(m.errorCount, 0, m.errors.join('\n'));

		// a constant gives the label of an event, and the mark is the argument. With no string, the enum constant gives it
		assert.deepEqual(m.events.map((e) => `${e.label} ${e.line} ${e.len}`), [
			`detected ${lineOf('kDetected);')} ${'kDetected'.length}`, `moved ${lineOf('kMoved);')} ${'kMoved'.length}`,
			`Busy ${lineOf('Mode::Busy);')} ${'Mode::Busy'.length}`,
		]);

		// is_valid(w) checks w. The check of s != nullptr covers only its own branch, and v.has_value() checks v
		assert.deepEqual(m.nullable.map((n) => [n.var, n.source, n.derefs.map((d) => d.line), n.checks.length]), [
			['w', 'find_raw', [lineOf('total += w->value')], 1],
			['s', 'find_shared', [lineOf('if (s != nullptr)'), lineOf('    total += s->value;')], 1],
			['v', 'find_value', [lineOf('total += *v')], 1],
		]);

		// the effects: data members, the objects of the parameters out and sum, and the global. local is a local
		// variable, and the read of items[0] changes nothing
		const effects = m.effects.map((e) => `${e.line - lineOf('void step(')} ${e.target} ${e.action} ${e.kind}`);
		assert.deepEqual(effects, [
			'5 total += member', '7 total += member', '8 total += member', '10 total += member', '11 items push_back member',
			'12 out push_back parameter', '13 *sum = parameter', '14 g_count ++ global', '18 items[0] = member',
		]);

		// a position in the lambda gives the logic of the lambda, with its own decision. The lambda writes a variable that
		// it captures by reference, and a data member through this
		const inLambda = await own.send('dataflow/logic', { file, line: lineOf('if (k > 0)'), col: 7, ...options });
		assert.equal(inLambda.error, undefined, JSON.stringify(inLambda.error));
		const l = inLambda.result;
		assert.deepEqual([l.function.name, l.function.qualifiedName, l.lambda, l.enclosing.qualifiedName],
			['lambda', 'Machine::step::(lambda 1)', 0, 'Machine::step']);
		assert.deepEqual(l.decisions.map((d) => d.text), ['k > 0']);
		assert.deepEqual(l.effects.map((e) => `${e.target} ${e.action} ${e.kind}`), ['local += capture', 'total -= member']);
		assert.deepEqual([l.function.range.begin.line, l.function.range.end.line], [lineOf('auto add = [&]'), lineOf('    };')]);

		// the lambda by its index, after an edit, and the lambda at a position for functionAt
		const byIndex = await own.send('dataflow/logic', { file, function: 'Machine::step', lambda: 0, ...options });
		assert.equal(byIndex.result.function.qualifiedName, 'Machine::step::(lambda 1)');
		const at = await own.send('dataflow/functionAt', { file, line: lineOf('else total -= k'), col: 7 });
		assert.deepEqual([at.result.function.qualifiedName, at.result.lambda?.index], ['Machine::step', 0]);
		const outside = await own.send('dataflow/functionAt', { file, line: lineOf('add(id);'), col: 5 });
		assert.equal(outside.result.lambda, undefined);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('finds the hidden C++ of the functions of a file', async () => {
	const res = await engine.send('dataflow/cost', { file: fixture, minCopyBytes: 16 });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	const { items, functions } = res.result;
	const lines = readFileSync(fixture, 'utf8').split(/\r?\n/);
	const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;
	const fn = functions.findIndex((f) => f.name === 'stable_readings');
	const mine = items.filter((i) => i.fn === fn);
	const at = (kind, line) => mine.filter((i) => i.kind === kind && i.line === line);

	// acceptance scenario 3: the static map, the copy of GridStatus, the lookups of one key, and the shadowed taps
	assert.equal(at('state', lineOf('static std::map')).length, 1);
	assert.ok(at('copy', lineOf('MeterRead{state')).some((i) => i.pattern === 'copy|GridStatus'), JSON.stringify(mine));
	const lookups = mine.filter((i) => i.kind === 'lookup');
	assert.equal(lookups.length, 1);
	assert.equal(lookups[0].related.length + 1, 7);
	assert.match(lookups[0].detail, /5 times on one path: contains 1, \[\] 4\./);
	const outerTags = lineOf('const auto &taps = stream.get_channels');
	assert.deepEqual(at('shadow', lineOf('const auto &taps = stream.history')).map((i) => i.text), [`hides taps of line ${outerTags}`]);

	// the temporary map lives to the end of the outer loop, and its destructor runs there
	assert.equal(at('temporary', outerTags).length, 1);
	assert.ok(at('destructor', lineOf('return data;') - 1).some((i) => i.text === '~taps'));

	// a return with NRVO is no move, and a small trivially copyable type is no copy
	assert.ok(!mine.some((i) => i.kind === 'move'), JSON.stringify(mine));
	assert.ok(!items.some((i) => i.kind === 'copy' && i.pattern === 'copy|long long'));

	// each string literal for the const std::string& parameter of fire_transition makes a temporary
	assert.ok(items.some((i) => i.kind === 'temporary' && i.line === lineOf('"_measured"') && i.pattern === 'temporary|std::string'));
});

test('finds new and make_unique as allocations, but not a placement new', async () => {
	const added = [
		'#include <memory>',
		'#include <new>',
		'int added_allocations(void* _buf) {',
		'  int* a = new (_buf) int(1);',
		'  int* b = new int(2);',
		'  const auto c = std::make_unique<int>(3);',
		'  const int out = *a + *b + *c;',
		'  delete b;',
		'  return out;',
		'}',
	];
	const text = readFileSync(fixture, 'utf8') + '\n' + added.join('\n') + '\n';
	engine.notify('textDocument/didOpen', { file: fixture, text, version: 2 });
	const res = await engine.send('dataflow/cost', { file: fixture, minCopyBytes: 16 });
	engine.notify('textDocument/didClose', { file: fixture });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));

	const lines = text.split(/\r?\n/);
	const lineOf = (s) => lines.findIndex((l) => l.includes(s)) + 1;
	const fn = res.result.functions.findIndex((f) => f.name === 'added_allocations');
	const allocations = res.result.items.filter((i) => i.fn === fn && i.kind === 'allocation').sort((a, b) => a.line - b.line);
	assert.deepEqual(allocations.map((i) => [i.line, i.text]), [
		[lineOf('new int(2)'), 'allocation: new int'],
		[lineOf('make_unique<int>'), 'allocation: make_unique<int>'],
	]);
});

test('metrics: the decisions, the depth, the loops, the shared writes, the costs in loops and the first declaration', async () => {
	const added = [
		'#include <memory>',
		'int df_metrics(int& _out, int* _ptr, int _n) {',
		'  static int calls = 0;',
		'  ++calls;',
		'  int sum = 0;',
		'  for (int i = 0; i < _n; ++i) {',
		'    if (i % 2 == 0 && i > 2) {',
		'      sum += i;',
		'    } else if (i > 5) {',
		'      sum -= i;',
		'    }',
		'    const auto p = std::make_unique<int>(i);',
		'    sum += *p;',
		'  }',
		'  switch (_n) {',
		'    case 1: sum = 1; break;',
		'    case 2: sum = 2; break;',
		'    default: break;',
		'  }',
		'  _ptr = nullptr;',
		'  _out = sum > 0 ? sum : 0;',
		'  return sum;',
		'}',
		'struct DfBase {',
		'  virtual ~DfBase() = default;',
		'  virtual int value() const { return 1; }',
		'};',
		'struct DfDerived : DfBase {',
		'  int value() const override { return 2; }',
		'};',
	];
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const text = base + added.join('\n') + '\n';
	engine.notify('textDocument/didOpen', { file: fixture, text, version: 3 });
	const res = await engine.send('dataflow/metrics', { file: fixture });
	engine.notify('textDocument/didClose', { file: fixture });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));

	// the line of an added line, and a path in a form for a comparison
	const lineOf = (s) => base.split('\n').length + added.findIndex((l) => l.includes(s));
	const where = (d) => ({ file: d.file.toLowerCase(), line: d.line });
	const fn = (name) => res.result.functions.find((f) => f.qualifiedName === name);
	const m = fn('df_metrics');
	// for, if, &&, else if, 2 case labels and ?:. the else if has the depth of its if
	assert.deepEqual([m.decisions, m.depth], [7, 2]);
	assert.deepEqual(m.loops, [[lineOf('i < _n'), lineOf('sum += *p;') + 1]]);
	assert.equal(m.bodyLines, lineOf('return sum;') + 2 - lineOf('int df_metrics('));
	// the static local and the reference parameter are shared state. sum is local, and _ptr = nullptr changes only the
	// pointer
	assert.deepEqual(m.writes, [{ path: 'calls', scope: 'global' }, { path: '_out', scope: 'param' }]);
	assert.deepEqual([m.allocationsInLoops, m.copiesInLoops], [1, 0]);
	assert.deepEqual(where(m.declaration), { file: fixture.toLowerCase(), line: lineOf('int df_metrics(') });

	// virtual and override
	const values = res.result.functions.filter((f) => f.name === 'value').map((f) => [f.qualifiedName, f.virtual ?? false, f.override ?? false]);
	assert.deepEqual(values, [['DfBase::value', true, false], ['DfDerived::value', true, true]]);

	// process() and the overload of stable_readings with three parameters have their first declarations in the header
	const process = fn('electricity::power_ctrl::process');
	assert.deepEqual(where(process.declaration), { file: header.toLowerCase(), line: 171 });
	assert.ok(process.decisions > 5, JSON.stringify(process));
	const readings = res.result.functions.find((f) => f.name === 'stable_readings');
	const headerLine = readFileSync(header, 'utf8').split(/\r?\n/).findIndex((l) => l.startsWith('std::vector<MeterRead> stable_readings(const MeterFeeds')) + 1;
	assert.deepEqual(where(readings.declaration), { file: header.toLowerCase(), line: headerLine });
});

test('templates: no instantiations in the function list, and Hidden C++ gets the items of the instantiations', async () => {
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length;
	const extra = [
		'template <class T>', // +0
		'T df_twice(const T& v) {',
		'  T copy = v;',
		'  return copy + copy;',
		'}',
		'template <class T>', // +5
		'struct DfBox {',
		'  T value_;',
		'  T get() const { return value_; }',
		'};',
		'std::string df_use_templates() {', // +10
		'  const DfBox<std::string> box{"text"};',
		'  const int n = df_twice(2);',
		'  return df_twice(box.get()) + std::to_string(n);',
		'}',
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 12 });
	try {
		const send = async (method, params) => {
			const res = await engine.send(method, { file: fixture, ...params });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			return res.result;
		};

		// each template one time, with no instantiations
		const names = (await send('dataflow/functions', {})).functions.map((f) => f.qualifiedName);
		assert.deepEqual(names.filter((n) => n.startsWith('df_') || n.startsWith('DfBox')), ['df_twice', 'DfBox::get', 'df_use_templates']);

		// Flow Lens analyzes the template: the type of copy is T, not the type of one instantiation
		const flow = await send('dataflow/flow', { line: first + 2, col: 3 });
		assert.equal(flow.variables.find((v) => v.name === 'copy')?.type, 'T');

		// the instantiations with std::string copy, and their items show at the lines of the template
		const cost = await send('dataflow/cost', { minCopyBytes: 16 });
		const itemsOf = (name) => {
			const fn = cost.functions.findIndex((f) => f.qualifiedName === name);
			return cost.items.filter((i) => i.fn === fn).map((i) => ({ ...i, at: i.line - first }));
		};
		const twice = itemsOf('df_twice');
		const copy = twice.filter((i) => i.kind === 'copy');
		assert.deepEqual(copy.map((i) => [i.at, i.pattern]), [[2, 'copy|std::string']], JSON.stringify(twice));
		assert.match(copy[0].detail, /This item comes from the instantiation df_twice<std::string>\.$/);
		assert.ok(twice.some((i) => i.kind === 'destructor' && i.at === 3 && i.text === '~copy'), JSON.stringify(twice));
		assert.ok(!twice.some((i) => i.detail.includes('df_twice<int>')), JSON.stringify(twice));

		const get = itemsOf('DfBox::get');
		assert.deepEqual(get.map((i) => [i.at, i.kind, i.pattern]), [[8, 'copy', 'copy|std::string']], JSON.stringify(get));
		assert.match(get[0].detail, /DfBox<std::string>::get/);
	} finally {
		engine.notify('textDocument/didClose', { file: fixture });
	}
});

test('computes the slice of a change and the slice of a call', async () => {
	const lines = readFileSync(fixture, 'utf8').split(/\r?\n/);
	const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;
	const asyncFunctions = ['tf::Executor::async'];

	// acceptance scenario 4: the threshold changes. a line outside of a function and a comment have no statement
	const change = lineOf('if (cost < 1e-5)');
	const res = await engine.send('dataflow/slice', {
		file: fixture, lines: [change, lineOf('#include <cmath>'), lineOf('// with no converged schedule')], asyncFunctions,
	});
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	assert.deepEqual([res.result.outside, res.result.quiet], [[lineOf('#include <cmath>')], [lineOf('// with no converged schedule')]]);
	const [solve] = res.result.bodies;
	assert.equal(solve.function.name, 'solve_power_plan');
	assert.deepEqual(solve.steps.map((s) => [s.line, s.kind, s.confidence]),
		[[change, 'seed', 'exact'], [lineOf('res = cost;'), 'control', 'exact'], [lineOf('return res;'), 'data', 'exact']]);
	assert.deepEqual(solve.exits.map((e) => e.kind), ['return']);

	// the caller in this file is the lambda of the async call in process()
	const async = lineOf('executor.async(');
	assert.deepEqual(solve.callers.map((c) => [c.line, c.function]), [[async, 'electricity::power_ctrl::process']]);
	const caller = await engine.send('dataflow/slice', {
		file: fixture, call: { line: solve.callers[0].line, col: solve.callers[0].col }, asyncFunctions, confidence: 'call',
	});
	assert.equal(caller.error, undefined, JSON.stringify(caller.error));
	const [lambda, process] = caller.result.bodies;
	assert.ok(lambda.lambda && lambda.exits.some((e) => e.kind === 'return' && e.followed), JSON.stringify(lambda));

	// the async call, then the value of the future, its check, and the commands that process() returns
	const step = (text) => process.steps.find((s) => s.line === lineOf(text));
	assert.deepEqual([step('executor.async(').kind, step('executor.async(').confidence], ['async', 'estimated']);
	for (const text of ['auto converged = ', 'if (converged)', 'requests = make_requests', 'return requests;'])
		assert.ok(step(text), `${text}: ${JSON.stringify(process.steps.map((s) => s.line))}`);
	assert.ok(process.exits.some((e) => e.kind === 'member' && e.text === 'home_battery_ctl.charging_future' && e.followed));
	assert.ok(process.exits.some((e) => e.kind === 'return' && e.text === 'return requests'));

	// a state shift gets home_battery_ctl by reference, but the new future does not make it a part of the slice
	assert.ok(!step('fire_transition(home_battery_ctl, "", true)'), JSON.stringify(process.steps.map((s) => s.line)));

	// the value of the future decides whether a state shift runs. The called function can change more data, so its
	// call is an exit. A call in the body of a lambda does not count
	const calls = process.exits.filter((e) => e.kind === 'call');
	assert.ok(calls.some((e) => e.text === 'electricity::power_ctrl::fire_transition' && !e.followed), JSON.stringify(process.exits));
	assert.ok(!calls.some((e) => e.text.endsWith('solve_power_plan')), JSON.stringify(calls));
});

test('functions: a function whose name ## makes in a macro gets the text of the macro call', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-macros-'));
	const lines = [
		'#define CAT_(a, b) a##b',
		'#define CAT(a, b) CAT_(a, b)',
		'#define TEST_CASE(...) static void CAT(INTERNAL_TEST_, __COUNTER__)()',
		'#define TEST(suite, name) struct suite##_##name##_Test { void TestBody(); }; void suite##_##name##_Test::TestBody()',
		'#define MAKE_TR static int tr() { return 1; }',
		'#define NAMED(fn) int fn() { return 2; }',
		'TEST_CASE("split",',
		'          "[text]") {',
		'  int x = 0;',
		'  (void)x;',
		'}',
		'TEST(Pool, Post) {',
		'}',
		'struct Widget { MAKE_TR };',
		'NAMED(plain)',
		'int normal() { return 3; }',
	];
	const file = path.join(dir, 'tests.cpp');
	writeFileSync(file, lines.join('\n') + '\n');
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/functions', { file });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		// the text of the call is on one line. A name in the body of a macro or in an argument stays the name
		assert.deepEqual(res.result.functions.map((f) => [f.qualifiedName, f.macroCall]), [
			['INTERNAL_TEST_0', 'TEST_CASE("split", "[text]")'],
			['Pool_Post_Test::TestBody', 'TEST(Pool, Post)'],
			['Widget::tr', undefined],
			['plain', undefined],
			['normal', undefined],
		]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('hidden: the lookups of a group are on one path, with no change of the container or of the key between them', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-lookups-'));
	const lines = [
		'#include <map>',
		'#include <string>',
		'int f(std::map<std::string, int>& m, const std::string& k, bool c, int i0) {',
		'  int s = 0;',
		'  if (c) s += m.at(k);',
		'  else s += int(m.count(k));',
		'  std::map<int, int> n;',
		'  int i = i0;',
		'  s += int(n.count(i));',
		'  ++i;',
		'  s += int(n.count(i));',
		'  std::map<std::string, int> q;',
		'  for (int j = 0; j < 3; ++j) {',
		'    s += q.at(k);',
		'    s += int(q.count(k));',
		'  }',
		'  s += int(m.count(k));',
		'  return s + m.at(k);',
		'}',
	];
	const file = path.join(dir, 'lookups.cpp');
	writeFileSync(file, lines.join('\n') + '\n');
	const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/cost', { file, minCopyBytes: 16 });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		const lookups = res.result.items.filter((i) => i.kind === 'lookup').map((i) => [i.line, i.text, i.related.map((r) => r.line)]);
		// the two branches of the if are not one path, so a path has 3 lookups of k in m. A change of i between the
		// lookups of n makes no group. Two lookups in one turn of a loop are one group
		assert.deepEqual(lookups, [
			[lineOf('if (c) s += m.at(k);'), '3 lookups of k in m',
				[lineOf('else s += int(m.count(k));'), lineOf('  s += int(m.count(k));'), lineOf('return s + m.at(k);')]],
			[lineOf('s += q.at(k);'), '2 lookups of k in q', [lineOf('s += int(q.count(k));')]],
		]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('hidden: a sign change is a conversion, and a name of the standard library keeps std:: in each part of a type', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-signs-'));
	const lines = [
		'#include <cstdint>',
		'#include <optional>',
		'#include <vector>',
		'namespace geo { struct Transform { double m[16]; }; }',
		'int32_t f(const std::vector<int32_t>& v, std::optional<std::vector<double>> o, geo::Transform t) {',
		'  int32_t s = v.front();',
		'  uint32_t u = s;',
		'  int32_t back = u;',
		'  int64_t wide = u;',
		'  uint64_t big = s;',
		'  int16_t narrow = s;',
		'  auto o2 = o;',
		'  geo::Transform t2 = t;',
		'  return back + int32_t(wide) + int32_t(big) + narrow + int32_t(o2->size()) + int32_t(t2.m[0]);',
		'}',
	];
	const file = path.join(dir, 'signs.cpp');
	writeFileSync(file, lines.join('\n') + '\n');
	const lineOf = (text) => lines.findIndex((l) => l.includes(text)) + 1;
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/cost', { file, minCopyBytes: 16 });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		const items = res.result.items;
		const at = (text) => items.filter((i) => i.line === lineOf(text)).map((i) => i.pattern);

		// a signed type to an unsigned type, also a wider one, and an unsigned type to a signed type of the same width.
		// An unsigned type to a wider signed type keeps the value
		assert.deepEqual(at('uint32_t u = s;'), ['sign|int32_t>uint32_t']);
		assert.deepEqual(at('int32_t back = u;'), ['sign|uint32_t>int32_t']);
		assert.deepEqual(at('int64_t wide = u;'), []);
		assert.deepEqual(at('uint64_t big = s;'), ['sign|int32_t>uint64_t']);
		assert.deepEqual(at('int16_t narrow = s;'), ['conversion|int32_t>int16_t']);
		assert.match(items.find((i) => i.pattern === 'sign|int32_t>uint32_t').detail, /A negative value becomes a large value\.$/);

		// the outer name of the standard library keeps std::, as the names in it. A different outer name has no scope
		assert.ok(at('auto o2 = o;').includes('copy|std::optional<std::vector<double>>'), JSON.stringify(at('auto o2 = o;')));
		assert.ok(at('geo::Transform t2 = t;').includes('copy|Transform'), JSON.stringify(at('geo::Transform t2 = t;')));
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('slice: a change that a lambda captures continues in the lambda if the function calls the lambda', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-slice-lambda-'));
	const lines = [
		'int use(int v);',
		'int run(int a) {',
		'  int x = 0;',
		'  x = a + 1;',
		'  auto f = [&] {',
		'    return use(x);',
		'  };',
		'  auto g = [&] {',
		'    return use(x) * 2;',
		'  };',
		'  [&] {',
		'    use(x);',
		'  }();',
		'  return f();',
		'}',
	];
	const file = path.join(dir, 'run.cpp');
	writeFileSync(file, lines.join('\n') + '\n');
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/slice', { file, lines: [4], asyncFunctions: [] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		const steps = res.result.bodies.flatMap((b) => b.steps.map((s) => s.line));
		// the function calls f through its variable and the third lambda at once, so the change gets to their uses of x.
		// It never calls g
		assert.ok(steps.includes(6) && steps.includes(12), JSON.stringify(steps));
		assert.ok(!steps.includes(9), JSON.stringify(steps));
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a deleted write affects the later uses of its target', async () => {
	const lines = readFileSync(fixture, 'utf8').split(/\r?\n/);
	const at = lines.findIndex((l) => l.includes('res = cost;'));
	const [deleted] = lines.splice(at, 1);
	engine.notify('textDocument/didOpen', { file: fixture, text: lines.join('\n'), version: 3 });
	const res = await engine.send('dataflow/slice', { file: fixture, deleted: [{ line: at + 1, text: deleted }] });
	engine.notify('textDocument/didClose', { file: fixture });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	assert.deepEqual(res.result.bodies.flatMap((b) => b.steps.map((s) => [s.text, s.via])), [['return res', 'deleted res']]);
});

// The tokens of a line of a dataflow/tokens result as [text, kind, modifiers]
function tokensOf(result, line) {
	const { kinds, modifiers } = result.legend;
	const l = result.lines.find((x) => x.line === line);
	assert.ok(l, `line ${line} is not in the result`);
	const bytes = Buffer.from(l.text, 'utf8');
	const out = [];
	for (let i = 0; i < l.tokens.length; i += 4) {
		const [col, len, kind, mods] = l.tokens.slice(i, i + 4);
		out.push([bytes.subarray(col - 1, col - 1 + len).toString('utf8'), kinds[kind], modifiers.filter((_, b) => mods & (1 << b))]);
	}
	return out;
}

test('gives the kinds of the tokens of a file', async () => {
	const text = readFileSync(fixture, 'utf8');
	const lineOf = (s) => text.split(/\r?\n/).findIndex((l) => l.includes(s)) + 1;
	// the kind and the modifiers of a name on the first line that contains the text
	const kindAt = (s, name) => tokensOf(res.result, lineOf(s)).find(([t]) => t === name)?.slice(1);

	const res = await engine.send('dataflow/tokens', { file: fixture });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	assert.equal(res.result.lines.length, res.result.lineCount);
	assert.equal(res.result.version, -1);
	console.log(`tokens of ${res.result.lineCount} lines in ${res.result.analysisMs.toFixed(1)} ms`);

	assert.deepEqual(tokensOf(res.result, 1), [['#', 'preprocessor', []], ['include', 'preprocessor', []], ['<battery/types.hpp>', 'string', []]]);
	const signature = 'std::optional<charge::Preset> best_preset(';
	assert.deepEqual(kindAt(signature, 'std'), ['namespace', ['defaultLibrary']]);
	assert.deepEqual(kindAt(signature, 'optional'), ['class', ['defaultLibrary']]);
	assert.deepEqual(kindAt(signature, 'Preset'), ['class', []]);
	assert.deepEqual(kindAt(signature, 'best_preset'), ['function', ['declaration']]);
	assert.deepEqual(kindAt(signature, 'PresetDb'), ['type', []]);
	assert.deepEqual(kindAt(signature, 'presetDb'), ['parameter', ['declaration', 'readonly']]);
	assert.deepEqual(tokensOf(res.result, lineOf('// the kw of the active plan')), [['// the kw of the active plan', 'comment', []]]);
	assert.deepEqual(kindAt('std::abs(cost', 'if'), ['keyword.control', []]);
	assert.deepEqual(kindAt('std::abs(cost', 'last_cost'), ['property', []]);
	assert.deepEqual(kindAt('std::abs(cost', 'abs'), ['function', ['defaultLibrary']]);
	assert.deepEqual(kindAt('std::abs(cost', '1e-7'), ['number', []]);
	assert.deepEqual(kindAt('charge.optimizers[main_optimizer_id]', 'auto'), ['keyword.type', []]);
	assert.deepEqual(kindAt('charge.optimizers[main_optimizer_id]', 'opt'), ['variable', ['declaration']]);
	assert.deepEqual(kindAt('charge.optimizers[main_optimizer_id]', 'main_optimizer_id'), ['variable', ['readonly']]);
	assert.deepEqual(kindAt('== HOMEPOWER_CHARGE_PLANNING', 'HOMEPOWER_CHARGE_PLANNING'), ['enumMember', ['readonly']]);
	assert.deepEqual(kindAt('FINISHED(', 'FINISHED'), ['macro', []]);
	assert.deepEqual(kindAt('executor.async(', 'async'), ['method', []]);
	assert.deepEqual(kindAt('executor.async(', 'solve_power_plan'), ['function', []]);
	assert.deepEqual(kindAt('static std::map', 'static'), ['keyword.modifier', []]);
	assert.deepEqual(kindAt('static std::map', 'last_read'), ['variable', ['declaration', 'static']]);
	assert.deepEqual(kindAt('data.push_back(', 'push_back'), ['method', ['defaultLibrary']]);

	// the second request uses the tokens of the same parse
	const part = await engine.send('dataflow/tokens', { file: fixture, first: 9, last: 10 });
	assert.equal(part.result.cached, true);
	assert.equal(part.result.lineCount, res.result.lineCount);
	assert.deepEqual(part.result.lines.map((l) => l.line), [9, 10]);
	assert.deepEqual(part.result.lines, res.result.lines.slice(8, 10));
});

test('gives the kinds of dependent names, comments on more than one line and instantiated code', async () => {
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length;
	const extra = [
		'/* first line',
		'   second line */',
		'template <class T> int dependent_call(T t) { return t.size() + helper(t) + T::count + T::make(); }',
		'namespace probe {',
		'struct Row { int v[2]; constexpr int operator[](int i) const { return v[i]; } };',
		'template <class T> consteval int first_of() { constexpr Row row{{4, 5}}; return row[0]; }',
		'constexpr int probe_value = first_of<int>();',
		'} // namespace probe',
		'#if 0',
		') stray',
		'#endif',
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 4 });
	const res = await engine.send('dataflow/tokens', { file: fixture, first, last: first + extra.length - 1 });
	engine.notify('textDocument/didClose', { file: fixture });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
	assert.equal(res.result.version, 4);

	const kinds = (line) => tokensOf(res.result, line).filter(([, k]) => !['operator', 'punctuation'].includes(k));
	assert.deepEqual(kinds(first), [['/* first line', 'comment', []]]);
	assert.deepEqual(kinds(first + 1), [['   second line */', 'comment', []]]);
	// a dependent name with a qualifier is a static data member, or a function if the code calls it
	assert.deepEqual(kinds(first + 2).filter(([t]) => ['T', 't', 'size', 'helper', 'count', 'make'].includes(t)), [
		['T', 'typeParameter', ['declaration']], ['T', 'typeParameter', []], ['t', 'parameter', ['declaration']],
		['t', 'parameter', []], ['size', 'method', []], ['helper', 'function', []], ['t', 'parameter', []],
		['T', 'typeParameter', []], ['count', 'property', ['static']], ['T', 'typeParameter', []], ['make', 'function', []],
	]);
	// the call of operator[] has the position of row, also in the instantiation of first_of. row stays a variable
	assert.deepEqual(kinds(first + 5).filter(([t]) => t === 'row'), [['row', 'variable', ['declaration', 'readonly']], ['row', 'variable', ['readonly']]]);
	assert.deepEqual(kinds(first + 6).slice(0, 4), [
		['constexpr', 'keyword.modifier', []], ['int', 'keyword.type', []], ['probe_value', 'variable', ['declaration', 'readonly']], ['first_of', 'function', []],
	]);

	// a bracket has its level of nesting in the place of the modifiers. a closing bracket without an opening bracket has -1
	const levels = (line) => {
		const l = res.result.lines.find((x) => x.line === line);
		const out = [];
		for (let i = 0; i < l.tokens.length; i += 4) {
			if (res.result.legend.kinds[l.tokens[i + 2]] === 'bracket') {
				out.push(l.tokens[i + 3]);
			}
		}
		return out;
	};
	assert.deepEqual(levels(first + 2), [0, 0, 0, 1, 1, 1, 1, 1, 1, 0]);
	assert.deepEqual(levels(first + 9), [-1]);
});

test('gives the kinds of attributes, of the words after #pragma and of the parameters of a macro', async () => {
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length;
	const extra = [
		'#pragma GCC diagnostic ignored "-Wunused"',
		'#define PROBE_MAX(a, b) ((a) > (b) ? (a) : (b))',
		'#define PROBE_LOG(fmt, ...) probe_log(fmt __VA_OPT__(,) __VA_ARGS__)',
		'#define PROBE_OBJ (a)',
		'[[nodiscard]] inline int probe_attr([[maybe_unused]] int x) { return PROBE_MAX(1, 2); }',
		'[[gnu::always_inline]] inline int probe_gnu() { return 0; }',
		'__declspec(noinline) int probe_ms(int v[2]) { return v[(0)] + ((v[1])); }',
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 5 });
	const res = await engine.send('dataflow/tokens', { file: fixture, first, last: first + extra.length - 1 });
	const perType = await engine.send('dataflow/tokens', { file: fixture, first, last: first + extra.length - 1, bracketLevelPerType: true });
	engine.notify('textDocument/didClose', { file: fixture });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));

	const names = (line) => tokensOf(res.result, line).filter(([, k]) => !['operator', 'punctuation', 'bracket'].includes(k));
	assert.deepEqual(names(first), [['#', 'preprocessor', []], ['pragma', 'preprocessor', []], ['GCC', 'pragma', []], ['diagnostic', 'pragma', []],
		['ignored', 'pragma', []], ['"-Wunused"', 'string', []]]);
	// a parameter of a macro is a parameter in the list and in the body
	assert.deepEqual(names(first + 1).slice(2), [['PROBE_MAX', 'macro', ['declaration']], ['a', 'parameter', ['declaration']],
		['b', 'parameter', ['declaration']], ['a', 'parameter', []], ['b', 'parameter', []], ['a', 'parameter', []], ['b', 'parameter', []]]);
	assert.deepEqual(names(first + 2).slice(3), [['fmt', 'parameter', ['declaration']], ['fmt', 'parameter', []], ['__VA_OPT__', 'preprocessor', []],
		['__VA_ARGS__', 'parameter', []]]);
	// a macro with a space before the round bracket has no parameters
	assert.deepEqual(names(first + 3).slice(2), [['PROBE_OBJ', 'macro', ['declaration']]]);
	// a name in an attribute is an attribute, and a name before :: in an attribute is a namespace
	assert.deepEqual(names(first + 4).filter(([, k]) => ['attribute', 'parameter'].includes(k)),
		[['nodiscard', 'attribute', []], ['maybe_unused', 'attribute', []], ['x', 'parameter', ['declaration']]]);
	assert.deepEqual(names(first + 5).slice(0, 2), [['gnu', 'namespace', []], ['always_inline', 'attribute', []]]);
	assert.deepEqual(names(first + 6).slice(0, 2), [['__declspec', 'keyword', []], ['noinline', 'attribute', []]]);

	// the level of a bracket among all brackets, and among the brackets of its type
	const levels = (result, line) => {
		const l = result.lines.find((x) => x.line === line);
		const out = [];
		for (let i = 0; i < l.tokens.length; i += 4) {
			if (result.legend.kinds[l.tokens[i + 2]] === 'bracket') {
				out.push(l.tokens[i + 3]);
			}
		}
		return out;
	};
	assert.deepEqual(levels(res.result, first + 6).slice(2), [0, 1, 1, 0, 0, 1, 2, 2, 1, 1, 2, 3, 3, 2, 1, 0]);
	assert.deepEqual(levels(perType.result, first + 6).slice(2), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
});

// A class in a header and its member functions in a source file, with threads, a mutex and a condition variable
const POOL_HEADER = `#pragma once

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace demo {

  class WorkerPool {
    std::vector<std::thread> threads_;
    std::deque<std::function<void()>> jobs_;
    std::mutex mutex_;
    std::condition_variable cv_;
    bool isStopping_ = false;
    int count_;
    std::atomic<int> done_{0};
    std::thread runner_;

   public:
    explicit WorkerPool(int _count);
    void post(std::function<void()>&& _job);
    void destroy();
    void take(const WorkerPool& _o);
    long bump();
    void run();

    bool is_stopping() {
      const std::lock_guard lock(mutex_);
      return isStopping_;
    }
  };

}  // namespace demo
`;
const POOL_SOURCE = `#include "worker_pool.h"

#include <algorithm>

namespace demo {

  WorkerPool::WorkerPool(const int _count) : count_(_count), runner_(&WorkerPool::run, this) {
    const int n = count_;
    for (int i = 0; i < n; ++i)
      threads_.emplace_back([this]() {
        while (true) {
          std::function<void()> job;
          {
            std::unique_lock lock(mutex_);
            cv_.wait(lock, [this]() { return isStopping_ || !jobs_.empty(); });
            if (jobs_.empty()) return;
            job = std::move(jobs_.front());
            jobs_.pop_front();
          }
          job();
          done_ += 1;
        }
      });
  }

  void WorkerPool::post(std::function<void()>&& _job) {
    {
      const std::lock_guard lock(mutex_);
      jobs_.push_back(std::move(_job));
    }
    cv_.notify_one();
  }

  void WorkerPool::destroy() {
    {
      const std::lock_guard lock(mutex_);
      isStopping_ = true;
    }
    cv_.notify_all();
    for (std::thread& t : threads_)
      if (t.joinable()) t.join();
    threads_.clear();
    if (runner_.joinable()) runner_.join();
  }

  void WorkerPool::take(const WorkerPool& _o) { count_ = _o.count_; }

  long WorkerPool::bump() {
    count_ = 1;
    const std::lock_guard lock(mutex_);
    return std::count_if(jobs_.begin(), jobs_.end(), [this](const auto&) { return count_ > 0; }) + count_;
  }

  void WorkerPool::run() {
    while (!isStopping_) std::this_thread::yield();
  }

}  // namespace demo
`;

// The line of the first line with the marker, and the column of the word on that line. Both start at 1
const placeOf = (text, marker, word = marker) => {
	const lines = text.split('\n');
	const line = lines.findIndex((l) => l.includes(marker));
	assert.ok(line >= 0, marker);
	return { line: line + 1, col: lines[line].indexOf(word, lines[line].indexOf(marker)) + 1 };
};

test('traces a data member through the member functions of its class, with threads and locks', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-member-'));
	const header = path.join(dir, 'worker_pool.h');
	const source = path.join(dir, 'worker_pool.cpp');
	writeFileSync(header, POOL_HEADER);
	writeFileSync(source, POOL_SOURCE);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file: source, arguments: ['clang++', '-std=c++20', `-I${dir}`, '-c', source] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	const lineIn = (text, marker) => placeOf(text, marker).line;
	// one text for each reference: the file, the line, the role, the function and the locks
	const summary = (result) => result.refs.map((r) => {
		const fn = r.fn >= 0 ? result.functions[r.fn].name : '-';
		return `${path.basename(r.file)}:${r.line} ${r.role} ${fn}${r.object ? ` of ${r.object}` : ''}${r.locks ? ` [${r.locks.join(', ')}]` : ''}`;
	}).sort();
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));

		// the cursor on a write in destroy(): the member is in the header, and the functions are in the source file
		const stop = await own.send('dataflow/member', { file: source, ...placeOf(POOL_SOURCE, 'isStopping_ = true'), asyncFunctions: ['std::async'] });
		assert.equal(stop.error, undefined, JSON.stringify(stop.error));
		assert.equal(stop.result.errorCount, 0, stop.result.errors.join('\n'));
		const m = stop.result.member;
		assert.deepEqual({ ...m, decl: undefined }, {
			name: 'isStopping_', type: 'bool', kind: 'field', className: 'WorkerPool', qualifiedClass: 'demo::WorkerPool',
			access: 'private', isAtomic: false, isSync: false, init: 'false', decl: undefined,
		});
		assert.equal(m.decl.file.toLowerCase(), path.normalize(header).toLowerCase());
		assert.equal(m.decl.line, lineIn(POOL_HEADER, 'bool isStopping_'));
		assert.equal(stop.result.function.name, 'destroy');
		assert.deepEqual(stop.result.fields.map((f) => f.name), ['threads_', 'jobs_', 'mutex_', 'cv_', 'isStopping_', 'count_', 'done_', 'runner_']);
		assert.ok(stop.result.fields[1].type.startsWith('std::deque<'), stop.result.fields[1].type);
		assert.deepEqual(summary(stop.result), [
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'isStopping_ = true')} write destroy [mutex_]`,
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'return isStopping_ ||')} read lambda [mutex_]`,
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'while (!isStopping_)')} check run`,
			`worker_pool.h:${lineIn(POOL_HEADER, 'bool isStopping_')} def -`,
			`worker_pool.h:${lineIn(POOL_HEADER, 'return isStopping_')} read is_stopping [mutex_]`,
		].sort());

		// the predicate runs on the worker threads that the loop starts. run() runs on the thread of runner_
		const fns = stop.result.functions;
		const threadOf = (marker) => {
			const ref = stop.result.refs.find((r) => r.line === lineIn(POOL_SOURCE, marker) && r.file.endsWith('.cpp'));
			return stop.result.threads[fns[ref.fn].thread];
		};
		const worker = threadOf('return isStopping_ ||');
		assert.deepEqual({ via: worker.via, line: worker.line, isRepeated: worker.isRepeated },
			{ via: 'std::thread', line: lineIn(POOL_SOURCE, 'threads_.emplace_back'), isRepeated: true });
		const runner = threadOf('while (!isStopping_)');
		assert.deepEqual({ via: runner.via, line: runner.line, isRepeated: runner.isRepeated },
			{ via: 'std::thread', line: lineIn(POOL_SOURCE, 'runner_(&WorkerPool::run'), isRepeated: false });
		assert.equal(threadOf('isStopping_ = true'), undefined);
		const predicate = fns[stop.result.refs.find((r) => r.line === lineIn(POOL_SOURCE, 'return isStopping_ ||')).fn];
		assert.deepEqual([predicate.kind, fns[predicate.outer].kind, fns[fns[predicate.outer].outer].kind], ['lambda', 'lambda', 'constructor']);

		// count_: the initializer of the constructor, an access through a different object, and the edges in each body.
		// the lambda of std::count_if gets the lock around it, but no edge from the write in bump()
		const count = await own.send('dataflow/member', { file: source, ...placeOf(POOL_SOURCE, 'count_ = 1') });
		assert.deepEqual(summary(count.result), [
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'count_(_count)')} def WorkerPool`,
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'const int n = count_')} read WorkerPool`,
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'count_ = _o.count_')} read take of _o`,
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'count_ = _o.count_')} write take`,
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'count_ = 1')} write bump`,
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'return count_ > 0')} read lambda [mutex_]`,
			`worker_pool.cpp:${lineIn(POOL_SOURCE, 'return count_ > 0')} read bump [mutex_]`,
			`worker_pool.h:${lineIn(POOL_HEADER, 'int count_')} def -`,
		].sort());
		const edgeLines = count.result.edges.map(([a, b]) => `${count.result.refs[a].line}>${count.result.refs[b].line}`).sort();
		assert.deepEqual(edgeLines, [
			`${lineIn(POOL_SOURCE, 'count_(_count)')}>${lineIn(POOL_SOURCE, 'const int n = count_')}`,
			`${lineIn(POOL_SOURCE, 'count_ = 1')}>${lineIn(POOL_SOURCE, 'return count_ > 0')}`,
		].sort());
		const initializer = await own.send('dataflow/member', { file: source, ...placeOf(POOL_SOURCE, 'count_(_count)') });
		assert.equal(initializer.result.member.name, 'count_');

		// jobs_ by the class and the name. the write at the end of the loop reaches the check at its start
		const jobs = await own.send('dataflow/member', { file: source, className: 'demo::WorkerPool', member: 'jobs_' });
		assert.equal(jobs.result.member.name, 'jobs_');
		assert.equal(jobs.result.function, null);
		const jobRef = (marker) => jobs.result.refs.findIndex((r) => r.line === lineIn(POOL_SOURCE, marker) && r.file.endsWith('.cpp'));
		assert.equal(jobs.result.refs[jobRef('if (jobs_.empty())')].role, 'check');
		assert.deepEqual(jobs.result.refs[jobRef('jobs_.push_back')].locks, ['mutex_']);
		assert.equal(jobs.result.refs[jobRef('jobs_.push_back')].role, 'mayWrite');
		assert.ok(jobs.result.edges.some(([a, b]) => a === jobRef('jobs_.pop_front') && b === jobRef('if (jobs_.empty())')),
			JSON.stringify(jobs.result.edges));

		// an atomic member, and a position with no member
		const done = await own.send('dataflow/member', { file: source, ...placeOf(POOL_SOURCE, 'done_ += 1') });
		assert.equal(done.result.member.isAtomic, true);
		const cv = await own.send('dataflow/member', { file: source, className: 'demo::WorkerPool', member: 'cv_' });
		assert.deepEqual([cv.result.member.isSync, cv.result.member.isAtomic], [true, false]);
		assert.deepEqual(done.result.refs.filter((r) => r.fn >= 0).map((r) => [r.role, r.alsoRead]), [['write', true]]);
		const none = await own.send('dataflow/member', { file: source, ...placeOf(POOL_SOURCE, 'job();') });
		assert.deepEqual({ member: none.result.member, error: none.error }, { member: null, error: undefined });

		// the header as the main file: the trace has only the functions in the header
		const inHeader = await own.send('dataflow/member', { file: header, ...placeOf(POOL_HEADER, 'bool isStopping_', 'isStopping_') });
		assert.equal(inHeader.error, undefined, JSON.stringify(inHeader.error));
		assert.deepEqual(summary(inHeader.result), [
			`worker_pool.h:${lineIn(POOL_HEADER, 'bool isStopping_')} def -`,
			`worker_pool.h:${lineIn(POOL_HEADER, 'return isStopping_')} read is_stopping [mutex_]`,
		].sort());
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('traces a global variable and a static data member also in the functions of the headers, after an edit', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-global-'));
	const HEADER = [
		'#pragma once',
		'extern int g_level;',
		'inline void raise_level() { g_level += 1; }',
		'struct Tool { static int s_count; };',
		'inline int count_tools() { return Tool::s_count; }',
		'inline int other() { return 0; }',
		'inline void reset_level() { g_level = 0; }', // 7: no function of the main file calls it
		'inline int more_tools() { return Tool::s_count + 1; }', // 8
	].join('\n') + '\n';
	const SOURCE = [
		'#include "config.h"',
		'int g_level = 0;',
		'int Tool::s_count = 0;',
		'int main() {',
		'  raise_level();',
		'  Tool::s_count = 2;',
		'  return g_level + count_tools() + other();',
		'}',
	].join('\n') + '\n';
	const header = path.join(dir, 'config.h');
	const source = path.join(dir, 'app.cpp');
	writeFileSync(header, HEADER);
	writeFileSync(source, SOURCE);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file: source, arguments: ['clang++', '-std=c++20', `-I${dir}`, '-c', source] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	const summary = (result) => result.refs.map((r) => `${path.basename(r.file)}:${r.line} ${r.role} ${r.fn >= 0 ? result.functions[r.fn].name : '-'}`).sort();
	try {
		assert.equal((await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 })).error, undefined);
		// after an edit, the header is in the preamble. The top-level declarations of the parse also have the declarations
		// of the preamble, so the trace has the functions of the header, also if no function of the main file calls them
		own.notify('textDocument/didOpen', { file: source, text: SOURCE, version: 2 });
		const level = await own.send('dataflow/member', { file: source, ...placeOf(SOURCE, 'return g_level', 'g_level'), asyncFunctions: [], roots: [dir] });
		assert.equal(level.error, undefined, JSON.stringify(level.error));
		assert.ok(level.result.preambleBuilds >= 1, JSON.stringify(level.result.preambleBuilds));
		assert.deepEqual(summary(level.result), [
			'app.cpp:2 def -', 'app.cpp:7 read main', 'config.h:2 def -', 'config.h:3 write raise_level', 'config.h:7 write reset_level',
		].sort());
		const count = await own.send('dataflow/member', { file: source, ...placeOf(SOURCE, 'Tool::s_count = 2', 's_count'), asyncFunctions: [], roots: [dir] });
		assert.deepEqual(summary(count.result), [
			'app.cpp:3 def -', 'app.cpp:6 write main', 'config.h:4 def -', 'config.h:5 read count_tools', 'config.h:8 read more_tools',
		].sort());
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a function that an async lambda calls runs on the thread of the lambda', async () => {
	// the lambda of executor.async on line 95 calls solve_power_plan(), which writes charge.is_dirty on line 76
	const text = readFileSync(fixture, 'utf8');
	const res = await engine.send('dataflow/member', { file: fixture, ...placeOf(text, 'charge.is_dirty = false', 'is_dirty'), asyncFunctions: ['tf::Executor::async'] });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	const { member, refs, functions, threads } = res.result;
	assert.deepEqual([member.qualifiedClass, member.name, member.init], ['charge::State', 'is_dirty', 'false']);
	const at = (line) => refs.find((r) => r.line === line && r.file.endsWith('battery.cpp'));
	const write = functions[at(76).fn];
	assert.deepEqual([at(76).role, at(76).object, write.name], ['write', 'charge', 'solve_power_plan']);
	assert.deepEqual({ ...threads[write.thread], file: undefined }, { via: 'tf::Executor::async', line: 95, isRepeated: false, file: undefined });
	assert.equal(write.threadCall.line, 95);
	const read = functions[at(94).fn];
	assert.deepEqual([at(94).role, read.name, read.thread], ['check', 'process', -1]);
});

// Globals, a static data member, manual locks and a job queue
const STATS_HEADER = `#pragma once

#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace demo2 {

  extern int g_counter;
  extern std::mutex g_mutex;

  class Stats {
   public:
    static int hits_;
    int value_ = 0;
    std::mutex mutex_;
    void add();
    void add_guard();
    void add_both();
  };

  class Queue {
    std::vector<std::thread> workers_;
    std::deque<std::function<void()>> jobs_;
    std::mutex mutex_;

   public:
    explicit Queue(int _n);
    void post(std::function<void()>&& _job);
  };

  void external();

}  // namespace demo2
`;
const STATS_SOURCE = `#include "stats.h"

namespace demo2 {

  int g_counter = 0;
  std::mutex g_mutex;
  int Stats::hits_ = 0;

  void Stats::add() {
    mutex_.lock();
    value_ += 1;
    mutex_.unlock();
    value_ = 0;
  }

  void Stats::add_guard() {
    std::unique_lock lock(mutex_);
    value_ = 2;
    lock.unlock();
    value_ = 3;
  }

  void Stats::add_both() {
    std::lock(mutex_, g_mutex);
    value_ = 4;
    mutex_.unlock();
    g_mutex.unlock();
  }

  Queue::Queue(const int _n) {
    for (int i = 0; i < _n; ++i)
      workers_.emplace_back([this]() {
        std::function<void()> job;
        {
          const std::lock_guard lock(mutex_);
          if (jobs_.empty()) return;
          job = std::move(jobs_.front());
          jobs_.pop_front();
        }
        job();
      });
  }

  void Queue::post(std::function<void()>&& _job) {
    const std::lock_guard lock(mutex_);
    jobs_.push_back(std::move(_job));
  }

  void bump() {
    g_counter += 1;
    Stats::hits_ += 1;
  }

  void run(Queue& _q) {
    _q.post([]() { bump(); });
    bump();
    std::thread t([]() {
      external();
      g_counter = 5;
    });
    t.join();
    g_counter = 6;
  }

}  // namespace demo2
`;

test('traces globals and static members, with manual locks, job queues, runs on more threads and other files', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-statics-'));
	const header = path.join(dir, 'stats.h');
	const source = path.join(dir, 'stats.cpp');
	writeFileSync(header, STATS_HEADER);
	writeFileSync(source, STATS_SOURCE);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file: source, arguments: ['clang++', '-std=c++20', `-I${dir}`, '-c', source] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	const lineIn = (text, marker) => placeOf(text, marker).line;
	const send = async (params) => {
		const res = await own.send('dataflow/member', { file: source, asyncFunctions: [], roots: [dir], ...params });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		return res.result;
	};
	const ref = (result, marker, text = STATS_SOURCE) =>
		result.refs.find((r) => r.line === lineIn(text, marker) && r.file.endsWith(text === STATS_SOURCE ? '.cpp' : '.h'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));

		// a global variable at an access. its scope is its namespace
		const g = await send(placeOf(STATS_SOURCE, 'g_counter += 1', 'g_counter'));
		assert.deepEqual([g.member.kind, g.member.name, g.member.className, g.member.qualifiedClass, g.member.init],
			['global', 'g_counter', '', 'demo2', '0']);
		assert.deepEqual(g.refs.map((r) => `${path.extname(r.file)}:${r.line} ${r.role}`).sort(), [
			`.h:${lineIn(STATS_HEADER, 'extern int g_counter')} def`,
			`.cpp:${lineIn(STATS_SOURCE, 'int g_counter = 0')} def`,
			`.cpp:${lineIn(STATS_SOURCE, 'g_counter += 1')} write`,
			`.cpp:${lineIn(STATS_SOURCE, 'g_counter = 5')} write`,
			`.cpp:${lineIn(STATS_SOURCE, 'g_counter = 6')} write`,
		].sort());

		// a job queue starts a thread: post() keeps the callable, and the worker threads of the loop run it
		const queue = g.threads.findIndex((t) => t.via === 'demo2::Queue::post');
		assert.ok(queue >= 0, JSON.stringify(g.threads));
		assert.equal(g.threads[queue].isRepeated, true);
		assert.equal(g.threads[queue].line, lineIn(STATS_SOURCE, '_q.post('));

		// bump() runs on a worker of the queue and on the caller thread: one run for each
		const viaOf = (run) => (run.thread < 0 ? 'caller' : g.threads[run.thread].via);
		assert.deepEqual(ref(g, 'g_counter += 1').runs.map(viaOf).sort(), ['caller', 'demo2::Queue::post']);

		// the write after t.join() is in sequence with the thread of t. the thread calls a function of a different file
		const thread = g.threads.findIndex((t) => t.via === 'std::thread' && t.line === lineIn(STATS_SOURCE, 'std::thread t('));
		assert.ok(thread >= 0, JSON.stringify(g.threads));
		assert.deepEqual(ref(g, 'g_counter = 6').runs, [{ thread: -1, ordered: [thread] }]);
		assert.deepEqual(g.threads[thread].calls, ['demo2::external']);

		// the same global by its scope and name, with a thread of a different source file that calls bump()
		const entry = { function: 'demo2::bump', via: 'std::thread', file: 'C:/elsewhere/main.cpp', line: 7, isRepeated: false };
		const entered = await send({ className: 'demo2', member: 'g_counter', entries: [entry] });
		const bumpFn = entered.functions[ref(entered, 'g_counter += 1').fn];
		assert.deepEqual({ ...entered.threads[bumpFn.thread], calls: undefined },
			{ via: 'std::thread', file: 'C:/elsewhere/main.cpp', line: 7, isRepeated: false, calls: undefined });

		// a static data member: the declaration in the class, the definition, and the write
		const hits = await send({ className: 'demo2::Stats', member: 'hits_' });
		assert.deepEqual([hits.member.kind, hits.member.className], ['static', 'Stats']);
		assert.deepEqual(hits.refs.map((r) => `${path.extname(r.file)}:${r.line} ${r.role}`).sort(), [
			`.h:${lineIn(STATS_HEADER, 'static int hits_')} def`,
			`.cpp:${lineIn(STATS_SOURCE, 'int Stats::hits_ = 0')} def`,
			`.cpp:${lineIn(STATS_SOURCE, 'Stats::hits_ += 1')} write`,
		].sort());
		assert.ok(hits.fields.some((f) => f.name === 'hits_') && hits.fields.some((f) => f.name === 'value_'));

		// manual locks: lock() and unlock() of a mutex and of a guard, and std::lock
		const value = await send({ className: 'demo2::Stats', member: 'value_' });
		const locks = (marker) => ref(value, marker).locks ?? [];
		assert.deepEqual(locks('value_ += 1'), ['mutex_']);
		assert.deepEqual(locks('value_ = 0'), []);
		assert.deepEqual(locks('value_ = 2'), ['mutex_']);
		assert.deepEqual(locks('value_ = 3'), []);
		assert.deepEqual(locks('value_ = 4'), ['g_mutex', 'mutex_']);

		// an edit of the header in the editor: the next request parses again, and the lines of the header move
		own.notify('textDocument/didOpen', { file: header, text: `\n${STATS_HEADER}`, version: 2 });
		const edited = await send({ className: 'demo2::Stats', member: 'hits_' });
		assert.equal(edited.parsed, true);
		assert.ok(edited.refs.some((r) => r.file.endsWith('.h') && r.line === lineIn(STATS_HEADER, 'static int hits_') + 1));
		own.notify('textDocument/didClose', { file: header });
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('gives the include hierarchy of a file: entered, skipped, forced and missing includes, groups and uses', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-includes-'));
	const write = (name, lines) => {
		const file = path.join(dir, name);
		writeFileSync(file, lines.join('\n') + '\n');
		return file;
	};
	write('app.h', ['#pragma once', '#include "base.h"', 'int app_main();']);
	write('base.h', ['#pragma once', 'struct Base { int x = 1; };']);
	write('util.h', ['#pragma once', '#include "base.h"', 'inline int helper(const Base& b) { return b.x; }']);
	write('unused.h', ['#pragma once', 'struct Unused {};']);
	write('macros.h', ['#pragma once', '#define APP_VALUE 42']);
	write('fwd.h', ['#include "base.h"']);
	const force = write('force.h', ['#pragma once', '#define FORCED 1']);
	const app = write('app.cpp', [
		'#include "app.h"',
		'#include "util.h"',
		'#include "base.h"',
		'#include "unused.h"',
		'#include "macros.h"',
		'#include "fwd.h"',
		'#include <vector>',
		'',
		'int app_main() {',
		'  Base b;',
		'  std::vector<int> v{APP_VALUE};',
		'  return helper(b) + int(v.size());',
		'}',
	]);
	const broken = write('broken.cpp', ['#include "missing.h"', 'int x;']);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([
		{ directory: dir, file: app, arguments: ['clang++', '-std=c++20', '-include', force, '-c', app] },
		{ directory: dir, file: broken, arguments: ['clang++', '-std=c++20', '-c', broken] },
	]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/includes', { file: app, roots: [dir] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		const { files, nodes } = res.result;
		const name = (n) => (n.file >= 0 ? path.basename(files[n.file].path) : n.spelled);
		assert.deepEqual([nodes[0].state, nodes[0].parent, name(nodes[0])], ['main', -1, 'app.cpp']);
		assert.equal(files[nodes[0].file].lines, 13);

		// the includes of the main file, in the sequence of the preprocessor. -include comes first, with line 0
		const top = nodes.filter((n) => n.parent === 0);
		assert.deepEqual(top.map((n) => `${n.line} ${name(n)} ${n.state}${n.isOwn ? ' own' : ''}${n.isUsed === undefined ? '' : n.isUsed ? ' used' : ' unused'}`), [
			'0 force.h entered unused',
			'1 app.h entered own used',
			'2 util.h entered used',
			'3 base.h skipped',
			'4 unused.h entered unused',
			'5 macros.h entered used',
			'6 fwd.h entered used',
			'7 vector entered used',
		]);
		assert.deepEqual(top.map((n) => n.spelled).slice(1, 3), ['"app.h"', '"util.h"']);
		// the use of each include: the name, the line and the file of the name. fwd.h only forwards to base.h, so its use
		// is Base of base.h, which came in through app.h
		const useOf = (file) => {
			const { use } = top.find((n) => name(n) === file);
			return `${use.name} ${use.line} ${name(nodes[use.node])}`;
		};
		assert.deepEqual(['macros.h', 'util.h', 'fwd.h', 'vector'].map(useOf),
			['APP_VALUE 11 macros.h', 'helper 12 util.h', 'Base 10 base.h', 'std::vector 11 vector']);

		// base.h came in through app.h. Both later includes of it skip it
		const baseNodes = nodes.map((n, i) => [n, i]).filter(([n]) => name(n) === 'base.h');
		const [entered, enteredAt] = baseNodes.find(([n]) => n.state === 'entered');
		assert.equal(name(nodes[entered.parent]), 'app.h');
		assert.deepEqual(baseNodes.filter(([n]) => n.state === 'skipped').map(([n]) => [name(nodes[n.parent]), n.first]),
			[['util.h', enteredAt], ['app.cpp', enteredAt], ['fwd.h', enteredAt]]);
		assert.equal(files[entered.file].lines, 2);

		// the groups: the project folder, and the standard library of the compiler
		const group = (file) => files.find((f) => path.basename(f.path) === file).group;
		assert.deepEqual([group('app.cpp'), group('app.h'), group('vector')], ['this file', 'project headers', 'C++ standard library']);
		assert.equal(files.find((f) => path.basename(f.path) === 'vector').isSystem, true);

		// the second request uses the result of the same parse
		const again = await own.send('dataflow/includes', { file: app, roots: [dir] });
		assert.equal(again.result.cached, true);
		assert.equal(res.result.passReused, false);

		// an edit of the body uses the pass of the preprocessor again. The uses come from the new text: APP_VALUE moves
		// down by one line. A name in a skipped block or in a #define is no use
		const appText = readFileSync(app, 'utf8');
		const macrosUse = (r) => {
			const node = r.result.nodes.find((n) => n.parent === 0 && n.file >= 0 && path.basename(r.result.files[n.file].path) === 'macros.h');
			return [node.isUsed, node.use && { name: node.use.name, line: node.use.line }];
		};
		own.notify('textDocument/didOpen', { file: app, text: appText.replace('int app_main() {\n', 'int app_main() {\n\n'), version: 2 });
		const edited = await own.send('dataflow/includes', { file: app, roots: [dir] });
		assert.deepEqual([edited.result.passReused, edited.result.preprocessMs, ...macrosUse(edited)], [true, 0, true, { name: 'APP_VALUE', line: 12 }]);
		const unusedText = appText.replace('  std::vector<int> v{APP_VALUE};\n', '  std::vector<int> v{1};\n#if 0\n  APP_VALUE;\n#endif\n#define OTHER APP_VALUE\n');
		own.notify('textDocument/didChange', { file: app, version: 3, text: unusedText });
		const unusedMacro = await own.send('dataflow/includes', { file: app, roots: [dir] });
		assert.deepEqual([unusedMacro.result.passReused, ...macrosUse(unusedMacro)], [false, false, undefined]);

		// the lines that #if 0 skips are inactive. The directives themselves are not
		const inactive = await own.send('dataflow/inactive', { file: app });
		assert.equal(inactive.error, undefined, JSON.stringify(inactive.error));
		assert.deepEqual(inactive.result.ranges, [[13, 13]]);
		assert.deepEqual((await own.send('dataflow/inactive', { file: broken })).result.ranges, []);

		// in a chain of #ifdef, #elif and #else, only the branch that the preprocessor takes is active. The condition of the
		// #elif that the preprocessor takes is a use of its macro. A backslash continues a directive. The chain starts on line 18
		const chain = `${unusedText}#ifdef NOT_DEFINED\nint a;\nint b;\n#elif APP_VALUE\nint c;\n#else\nint d;\n#endif\n` +
			'#if defined(NOT_DEFINED) \\\n    && 1\nint e;\n#endif\n';
		own.notify('textDocument/didChange', { file: app, version: 4, text: chain });
		assert.deepEqual(macrosUse(await own.send('dataflow/includes', { file: app, roots: [dir] })), [true, { name: 'APP_VALUE', line: 21 }]);
		assert.deepEqual((await own.send('dataflow/inactive', { file: app })).result.ranges, [[13, 13], [19, 20], [24, 24], [28, 28]]);

		// a new directive needs a new pass
		own.notify('textDocument/didChange', { file: app, text: `#define LOCAL 1\n${appText}`, version: 5 });
		const directive = await own.send('dataflow/includes', { file: app, roots: [dir] });
		assert.deepEqual([directive.result.passReused, ...macrosUse(directive)], [false, true, { name: 'APP_VALUE', line: 12 }]);
		own.notify('textDocument/didClose', { file: app });

		// a file that the preprocessor does not find
		const missing = await own.send('dataflow/includes', { file: broken, roots: [dir] });
		assert.equal(missing.error, undefined, JSON.stringify(missing.error));
		assert.deepEqual(missing.result.nodes.slice(1).map((n) => [n.state, n.file, n.line, n.spelled]), [['missing', -1, 1, '"missing.h"']]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('includers: the translation units of the compile database that include a file, from the dependency scanner', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-includers-'));
	const write = (name, lines) => {
		const file = path.join(dir, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, lines.join('\n') + '\n');
		return file;
	};
	const common = write('include/common.h', ['#pragma once', 'int common();']);
	const x = write('include/x.h', ['#pragma once', '#include "common.h"', 'int x();']);
	write('src/other.h', ['#pragma once', 'int other();']);
	const units = [
		write('src/a.cpp', ['#include <common.h>', 'int a() { return common(); }']),
		write('src/b.cpp', ['#include "x.h"', 'int b() { return x(); }']),
		write('src/c.cpp', ['#include "other.h"', 'int c() { return other(); }']),
		write('src/d.cpp', ['#if 0', '#include "common.h"', '#endif', 'int d() { return 0; }']),
		write('src/e.cpp', ['#include "common.h"', '#include "missing.h"', 'int e() { return 0; }']),
	];
	const db = path.join(dir, 'compile_commands.json');
	const include = path.join(dir, 'include');
	writeFileSync(db, JSON.stringify(units.map((file) => ({ directory: dir, file, arguments: ['clang++', '-std=c++20', `-I${include}`, '-c', file] }))));
	// two threads: the scan also runs on the second thread of the pool
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 2, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const includers = async (file) => {
			const res = await own.send('dataflow/includers', { file, roots: [dir] });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			const r = res.result;
			return { units: r.units.map((u) => path.basename(u)), unitCount: r.unitCount, failed: r.failed, isUnit: r.isUnit, scanned: r.scanned };
		};

		// the include folder of the command finds common.h for <common.h> and "x.h". The header in #if 0 does not count, and
		// e.cpp includes common.h before a header that is missing. The first request scans, the next ones use the index
		assert.deepEqual(await includers(common), { units: ['a.cpp', 'b.cpp', 'e.cpp'], unitCount: 5, failed: [], isUnit: false, scanned: true });
		assert.deepEqual(await includers(x), { units: ['b.cpp'], unitCount: 5, failed: [], isUnit: false, scanned: false });
		assert.deepEqual(await includers(units[0]), { units: [], unitCount: 5, failed: [], isUnit: true, scanned: false });

		// a change of a file on disk makes the next request scan again
		write('src/c.cpp', ['#include "other.h"', '#include "common.h"', 'int c() { return other() + common(); }']);
		assert.deepEqual(await includers(common), { units: ['a.cpp', 'b.cpp', 'c.cpp', 'e.cpp'], unitCount: 5, failed: [], isUnit: false, scanned: true });

		// the scan reads the unsaved text of an open file. A change of a directive scans again, a change of the code does not
		const withD = ['a.cpp', 'b.cpp', 'c.cpp', 'd.cpp', 'e.cpp'];
		const without = ['a.cpp', 'b.cpp', 'c.cpp', 'e.cpp'];
		const units_ = async () => {
			const r = await includers(common);
			return [r.units, r.scanned];
		};
		own.notify('textDocument/didOpen', { file: units[3], text: '#include "common.h"\nint d() { return common(); }\n', version: 1 });
		assert.deepEqual(await units_(), [withD, true]);
		own.notify('textDocument/didChange', { file: units[3], text: '#include "common.h"\nint d() { return common() + 1; }\n', version: 2 });
		assert.deepEqual(await units_(), [withD, false]);
		own.notify('textDocument/didChange', { file: units[3], text: '#if 0\n#include "common.h"\n#endif\nint d() { return 0; }\n', version: 3 });
		assert.deepEqual(await units_(), [without, true]);
		own.notify('textDocument/didOpen', { file: units[3], text: '#include "common.h"\nint d() { return common(); }\n', version: 4 });
		assert.deepEqual(await units_(), [withD, true]);
		own.notify('textDocument/didClose', { file: units[3] });
		assert.deepEqual(await units_(), [without, true]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('includes: of two includes that bring in the same used header, one is used', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-shared-'));
	const write = (name, lines) => {
		const file = path.join(dir, name);
		writeFileSync(file, lines.join('\n') + '\n');
		return file;
	};
	write('shared.h', ['#pragma once', 'struct Shared { int s = 1; };']);
	write('left.h', ['#pragma once', '#include "shared.h"', 'struct Left {};']);
	write('right.h', ['#pragma once', '#include "shared.h"', 'struct Right {};']);
	write('common.h', ['#pragma once', 'struct Common { int c = 2; };']);
	write('bonly.h', ['#pragma once', 'struct BOnly { int o = 3; };']);
	write('a.h', ['#pragma once', '#include "common.h"', 'struct A {};']);
	write('b.h', ['#pragma once', '#include "common.h"', '#include "bonly.h"', 'struct B {};']);
	const main = write('main.cpp', [
		'#include "left.h"',
		'#include "right.h"',
		'#include "a.h"',
		'#include "b.h"',
		'',
		'int main() {',
		'  Shared s;',
		'  Common c;',
		'  BOnly o;',
		'  return s.s + c.c + o.o;',
		'}',
	]);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file: main, arguments: ['clang++', '-std=c++20', '-c', main] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/includes', { file: main, roots: [dir] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		const { files, nodes } = res.result;
		const name = (n) => path.basename(files[n.file].path);
		const top = nodes.filter((n) => n.parent === 0);

		// left.h and right.h bring in shared.h, and only the first of them is used. Only b.h brings in bonly.h, so b.h is
		// used, and it also brings in common.h: a.h is not necessary for Common
		assert.deepEqual(top.map((n) => `${n.line} ${name(n)} ${n.isUsed ? 'used' : 'unused'}`), [
			'1 left.h used', '2 right.h unused', '3 a.h unused', '4 b.h used',
		]);
		assert.deepEqual(top.filter((n) => n.isUsed).map((n) => `${n.use.name} ${n.use.line} ${name(nodes[n.use.node])}`), [
			'Shared 7 shared.h', 'BOnly 9 bonly.h',
		]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('includes: a used name belongs to its header, to the headers that export it and to the public header of the standard library', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-unused-'));
	const write = (name, lines) => {
		const file = path.join(dir, name);
		writeFileSync(file, lines.join('\n') + '\n');
		return file;
	};
	write('base.h', ['#pragma once', 'struct Base { int x = 1; };']);
	write('wrap.h', ['#pragma once', '#include "base.h"', 'struct Wrap { Base b; };']);
	write('deep.h', ['#pragma once', 'struct Deep { int d = 3; };']);
	write('only.h', ['#pragma once', '#include "deep.h"', 'struct Only {};']);
	write('impl.h', ['#pragma once', 'struct Impl { int y = 2; };']);
	write('facade.h', ['#pragma once', '#include "impl.h" // IWYU pragma: export', 'inline int facade_version() { return 1; }']);
	write('part.h', ['#pragma once', 'struct Part {};']);
	write('other.h', ['#pragma once', 'struct Other {};']);
	write('block.h', ['#pragma once', '// IWYU pragma: begin_exports', '#include "part.h"', '// IWYU pragma: end_exports', 'struct Block {};']);
	write('after.h', ['#pragma once', '// IWYU pragma: begin_exports', '// IWYU pragma: end_exports', '#include "other.h"', 'struct After {};']);
	// a header with no code: an include guard, a directive on two lines, comments and a byte order mark
	write('guard.h', ['﻿// forwards to base.h', '#ifndef GUARD_H', '#define GUARD_H \\', '    1', '/* the target */', '#include "base.h"', '#endif']);
	write('kept.h', ['#pragma once', 'struct Kept {};']);
	// an X macro file: code and no include guard
	write('list.h', ['#ifndef ITEM', '#define ITEM(x)', '#endif', 'ITEM(first)', 'ITEM(second)', '#undef ITEM']);
	const main = write('main.cpp', [
		'#include "wrap.h"',
		'#include "base.h"',
		'#include "only.h"',
		'#include "impl.h"',
		'#include "facade.h"',
		'#include "block.h"',
		'#include "part.h"',
		'#include "after.h"',
		'#include "other.h"',
		'#include "guard.h"',
		'#include "kept.h" // IWYU pragma: keep',
		'#include "list.h"',
		'#include <cstdint>',
		'#include <string>',
		'#include <stdexcept>',
		'',
		'int count() {',
		'  int n = 0;',
		'#define ITEM(x) ++n;',
		'#include "list.h"',
		'  return n;',
		'}',
		'',
		'int main() {',
		'  Base b;',
		'  Deep d;',
		'  Impl i;',
		'  Part p;',
		'  Other o;',
		'  std::string s = "x";',
		'  return b.x + d.d + i.y + count() + int(s.size() + sizeof(p) + sizeof(o)) + (INT32_MAX > 0 ? 0 : 1);',
		'}',
	]);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file: main, arguments: ['clang++', '-std=c++20', '-c', main] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const request = async () => {
			const res = await own.send('dataflow/includes', { file: main, roots: [dir] });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
			const { files, nodes } = res.result;
			const name = (n) => (n.file >= 0 ? path.basename(files[n.file].path) : n.spelled);
			const top = nodes.filter((n) => n.parent === 0);
			return {
				states: top.map((n) => `${n.line} ${name(n)} ${n.state}${n.isUsed === undefined ? '' : n.isUsed ? ' used' : ' unused'}`),
				useOf: (file) => {
					const { use } = top.find((n) => name(n) === file);
					return use && `${use.name} ${use.line} ${name(nodes[use.node])}`;
				},
			};
		};

		// wrap.h brings in base.h, but the file uses only Base, and the file also includes base.h: wrap.h is possibly
		// unused. Only only.h brings in deep.h, so the file needs only.h. The export pragmas give impl.h to facade.h and
		// part.h to block.h, but not other.h to after.h. guard.h gives no tokens, so it gives base.h. kept.h has a keep
		// pragma, so it gets no check. list.h has no include guard. In count() it gives code, so it gets no check there.
		// On line 12 its macro gives no tokens, so the check applies, and the file uses nothing of it. std::string belongs
		// to <string> and the macro INT32_MAX to <cstdint>, also if a different header declares them
		const res = await request();
		assert.deepEqual(res.states, [
			'1 wrap.h entered unused',
			'2 base.h skipped',
			'3 only.h entered used',
			'4 impl.h entered used',
			'5 facade.h entered used',
			'6 block.h entered used',
			'7 part.h skipped',
			'8 after.h entered unused',
			'9 other.h skipped',
			'10 guard.h entered used',
			'11 kept.h entered',
			'12 list.h entered unused',
			'13 cstdint entered used',
			'14 string entered used',
			'15 stdexcept entered unused',
			'20 list.h entered',
		]);
		assert.deepEqual(['only.h', 'impl.h', 'facade.h', 'block.h', 'guard.h', 'cstdint', 'string'].map(res.useOf), [
			'Deep 26 deep.h', 'Impl 27 impl.h', 'Impl 27 impl.h', 'Part 28 part.h', 'Base 25 base.h', 'INT32_MAX 31 cstdint',
			'std::string 30 string',
		]);

		// the unsaved text of an open header gives its exports: an export pragma in wrap.h gives it base.h
		const wrap = path.join(dir, 'wrap.h');
		own.notify('textDocument/didOpen', { file: wrap, text: '#pragma once\n#include "base.h" // IWYU pragma: export\nstruct Wrap { Base b; };\n', version: 1 });
		const open = await request();
		assert.equal(open.states[0], '1 wrap.h entered used');
		assert.equal(open.useOf('wrap.h'), 'Base 25 base.h');
		own.notify('textDocument/didClose', { file: wrap });
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('threads: a join in a called function puts its later accesses in sequence with the thread, with the objects of the caller', async () => {
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length;
	const extra = [
		'#include <thread>', // +0
		'struct DfTask2 {',
		'  std::thread thread_;',
		'  int value_ = 0;',
		'  ~DfTask2() {',
		'    if (thread_.joinable()) thread_.join();', // +5
		'    value_ = 0;',
		'  }',
		'};',
		'void df_go2(DfTask2& _t) { _t.thread_ = std::thread([&_t]() { _t.value_ = 5; }); }',
		'void df_stop2(DfTask2& _s) {', // +10
		'  _s.thread_.join();',
		'  _s.value_ = 9;',
		'}',
		'void df_local2() {',
		'  DfTask2 a;', // +15
		'  df_go2(a);',
		'  a.value_ = 1;',
		'  df_stop2(a);',
		'  a.value_ = 2;',
		'}', // +20
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 15 });
	try {
		const root = path.join(repo, 'test/fixtures/battery');
		const res = await engine.send('dataflow/threads', { file: fixture, asyncFunctions: ['tf::Executor::async'], roots: [root] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		const { threads, items } = res.result;
		const t = threads.findIndex((x) => x.at?.line === first + 9);
		assert.ok(t >= 0, JSON.stringify(threads));
		const value = items.find((i) => i.label === 'a.value_');
		assert.ok(value, JSON.stringify(items.map((i) => i.label)));

		// df_go2 starts the thread through _t, and df_stop2 and the destructor join it through _s and this. Only in the
		// terms of df_local2 are these the same object. The writes after the joins are in sequence with the thread, the
		// write before df_stop2 is a race
		assert.deepEqual(value.refs.map((r) => [r.line - first, r.thread, r.order.after ?? []]),
			[[6, -1, [t]], [9, t, []], [12, -1, [t]], [17, -1, []], [19, -1, [t]]]);
	} finally {
		engine.notify('textDocument/didClose', { file: fixture });
	}
});

test('an included file gets the lines of its source file before the #include, and a header gets the instantiations of a unit', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-context-'));
	const write = (name, lines) => {
		const file = path.join(dir, name);
		writeFileSync(file, lines.join('\n') + '\n');
		return file;
	};
	write('limits.h', ['struct DfLimits { int max_ = 3; };']);
	const part = write('part.inc', [
		'int df_clamp(int value) {',
		'  DfLimits limits;',
		'  return value > limits.max_ ? limits.max_ : value;',
		'}',
	]);
	const header = write('twice.hpp', [
		'#include <string>',
		'template <class T> T df_twice(T v) {',
		'  T copy = v;',
		'  return copy + copy;',
		'}',
	]);
	const unity = write('unity.cpp', [
		'#include "limits.h"',
		'#include "part.inc"',
		'#include "twice.hpp"',
		'int main() { return df_clamp(5) + int(df_twice(std::string("a")).size()); }',
	]);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file: unity, arguments: ['clang++', '-std=c++20', '-c', unity] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 4 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));

		// alone, part.inc does not know DfLimits. after the lines of unity.cpp before the #include, it does
		const alone = await own.send('dataflow/functions', { file: part });
		assert.ok(alone.result.errorCount > 0, JSON.stringify(alone.result));
		own.notify('dataflow/context', { file: part, unit: unity, line: 2 });
		const inUnit = await own.send('dataflow/functions', { file: part });
		assert.equal(inUnit.result.errorCount, 0, inUnit.result.errors.join('\n'));
		assert.deepEqual(inUnit.result.functions.map((f) => [f.name, f.range.begin.line]), [['df_clamp', 1]]);
		own.notify('dataflow/context', { file: part });
		assert.ok((await own.send('dataflow/functions', { file: part })).result.errorCount > 0);

		// the header alone has no instantiation of df_twice. in the unit, the instantiation for std::string gives items at
		// the lines of the template
		const fromInstantiation = (res) => res.result.items.filter((i) => i.detail.includes('This item comes from'));
		const headerAlone = await own.send('dataflow/cost', { file: header, minCopyBytes: 16 });
		assert.equal(headerAlone.error, undefined, JSON.stringify(headerAlone.error));
		assert.deepEqual(fromInstantiation(headerAlone), []);
		const headerInUnit = await own.send('dataflow/cost', { file: header, unit: unity, minCopyBytes: 16 });
		assert.equal(headerInUnit.error, undefined, JSON.stringify(headerInUnit.error));
		assert.deepEqual(headerInUnit.result.functions.map((f) => f.name), ['df_twice']);
		const items = fromInstantiation(headerInUnit);
		assert.ok(items.length > 0 && items.every((i) => i.line >= 2 && i.line <= 5 && i.detail.includes('df_twice<std::string>')),
			JSON.stringify(headerInUnit.result.items));
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('gives the call graph of a file: events, async calls, written arguments, results and optional checks', async () => {
	const root = path.join(repo, 'test/fixtures/battery');
	const res = await engine.send('dataflow/calls', {
		file: fixture, eventFunctions: ['fire_transition'], asyncFunctions: ['tf::Executor::async'], roots: [root],
	});
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	const { functions, calls } = res.result;
	const fn = (name) => functions.findIndex((f) => f.qualifiedName === name);
	const process = fn('electricity::power_ctrl::process');
	const solve = fn('electricity::power_ctrl::solve_power_plan');
	const init = fn('electricity::power_ctrl::initial_power');
	assert.ok(process >= 0 && solve >= 0 && init >= 0, JSON.stringify(functions.map((f) => f.qualifiedName)));
	assert.deepEqual([functions[process].where, functions[process].isDefined, functions[process].range.begin], ['main', true, 85]);
	const between = (from, to) => calls.filter((c) => c.from === from && c.to === to);

	// ten events, each with the state as a written argument
	const events = between(process, fn('electricity::power_ctrl::fire_transition'));
	assert.equal(events.length, 10);
	assert.ok(events.every((c) => c.event && c.writes?.includes('home_battery_ctl') && c.result === 'none'), JSON.stringify(events[0]));
	assert.equal(functions[events[0].to].where, 'project');

	// the lambda of executor.async runs solve_power_plan() on a different thread, and returns its result
	assert.deepEqual(between(process, solve).map((c) => [c.line, c.async, c.inLambda, c.result]), [[95, 'tf::Executor::async', true, 'returned']]);

	// the optional of best_preset() has an access with no check on line 46. The optional of initial_power() has a check
	assert.deepEqual(between(init, fn('electricity::power_ctrl::best_preset')).map((c) => [c.line, c.into, c.optional, c.uncheckedLine]),
		[[41, 'bestFit', 'unchecked', 46]]);
	assert.deepEqual(between(solve, init).map((c) => [c.line, c.into, c.optional]), [[63, 'kw', 'checked']]);

	// a call of the standard library is a library call
	const abs = calls.find((c) => c.from === solve && functions[c.to].name === 'abs');
	assert.equal(functions[abs.to].where, 'library');

	// the second request uses the graph of the same parse
	const again = await engine.send('dataflow/calls', {
		file: fixture, eventFunctions: ['fire_transition'], asyncFunctions: ['tf::Executor::async'], roots: [root],
	});
	assert.equal(again.result.cached, true);
});

test('a virtual call also goes to the overrides in the classes of its object', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-virtual-'));
	const file = path.join(dir, 'shapes.cpp');
	writeFileSync(file, [
		'struct Shape { virtual ~Shape() = default; virtual double area() const = 0; virtual int sides() const { return 0; } };',
		'struct Square : Shape { double area() const override { return 1; } int sides() const override { return 4; } };',
		'struct Tile final : Square { double area() const override { return 2; } };',
		'struct Circle : Shape { double area() const override { return 3; } };',
		'struct Plain : Shape { double area() const override { return 0; } };',
		'double total(const Shape& s, const Square& q, const Tile& t, const Plain& p) {',
		'  double a = s.area();', // 7: Shape::area and all overrides
		'  a += q.area();', // 8: Square::area and Tile::area, not Circle::area
		'  a += t.area();', // 9: Tile is final
		'  a += q.Square::sides();', // 10: a qualifier names one function
		'  return a + p.sides();', // 11: Plain has no override of sides, and Square is no class of a Plain
		'}',
	].join('\n') + '\n');
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		assert.equal((await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 })).error, undefined);
		const res = await own.send('dataflow/calls', { file, eventFunctions: [], asyncFunctions: [], roots: [dir] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		const { functions, calls } = res.result;
		const name = (i) => functions[i].qualifiedName;
		// the functions that the calls of a line can run. An override has the function that the call names. The direct
		// overrides come first, then the overrides of the overrides
		const at = (line) => calls.filter((c) => c.line === line).map((c) => `${name(c.to)}${c.virtualOf !== undefined ? ` for ${name(c.virtualOf)}` : ''}`);
		assert.deepEqual(at(7), ['Shape::area', 'Square::area for Shape::area', 'Circle::area for Shape::area', 'Plain::area for Shape::area',
			'Tile::area for Shape::area']);
		assert.deepEqual(at(8), ['Square::area', 'Tile::area for Square::area']);
		assert.deepEqual([at(9), at(10), at(11)], [['Tile::area'], ['Square::sides'], ['Shape::sides']]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('gives the threads and the shared data of a file: starts, joins, locks, order and conditions', async () => {
	const root = path.join(repo, 'test/fixtures/battery');
	const res = await engine.send('dataflow/threads', { file: fixture, asyncFunctions: ['tf::Executor::async'], roots: [root] });
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	const { threads, items, captures, functions } = res.result;
	const fnName = (i) => functions[i]?.name;

	// the lambda of executor.async runs on a new thread. Its future goes into charging_future, and get() on line 102 joins it
	assert.equal(threads.length, 1, JSON.stringify(threads));
	assert.deepEqual([threads[0].via, threads[0].at.line, threads[0].handle, threads[0].isRepeated, threads[0].isJoined],
		['tf::Executor::async', 95, 'home_battery_ctl.charging_future', false, false]);
	assert.deepEqual(threads[0].joins.map((j) => [j.kind, j.line, fnName(j.fn)]), [['get', 102, 'process']]);
	// solve_power_plan() runs on the thread, because the lambda calls it
	assert.ok(functions.some((f) => f.name === 'solve_power_plan' && f.threads.includes(0)), JSON.stringify(functions));

	// charge.is_dirty: the thread reads it on line 61 and writes it on line 76. process() reads it on line 94 with no lock
	// and no order. A swap of the two conditions checks the handle first
	const item = (label) => items.find((i) => i.label === label);
	const is_dirty = item('charge.is_dirty');
	assert.ok(is_dirty, JSON.stringify(items.map((i) => i.label)));
	const ref = (it, line) => it.refs.find((r) => r.line === line);
	assert.deepEqual([ref(is_dirty, 61).thread, ref(is_dirty, 61).role, ref(is_dirty, 76).role], [0, 'check', 'write']);
	const read = ref(is_dirty, 94);
	assert.deepEqual([read.thread, read.locks, read.order, read.guards], [-1, [], {}, []]);
	assert.deepEqual(read.swap, { thread: 0, from: 'charge.is_dirty && !home_battery_ctl.charging_future', to: '!home_battery_ctl.charging_future && charge.is_dirty' });

	// charge.optimizers: the worker uses it through a reference into the map, also in the functions that it calls. The call
	// on line 116 gets the whole object after get(). The call on line 129 has the conditions of its branches
	const optimizers = item('charge.optimizers');
	assert.deepEqual([ref(optimizers, 65).path, ref(optimizers, 65).role, ref(optimizers, 65).thread], ['charge.optimizers[].schedule.kw', 'write', 0]);
	const after = ref(optimizers, 116);
	assert.deepEqual([after.whole, after.order.after, after.order.ready], [true, [0], [0]]);
	const branch = ref(optimizers, 129);
	assert.deepEqual([branch.whole, branch.order, branch.guards.slice(0, 3).map((g) => g.text)],
		[true, {}, ['home_battery_ctl.operational_mode == POWER_AUTO', '!home_battery_ctl.is_charging_underway', 'home_battery_ctl.state == HOMEPOWER_CHARGE_ACTIVE']]);

	// a static variable of one thread, and the variable that the thread captures by reference
	assert.deepEqual([item('last_read').kind, [...new Set(item('last_read').refs.map((r) => r.thread))]], ['static', [-1]]);
	assert.deepEqual(captures.map((c) => [c.thread, fnName(c.fn), c.vars.map((v) => [v.name, v.kind])]), [[0, 'process', [['charge', 'reference']]]]);

	// the threads of a pool: a loop starts them, and destroy() joins them in a loop. Each access holds mutex_. The mutex and
	// the condition variable are not shared data
	const pool = await engine.send('dataflow/threads', { file: path.join(root, 'src/worker_pool.cpp'), asyncFunctions: [], roots: [root] });
	assert.equal(pool.error, undefined, JSON.stringify(pool.error));
	assert.deepEqual(pool.result.threads.map((t) => [t.via, t.handle, t.isRepeated, t.joins.map((j) => [j.kind, j.line])]),
		[['std::thread', 'threads_', true, [['join', 39]]]]);
	assert.deepEqual(pool.result.items.map((i) => i.label), ['jobs_', 'isStopping_']);
	assert.ok(pool.result.items.every((i) => i.refs.every((r) => r.locks.includes('mutex_'))), JSON.stringify(pool.result.items));

	// the second request uses the result of the same parse
	const again = await engine.send('dataflow/threads', { file: fixture, asyncFunctions: ['tf::Executor::async'], roots: [root] });
	assert.equal(again.result.cached, true);
});

test('threads: a call of a function that joins is a join, also through a different parameter for the same object', async () => {
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length;
	const extra = [
		'#include <thread>', // +0
		'struct DfWorker {',
		'  std::thread thread_;',
		'  int data_ = 0;',
		'};',
		'void df_start(DfWorker& w) { w.thread_ = std::thread([&w]() { w.data_++; }); }', // +5
		'void df_stop(DfWorker& _w) {',
		'  if (_w.thread_.joinable()) _w.thread_.join();',
		'}',
		'DfWorker df_worker;',
		'void df_run() {', // +10
		'  df_start(df_worker);',
		'  df_worker.data_ = 1;',
		'  df_stop(df_worker);',
		'  df_worker.data_ = 2;',
		'}', // +15
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 13 });
	try {
		const root = path.join(repo, 'test/fixtures/battery');
		const res = await engine.send('dataflow/threads', { file: fixture, asyncFunctions: ['tf::Executor::async'], roots: [root] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		const { threads, items, functions } = res.result;

		// the start in df_start and the join in df_stop have two different parameters. in df_run, both get df_worker, so
		// the call of df_stop joins the thread
		const t = threads.findIndex((x) => x.at.line === first + 5);
		assert.ok(t >= 0, JSON.stringify(threads));
		assert.deepEqual(threads[t].joins.map((j) => [j.kind, j.line - first, functions[j.fn]?.name]), [['join', 13, 'df_run']]);

		// the write before the join is a race with the thread. the write after the join is in sequence with it
		const data = items.find((i) => i.label === 'df_worker.data_');
		assert.ok(data, JSON.stringify(items.map((i) => i.label)));
		const at = (offset) => data.refs.find((r) => r.line === first + offset);
		assert.equal(at(5).thread, t);
		assert.deepEqual([at(12).thread, at(12).order], [-1, {}]);
		assert.deepEqual([at(14).thread, at(14).order.after], [-1, [t]]);
	} finally {
		engine.notify('textDocument/didClose', { file: fixture });
	}
});

test('threads: a destructor that joins is a join, and a local object goes to a thread through a parameter or this', async () => {
	const base = readFileSync(fixture, 'utf8').replace(/\r?\n?$/, '\n');
	const first = base.split('\n').length;
	const extra = [
		'#include <thread>', // +0
		'int df_sum = 0;',
		'struct DfJob {',
		'  std::thread thread_;',
		'  int value_ = 0;',
		'  void start() { thread_ = std::thread([this]() { value_++; df_sum++; }); }', // +5
		'  ~DfJob() {',
		'    if (thread_.joinable()) thread_.join();',
		'    value_ = 0;',
		'  }',
		'};', // +10
		'void df_scoped() {',
		'  {',
		'    DfJob job;',
		'    job.start();',
		'    job.value_ = 1;', // +15
		'    df_sum = 1;',
		'  }',
		'  df_sum = 2;',
		'}',
		'struct DfTask {', // +20
		'  std::thread thread_;',
		'  int value_ = 0;',
		'};',
		'void df_go(DfTask& _t) { _t.thread_ = std::thread([&_t]() { _t.value_ = 5; }); }',
		'void df_local() {', // +25
		'  DfTask task;',
		'  df_go(task);',
		'  task.value_ = 2;',
		'  task.thread_.join();',
		'  task.value_ = 3;', // +30
		'}',
		'void df_jthread() {',
		'  int n = 0;',
		'  {',
		'    std::jthread t([&n]() { n++; });', // +35
		'  }',
		'  n = 2;',
		'}',
	];
	engine.notify('textDocument/didOpen', { file: fixture, text: base + extra.join('\n') + '\n', version: 14 });
	try {
		const root = path.join(repo, 'test/fixtures/battery');
		const res = await engine.send('dataflow/threads', { file: fixture, asyncFunctions: ['tf::Executor::async'], roots: [root] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		const { threads, items, functions } = res.result;
		const thread = (offset) => threads.findIndex((x) => x.at?.line === first + offset);
		const joins = (t) => threads[t].joins.map((j) => [j.kind, j.line - first, functions[j.fn]?.name]);
		const item = (label) => {
			const found = items.find((i) => i.label === label);
			assert.ok(found, `${label} in ${JSON.stringify(items.map((i) => i.label))}`);
			return found;
		};
		const refs = (label) => item(label).refs.map((r) => [r.line - first, r.thread, r.order.after ?? []]);
		const job = thread(5);
		const task = thread(24);
		const jthread = thread(35);
		assert.ok(job >= 0 && task >= 0 && jthread >= 0, JSON.stringify(threads));

		// the destructor of DfJob joins the thread of its object. at the end of the block of job, the join is in
		// df_scoped. the write after the block is in sequence with the thread, the write in the block is a race
		assert.deepEqual(joins(job), [['join', 7, '~DfJob'], ['~DfJob', 17, 'df_scoped']]);
		assert.deepEqual(refs('df_sum'), [[5, job, []], [16, -1, []], [18, -1, [job]]]);

		// job is a local object, and the thread gets it through this. the destructor writes it after its join
		assert.deepEqual(refs('job.value_'), [[5, job, []], [8, -1, [job]], [15, -1, []]]);

		// task is a local object, and the thread gets it through a reference parameter of df_go
		assert.deepEqual(joins(task), [['join', 29, 'df_local']]);
		assert.deepEqual(refs('task.value_'), [[24, task, []], [28, -1, []], [30, -1, [task]]]);

		// the destructor of std::jthread joins at the end of its block
		assert.deepEqual([threads[jthread].via, threads[jthread].isJoined], ['std::jthread', true]);
		assert.deepEqual(joins(jthread), [['~jthread', 36, 'df_jthread']]);
		assert.deepEqual([item('n').kind, refs('n')], ['local', [[35, jthread, []], [37, -1, [jthread]]]]);
	} finally {
		engine.notify('textDocument/didClose', { file: fixture });
	}
});

test('threads: a guard in a cast, a guard that a function returns, and a function that takes a lock hold the lock', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-locks-'));
	const file = path.join(dir, 'locks.cpp');
	writeFileSync(file, [
		'#include <mutex>',
		'#include <thread>',
		'struct Counter {',
		'  std::mutex m_;',
		'  int a_ = 0, b_ = 0, c_ = 0, d_ = 0, e_ = 0, f_ = 0, g_ = 0, h_ = 0;',
		'  static thread_local int calls_;', // 6: each thread has its own object
		'  Counter* other_ = nullptr;',
		'  std::thread worker_;',
		'  std::unique_lock<std::mutex> guard() { return std::unique_lock<std::mutex>(m_); }',
		'  void take() { m_.lock(); }',
		'  void give() { m_.unlock(); }',
		'  void touch() { m_.lock(); m_.unlock(); }',
		'  void scoped() { std::lock_guard g(m_); }',
		'  static void lockOf(std::mutex& m) { m.lock(); }',
		'  void start() {',
		'    worker_ = std::thread([this] {',
		'      { auto lock = std::unique_lock(m_); ++a_; ++calls_; }', // 17: a guard in a cast
		'      { auto lock = std::lock_guard<std::mutex>(m_); ++b_; }', // 18
		'      { auto lock = guard(); ++c_; }', // 19: a guard that a function returns
		'      { take(); ++d_; give(); }', // 20: a function that takes the lock
		'      { lockOf(m_); ++e_; m_.unlock(); }', // 21: the argument for the parameter
		'      { touch(); ++f_; }', // 22: a function that takes and releases the lock
		'      { scoped(); ++g_; }', // 23: the guard of a function releases at its end
		'      { other_->take(); ++h_; other_->give(); }', // 24: the mutex of a different object
		'    });',
		'  }',
		'  int read() {',
		'    std::lock_guard g(m_);',
		'    return a_ + b_ + c_ + d_ + e_ + f_ + g_ + h_ + calls_;',
		'  }',
		'  ~Counter() { if (worker_.joinable()) worker_.join(); }',
		'};',
		'thread_local int Counter::calls_ = 0;',
	].join('\n') + '\n');
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		assert.equal((await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 })).error, undefined);
		const res = await own.send('dataflow/threads', { file, asyncFunctions: [], roots: [dir] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		const locks = (label) => res.result.items.find((i) => i.label === label).refs.filter((r) => r.thread === 0).map((r) => r.locks);
		assert.deepEqual(['a_', 'b_', 'c_', 'd_', 'e_'].map(locks), [[['m_']], [['m_']], [['m_']], [['m_']], [['m_']]]);
		assert.deepEqual(['f_', 'g_', 'h_'].map(locks), [[[]], [[]], [[]]]);
		// a thread_local variable is no shared data
		assert.ok(!res.result.items.some((i) => i.label.includes('calls_')), JSON.stringify(res.result.items.map((i) => i.label)));
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('gives the statements of a function with their branches and items, and the accesses with paths and roles', async () => {
	const res = await engine.send('dataflow/structure', {
		file: fixture, function: 'process', eventFunctions: ['fire_transition'], asyncFunctions: ['tf::Executor::async'],
	});
	assert.equal(res.error, undefined, JSON.stringify(res.error));
	const m = res.result;
	assert.equal(m.errorCount, 0, m.errors.join('\n'));
	assert.equal(m.function.qualifiedName, 'electricity::power_ctrl::process');
	const lines = readFileSync(fixture, 'utf8').split(/\r?\n/);
	const start = lines.findIndex((l) => l.includes('std::optional<Requests> process(')) + 1;
	const at = (text) => lines.findIndex((l, i) => i >= start && l.includes(text)) + 1;

	// the statements of the body in sequence. An if contains all branches of its chain
	const ifEmpty = at('if (tariff_plans.active.size() == 0)');
	const ifStart = at('if (charge.is_dirty');
	const shiftLine = at('fire_transition(home_battery_ctl, "", true)');
	const chainFirst = at('if (home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING)');
	const last = at('return requests;');
	assert.deepEqual(m.statements.map((s) => [s.kind, s.first, s.last]), [
		['decl', at('auto &tariff_plans'), at('auto &tariff_plans')],
		['decl', at('auto &settings'), at('auto &settings')],
		['decl', at('std::optional<Requests> requests'), at('std::optional<Requests> requests')],
		['if', ifEmpty, ifEmpty + 2],
		['decl', at('auto cur_tariff_plan'), at('auto cur_tariff_plan')],
		['if', ifStart, ifStart + 2],
		['expr', shiftLine, shiftLine],
		['if', chainFirst, last - 1],
		['return', last, last],
	]);
	const [, , , empty, , startIf, shift, chain, ret] = m.statements;
	assert.equal(chain.text, 'home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING');
	assert.deepEqual([empty.exits, ret.exits], [[{ line: ifEmpty + 1, kind: 'return' }], [{ line: last, kind: 'return' }]]);

	// a branch after the first starts at the line of its else, and the branch before it ends on the line before
	const moving = at('} else if (home_battery_ctl.state == HOMEPOWER_CHARGE_ACTIVE)');
	const searching = at('} else if (home_battery_ctl.state == HOMEPOWER_METER_READING)');
	const detected = at('} else if (home_battery_ctl.state == HOMEPOWER_METER_STABLE)');
	assert.deepEqual(chain.branches.map((b) => [b.label, b.first, b.last]), [
		['home_battery_ctl.state == HOMEPOWER_CHARGE_PLANNING', chainFirst, moving - 1],
		['home_battery_ctl.state == HOMEPOWER_CHARGE_ACTIVE', moving, searching - 1],
		['home_battery_ctl.state == HOMEPOWER_METER_READING', searching, detected - 1],
		['home_battery_ctl.state == HOMEPOWER_METER_STABLE', detected, last - 1],
	]);

	// the exits of the chain are its two returns. The break leaves only the loop in the chain
	const returns = lines.map((l, i) => (l.includes('return std::nullopt;') ? i + 1 : 0)).filter((n) => n > chainFirst && n < last);
	assert.deepEqual(chain.exits, returns.map((line) => ({ line, kind: 'return' })));
	const auto = chain.branches[3].statements[1].branches[0].statements;
	assert.deepEqual(auto.map((s) => s.kind), ['for', 'if', 'expr']);
	assert.deepEqual([auto[0].exits, auto[0].body[1].exits], [[], [{ line: at('break;'), kind: 'break' }]]);

	// a call of an event function is an event with its first string literal. A call of a function of the file is a call
	assert.deepEqual(shift.events, [{ line: shiftLine, name: '' }]);
	assert.deepEqual(chain.events.map((e) => e.name).sort(),
		['_ended', '_full', '_measured', '_planned', '_planned', '_saved', '_timeout', 'stop', 'stop']);
	assert.deepEqual(chain.calls, [{ line: at('log_info("the schedule converged")'), name: 'log_info' }]);

	// the lambda of the thread start runs solve_power_plan(). That call is not a call of the statement, because the thread
	// makes it later
	assert.deepEqual(startIf.threads, [{ line: at('executor.async('), via: 'tf::Executor::async', runs: 'solve_power_plan' }]);
	assert.deepEqual(startIf.calls, []);

	// an access has the path of the source text, the object through the local references, the role and the scope
	const access = (list, line, p) => list.find((a) => a.line === line && a.path === p);
	const pick = (a) => a && [a.role, a.scope, a.object ?? null, a.inLambda ?? false];
	const async = at('executor.async(');
	assert.deepEqual(pick(access(m.accesses, ifStart, 'charge.is_dirty')), ['read', 'param', null, false]);
	assert.deepEqual(pick(access(m.accesses, ifStart, 'home_battery_ctl.charging_future')), ['read', 'param', null, false]);
	assert.deepEqual(pick(access(m.accesses, async, 'home_battery_ctl.charging_future')), ['write', 'param', null, false]);
	assert.deepEqual(pick(access(m.accesses, async, 'charge')), ['readwrite', 'param', null, true]);
	assert.deepEqual(pick(access(m.accesses, at('charging_future.reset()'), 'home_battery_ctl.charging_future')),
		['readwrite', 'param', null, false]);
	assert.deepEqual(pick(access(m.accesses, at('auto &settings'), 'settings')),
		['decl', 'local', 'home_battery_ctl.operational_settings', false]);
	// the binding of a local reference is a read. Constants and the globals of the standard library are not accesses
	assert.deepEqual(pick(access(m.accesses, at('auto &settings'), 'home_battery_ctl.operational_settings')),
		['read', 'param', null, false]);
	assert.ok(!m.accesses.some((a) => ['nullopt', 'main_optimizer_id'].includes(a.path)), JSON.stringify(m.accesses.map((a) => a.path)));
	assert.deepEqual(pick(access(m.accesses, at('stable_readings(settings.meter_hold_time)'), 'settings.meter_hold_time')),
		['read', 'param', 'home_battery_ctl.operational_settings.meter_hold_time', false]);
	// the reference of a range for loop is an element of the range
	const loop = at('for (const auto &d : home_battery_ctl.new_readings)');
	assert.deepEqual(pick(access(m.accesses, loop, 'd')), ['decl', 'local', 'home_battery_ctl.new_readings', false]);
	assert.deepEqual(pick(access(m.accesses, loop + 1, 'd')), ['read', 'param', 'home_battery_ctl.new_readings', false]);
	const keys = m.accesses.map((a) => a.line * 10000 + a.col);
	assert.deepEqual(keys, [...keys].sort((a, b) => a - b));

	// a data member through this, and the thread of a lambda that calls only functions of the standard library
	const poolFile = path.join(repo, 'test/fixtures/battery/src/worker_pool.cpp');
	const poolLines = readFileSync(poolFile, 'utf8').split(/\r?\n/);
	const destroy = await engine.send('dataflow/structure', { file: poolFile, function: 'electricity::WorkerPool::destroy' });
	assert.equal(destroy.error, undefined, JSON.stringify(destroy.error));
	assert.deepEqual(destroy.result.statements.map((s) => s.kind), ['block', 'expr', 'for', 'expr']);
	assert.deepEqual(pick(destroy.result.accesses.find((a) => a.path === 'isStopping_')), ['write', 'member', null, false]);
	const ctor = await engine.send('dataflow/structure', { file: poolFile, function: 'electricity::WorkerPool::WorkerPool' });
	assert.equal(ctor.error, undefined, JSON.stringify(ctor.error));
	const emplace = poolLines.findIndex((l) => l.includes('threads_.emplace_back')) + 1;
	assert.deepEqual(ctor.result.statements[0].threads, [{ line: emplace, via: 'std::thread', runs: 'lambda' }]);
});

test('gives the lines of the reads that each write of the structure reaches over the control flow', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-reaches-'));
	const file = path.join(dir, 'pick.cpp');
	writeFileSync(file, [
		'struct State { int count = 0; };',
		'int pick(State &s, bool c, int v) {',
		'  int x = 0;', // 3: each branch writes x again, so this value reaches no read
		'  if (c) {',
		'    x = 1;', // 5
		'  } else {',
		'    x = v;', // 7
		'  }',
		'  int y = x;', // 9
		'  for (int i = 0; i < 3; ++i) {',
		'    y += i;', // 11: the read of the next turn is the same access, so it is not in the lines
		'  }',
		'  s.count = y;', // 13: a data member of a parameter
		'  auto f = [&] { return y; };', // 14: the capture reads y
		'  auto g = [&](int k) {',
		'    int t = k;', // 16: a local variable of the lambda
		'    t += y;', // 17
		'    x = t;', // 18: a captured variable has no lines. Its reads are in the enclosing function
		'    return t;',
		'  };',
		'  return f() + g(2) + x;', // 21
		'}',
		'struct Item { int x = 0; };',
		'struct Box { Item items[2]; int size = 0; };',
		'int fill(Box &b, int v) {', // 25
		'  Box q{};',
		'  q.items[0].x = v;', // 27: a write through an element gets the reads of its container q.items
		'  q.size = 1;',
		'  int n = q.size;', // 29
		'  return q.items[1].x + n;', // 30
		'}',
	].join('\n') + '\n');
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		assert.equal((await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 })).error, undefined);
		const res = await own.send('dataflow/structure', { file, function: 'pick' });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		const reaches = (line, p) => res.result.accesses.filter((a) => a.line === line && a.path === p && a.role !== 'read').map((a) => a.reaches);
		assert.deepEqual(reaches(3, 'x'), [[]]);
		// the capture of lambda g on line 15 reads x and y
		assert.deepEqual([reaches(5, 'x'), reaches(7, 'x')], [[[9, 15, 21]], [[9, 15, 21]]]);
		assert.deepEqual(reaches(9, 'y'), [[11, 13, 14, 15]]);
		assert.deepEqual(reaches(11, 'y'), [[13, 14, 15]]);
		assert.deepEqual(reaches(13, 's.count'), [[]]);
		// a lambda has a cfg of its own
		assert.deepEqual([reaches(16, 't'), reaches(17, 't'), reaches(18, 'x')], [[[17]], [[18, 19]], [undefined]]);
		// a read has no lines
		assert.ok(res.result.accesses.filter((a) => a.role === 'read').every((a) => a.reaches === undefined));

		// a path through an element: the lines of the container. q.size is a different member
		const box = await own.send('dataflow/structure', { file, function: 'fill' });
		assert.equal(box.error, undefined, JSON.stringify(box.error));
		const boxReaches = (line, p) => box.result.accesses.filter((a) => a.line === line && a.path === p && a.role !== 'read').map((a) => a.reaches);
		assert.deepEqual(boxReaches(27, 'q.items[].x'), [[30]]);
		assert.deepEqual(boxReaches(28, 'q.size'), [[29]]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('uses its own builtin headers in place of the builtin headers of a different clang', async () => {
	// Qt Creator writes "-nostdinc" and the builtin headers of its own clang into the commands for clangd. These headers
	// stop the parse here, so the engine must use its own headers
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-builtins-'));
	const foreign = path.join(dir, 'qtcreator', 'bin', 'clang', 'lib', 'clang', '22', 'include');
	mkdirSync(foreign, { recursive: true });
	writeFileSync(path.join(foreign, 'stddef.h'), '#error the builtin headers of a different clang\n');
	const source = (name) => {
		const file = path.join(dir, name);
		writeFileSync(file, '#include <stddef.h>\nint df_size(void) { return (int)sizeof(size_t); }\n');
		return file;
	};
	const gcc = source('gcc.c');
	const cl = source('cl.c');
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([
		{ directory: dir, file: gcc, arguments: ['clang', '-nostdinc', '-isystem', foreign, '-resource-dir=C:/other', '-c', gcc] },
		{ directory: dir, file: cl, arguments: ['clang', '--driver-mode=cl', '-nostdinc', '/clang:-isystem', `/clang:${foreign}`, '-c', cl] },
	]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		for (const file of [gcc, cl]) {
			const res = await own.send('dataflow/functions', { file });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			assert.equal(res.result.errorCount, 0, `${path.basename(file)}: ${res.result.errors.join('\n')}`);
			assert.deepEqual(res.result.functions.map((f) => f.name), ['df_size']);
		}
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('ignores a module map of MSVC that the build did not write, and the module options of MSVC', async () => {
	// CMake gives MSVC a module map for each source file, and Ninja writes it only in a build. Before the build, the driver
	// took the missing response file as a second source file: "cannot specify /Fo when compiling multiple source files"
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-modmap-'));
	const file = path.join(dir, 'main.cpp');
	writeFileSync(file, 'int df_main() { return 0; }\n');
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{
		directory: dir, file,
		command: `cl.exe /nologo /TP -std:c++latest -reference other=other.ifc @CMakeFiles\\App.dir\\main.cpp.obj.modmap /FoCMakeFiles\\App.dir\\main.cpp.obj /FdCMakeFiles\\App.dir\\ /FS -c ${file}`,
	}]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/functions', { file });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		assert.deepEqual(res.result.functions.map((f) => f.name), ['df_main']);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('ignores the options of MSVC that clang-cl does not know, as UnrealBuildTool gives them in a response file', async () => {
	// UnrealBuildTool gives MSVC "/experimental:log <file>.sarif", "/sourceDependencies <file>.json" and
	// /dximplicitlyinstantiatevirtualfunction-. The driver took the files and the unknown option as source files: "cannot
	// specify /Fo when compiling multiple source files"
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-ubt-'));
	const file = path.join(dir, 'Actor.cpp');
	writeFileSync(file, 'int df_tick() { return 1; }\n');
	const rsp = path.join(dir, 'Actor.cpp.obj.rsp');
	writeFileSync(rsp, [
		`"${file}"`, `/Fo"${path.join(dir, 'Actor.cpp.obj')}"`, `/experimental:log "${path.join(dir, 'Actor.cpp.sarif')}"`,
		`/sourceDependencies "${path.join(dir, 'Actor.cpp.dep.json')}"`, '/dximplicitlyinstantiatevirtualfunction-', '/d2ExtendedWarningInfo',
		'/nologo', '/TP', '/std:c++20', '/c',
	].join('\r\n'));
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file, command: `cl.exe @"${rsp}"` }]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/functions', { file });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		assert.deepEqual(res.result.functions.map((f) => f.name), ['df_tick']);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('accepts a ## that gives no valid token in a command of MSVC, as MSVC does, and not in a command of clang-cl', async () => {
	// clang defines _MSVC_TRADITIONAL as 1, thus Unreal Engine pastes a macro name and its arguments in parentheses for the
	// traditional preprocessor of MSVC (UE_APPEND_VA_ARG_COUNT). clang-cl gave "pasting formed 'ADD(', an invalid
	// preprocessing token" for each use
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-paste-'));
	const text = [
		'#if defined(_MSVC_TRADITIONAL) && _MSVC_TRADITIONAL',
		'#define DF_INVOKE(Macro, Args) DF_EXPAND(Macro##Args)',
		'#else',
		'#define DF_INVOKE(Macro, Args) Macro Args',
		'#endif',
		'#define DF_EXPAND(X) X',
		'#define DF_ADD(A, B) ((A) + (B))',
		'int df_sum() { return DF_INVOKE(DF_ADD, (1, 2)); }',
		'',
	].join('\n');
	const msvc = path.join(dir, 'msvc.cpp');
	const clang = path.join(dir, 'clang.cpp');
	writeFileSync(msvc, text);
	writeFileSync(clang, text);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([
		{ directory: dir, file: msvc, command: `cl.exe /nologo /TP /std:c++20 /Zc:preprocessor /c "${msvc}"` },
		{ directory: dir, file: clang, command: `clang-cl.exe /nologo /TP /std:c++20 /c "${clang}"` },
	]));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/functions', { file: msvc });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		assert.deepEqual(res.result.functions.map((f) => f.name), ['df_sum']);
		// clang-cl itself gives the error, so the engine shows it
		const other = await own.send('dataflow/functions', { file: clang });
		assert.ok(other.result.errors.some((e) => e.includes('pasting formed')), other.result.errors.join('\n'));
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('finds the definition of the name at a position: a type, a macro, a function, a variable, a member and an include', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-definition-'));
	const header = path.join(dir, 'defs.h');
	const source = path.join(dir, 'main.cpp');
	const headerText = [
		'#pragma once',
		'#define DF_LIMIT 42',
		'struct Battery {',
		'  double charge_ = 0.0;',
		'  double charge(double kw);',
		'};',
		'int df_free(int value);',
		'template <class T> T df_twice(T v) { return v + v; }',
		'',
	].join('\n');
	const sourceText = [
		'#include "defs.h"',
		'double Battery::charge(double kw) { charge_ += kw; return charge_; }',
		'int df_use() {',
		'  Battery b;',
		'  int local = DF_LIMIT;',
		'  b.charge(1.0);',
		'  return df_twice(df_free(local));',
		'}',
		'',
	].join('\n');
	writeFileSync(header, headerText);
	writeFileSync(source, sourceText);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file: source, arguments: ['clang++', '-std=c++20', '-c', source] }]));
	// the line and the column, from 1, of a word in a line of a text
	const at = (text, line, word, nth = 0) => {
		const lineText = text.split('\n')[line - 1];
		let col = -1;
		for (let i = 0; i <= nth; i++) col = lineText.indexOf(word, col + 1);
		assert.ok(col >= 0, `${word} in line ${line}`);
		return { line, col: col + 1 };
	};
	const key = (file) => path.resolve(file).toLowerCase();
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const definition = async (place) => {
			const res = await own.send('dataflow/definition', { file: source, ...place });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			return res.result;
		};
		const expect = async (place, name, kind, target) => {
			const r = await definition(place);
			assert.equal(r.name, name);
			assert.equal(r.kind, kind);
			assert.equal(r.targets.length, 1, JSON.stringify(r));
			const [t] = r.targets;
			assert.deepEqual({ file: key(t.file), line: t.line, col: t.col, role: t.role },
				{ file: key(target.file), line: target.line, col: target.col, role: target.role }, `${name}: ${JSON.stringify(t)}`);
		};

		// a type in the header, and a macro of the header
		await expect(at(sourceText, 4, 'Battery'), 'Battery', 'class', { file: header, ...at(headerText, 3, 'Battery'), role: 'definition' });
		await expect(at(sourceText, 5, 'DF_LIMIT'), 'DF_LIMIT', 'macro', { file: header, ...at(headerText, 2, 'DF_LIMIT'), role: 'definition' });
		// a method with its definition in the source file, also with the position right after the name
		const chargeDef = { file: source, ...at(sourceText, 2, 'charge'), role: 'definition' };
		await expect(at(sourceText, 6, 'charge'), 'Battery::charge', 'method', chargeDef);
		const after = at(sourceText, 6, 'charge');
		await expect({ line: after.line, col: after.col + 'charge'.length }, 'Battery::charge', 'method', chargeDef);
		// the name of the definition itself
		await expect(at(sourceText, 2, 'charge'), 'Battery::charge', 'method', chargeDef);
		// a function with no definition in the translation unit: its declaration
		await expect(at(sourceText, 7, 'df_free'), 'df_free', 'function', { file: header, ...at(headerText, 7, 'df_free'), role: 'declaration' });
		// a local variable, a function template and a data member
		await expect(at(sourceText, 7, 'local'), 'local', 'variable', { file: source, ...at(sourceText, 5, 'local'), role: 'definition' });
		await expect(at(sourceText, 7, 'df_twice'), 'df_twice', 'function', { file: header, ...at(headerText, 8, 'df_twice'), role: 'definition' });
		await expect(at(sourceText, 2, 'charge_'), 'Battery::charge_', 'property', { file: header, ...at(headerText, 4, 'charge_'), role: 'definition' });
		// the file of an include
		await expect(at(sourceText, 1, 'defs'), '"defs.h"', 'string', { file: header, line: 1, col: 1, role: 'file' });
		// a keyword has no definition
		assert.deepEqual((await definition(at(sourceText, 7, 'return'))).targets, []);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('gives the outline of a class: the bases, the members in the source, the annotations, the layout and the inherited members', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-outline-'));
	const header = path.join(dir, 'outline.h');
	const source = path.join(dir, 'main.cpp');
	const headerText = [
		'#pragma once',
		'#define UPROPERTY(...)',
		'#define GENERATED_MEMBERS() int generated_ = 0; void generated_fn();',
		'#define signals public',
		'#define slots',
		'#define Q_PROPERTY(...)',
		'struct Unknown;',
		'struct Device {',
		'  virtual ~Device() = default;',
		'  virtual void tick(double dt) = 0;',
		'  int id_ = 0;',
		'};',
		'class Battery final : public Device {',
		' public:',
		'  enum class State : unsigned char { IDLE, CHARGING = 4 };',
		'  using Kw = double;',
		'  explicit Battery(double capacity);',
		'  void tick(double dt) override;',
		'  static int count();',
		'  double charge(double kw) const noexcept;',
		'  UPROPERTY(EditAnywhere, Category = "Power")',
		'  double capacity_ = 13.5;',
		'  GENERATED_MEMBERS()',
		' private:',
		'  bool isDirty_ = false;',
		'  State state_ = State::IDLE;',
		'  friend struct Inspector;',
		'};',
		'class Widget {',
		'  Q_PROPERTY(int value READ value WRITE setValue)',
		' public:',
		'  int value() const;',
		' public slots:',
		'  void setValue(int v);',
		' signals:',
		'  void valueChanged(int v);',
		'};',
		'namespace grid { struct Meter { int id = 0; }; }',
		'namespace home { struct Meter { int id = 0; }; struct Panel { int watts = 0; }; }',
		'',
	].join('\n');
	const sourceText = [
		'#include "outline.h"',
		'Battery::Battery(double capacity) : capacity_(capacity) {}',
		'void Battery::tick(double dt) { capacity_ -= dt; }',
		'int df_use(Unknown* unknown) {',
		'  Battery b(1.0);',
		'  using Alias = Battery;',
		'  Alias* p = &b;',
		'  return Battery::count() + (p != nullptr) + (unknown != nullptr);',
		'}',
		'',
	].join('\n');
	writeFileSync(header, headerText);
	writeFileSync(source, sourceText);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file: source, arguments: ['clang++', '-std=c++20', '-c', source] }]));
	const at = (line, word) => ({ line, col: sourceText.split('\n')[line - 1].indexOf(word) + 1 });
	const lineOf = (text) => headerText.split('\n').findIndex((l) => l.includes(text)) + 1;
	const key = (file) => path.resolve(file).toLowerCase();
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const outline = async (params) => {
			const res = await own.send('dataflow/outline', { file: source, ...params });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
			return res.result;
		};

		// the class at the name of a variable declaration
		const { outline: o } = await outline(at(5, 'Battery'));
		assert.deepEqual([o.name, o.kind, o.isFinal, o.isAbstract, key(o.file), o.line], ['Battery', 'class', true, false, key(header), lineOf('class Battery')]);
		assert.deepEqual(o.bases.map((b) => [b.name, b.access, b.isVirtual, b.offset]), [['Device', 'public', false, 0]]);
		const m = Object.fromEntries(o.members.map((x) => [x.name, x]));
		assert.deepEqual(o.members.map((x) => `${x.kind} ${x.name}`), [
			'type State', 'type Kw', 'constructor Battery', 'method tick', 'method count', 'method charge', 'field capacity_',
			'field generated_', 'method generated_fn', 'field isDirty_', 'field state_', 'friend Inspector',
		]);
		assert.equal(m.State.text, 'enum class');
		assert.deepEqual([m.Battery.marks, m.Battery.definition?.line, key(m.Battery.definition?.file ?? '')], [['explicit'], 2, key(source)]);
		assert.deepEqual([m.tick.marks, m.tick.definition?.line], [['override'], 3]);
		assert.deepEqual([m.count.marks, m.count.definition], [['static'], undefined]);
		assert.deepEqual([m.charge.text, m.charge.marks], ['double charge(double kw) const', ['noexcept']]);
		assert.deepEqual([m.capacity_.text, m.capacity_.annotation, m.capacity_.access], ['double = 13.5', 'UPROPERTY(EditAnywhere, Category = "Power")', 'public']);
		assert.deepEqual([m.generated_.macro, m.generated_fn.macro], ['GENERATED_MEMBERS', 'GENERATED_MEMBERS']);
		assert.deepEqual([m.isDirty_.text, m.isDirty_.access], ['bool = false', 'private']);
		// the layout: the base first, then the data members. The bytes after state_ are padding
		assert.deepEqual([m.capacity_.offset, m.capacity_.size, m.isDirty_.offset, m.state_.offset, m.state_.size], [16, 8, 28, 29, 1]);
		assert.equal(o.layout.size, 32);
		assert.ok(o.layout.holes.some((h) => h.offset === 30 && h.size === 2), JSON.stringify(o.layout));
		assert.equal(o.layout.padding, o.layout.holes.reduce((s, h) => s + h.size, 0));
		// the members of the base
		assert.deepEqual(o.inherited.map((g) => [g.base, g.members.map((x) => `${x.kind} ${x.name}`)]),
			[['Device', ['destructor ~Device', 'method tick', 'field id_']]]);

		// a type alias of the class gives the class
		assert.equal((await outline(at(7, 'Alias'))).outline?.name, 'Battery');
		// a qualified name: an abstract struct, and a nested enum
		const device = (await outline({ name: 'Device' })).outline;
		assert.deepEqual([device.kind, device.isAbstract, device.layout.hasVPtr], ['struct', true, true]);
		assert.deepEqual(device.members.map((x) => [x.name, x.marks ?? []]), [['~Device', ['virtual', '= default']], ['tick', ['virtual', 'pure']], ['id_', []]]);
		const state = (await outline({ name: 'Battery::State' })).outline;
		assert.deepEqual([state.kind, state.underlying, state.members.map((x) => [x.kind, x.name, x.text])],
			['enum class', 'unsigned char', [['enumerator', 'IDLE', '0'], ['enumerator', 'CHARGING', '4']]]);
		// the sections and the properties of qt
		const widget = (await outline({ name: 'Widget' })).outline;
		assert.deepEqual(widget.members.map((x) => [x.kind, x.name, x.section ?? '']),
			[['property', 'value', ''], ['method', 'value', ''], ['method', 'setValue', 'slots'], ['method', 'valueChanged', 'signals']]);
		assert.equal(widget.members[0].text, 'Q_PROPERTY(int value READ value WRITE setValue)');
		// a name with no namespaces or with a part of them: the search finds it. A name of two types gives the candidates
		assert.equal((await outline({ name: 'Panel' })).outline?.qualifiedName, 'home::Panel');
		assert.equal((await outline({ name: 'State' })).outline?.qualifiedName, 'Battery::State');
		const meter = await outline({ name: 'Meter' });
		assert.deepEqual([meter.outline, meter.candidates?.slice().sort()], [null, ['grid::Meter', 'home::Meter']]);
		assert.equal((await outline({ name: 'grid::Meter' })).outline?.qualifiedName, 'grid::Meter');

		// a type with no definition in the translation unit gives its declaration, and a function gives nothing
		const unknown = await outline(at(4, 'Unknown'));
		assert.deepEqual([unknown.outline, unknown.declaration?.name, unknown.declaration?.line], [null, 'Unknown', lineOf('struct Unknown;')]);
		assert.equal((await outline(at(4, 'df_use'))).outline, null);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('tells for each include if forward declarations can replace it, or the first use that needs it', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-forward-'));
	const headers = {
		'battery.h': 'namespace power { struct Battery { double kw = 0; }; }',
		'plan.h': 'namespace power { class Plan { public: int hours = 0; }; }',
		'mode.h': 'enum class Mode : unsigned char { IDLE, CHARGE };',
		'box.h': 'template <class T> class Box { public: T value; };',
		'pair.h': 'template <class T, class U = int> class Pair {};',
		'macro.h': '#define POWER_LIMIT 42',
		'alias.h': 'using Kw = double;',
		'member.h': 'struct Meter { int read() const { return 1; } };',
		'cell.h': 'struct Cell { int id = 0; };',
		'gauge.h': 'struct Gauge { int id = 0; };',
		'base.h': 'struct Base { int id = 0; };',
		'pool.h': 'struct Pool { bool busy(); };',
		'point.h': 'struct Point { int x = 0, y = 0; };',
		'error.h': 'struct Error { int code = 0; };',
		'slot.h': 'struct Slot { int id = 0; };',
		'filter.h': 'struct Filter { int id = 0; };',
		'ring.h': 'template <class T, int N> class Ring {};',
		'gate.h': 'template <class T> concept Small = sizeof(T) < 8; template <Small T> class Gate {};',
		'later.h': 'template <class T, class U> class Later; template <class T, class U = int> class Later {};',
		// only argument-dependent lookup in the instantiation finds touch()
		'generic.h': 'template <class T> void call_touch(T p) { touch(p); }',
		'touch.h': 'struct Probe {}; inline void touch(Probe*) {}',
	};
	for (const [name, text] of Object.entries(headers)) writeFileSync(path.join(dir, name), `#pragma once\n${text}\n`);
	const source = path.join(dir, 'main.cpp');
	const sourceText = [
		...Object.keys(headers).map((h) => `#include "${h}"`),
		'#include <memory>',
		'#include <utility>',
		'void df_use(power::Battery* battery, const power::Battery& ref);',
		'power::Plan df_plan;',
		'void df_set(Mode mode);',
		'Box<int>* df_box = nullptr;',
		'Pair<int>* df_pair = nullptr;',
		'int df_limit = POWER_LIMIT;',
		'Kw df_kw = 1.0;',
		'int df_read(const Meter& meter) { return meter.read(); }',
		'std::shared_ptr<Cell> df_cell;',
		'std::unique_ptr<Gauge> df_gauge;',
		'struct Derived : Base {};',
		'bool Pool::busy() { return false; }',
		'void df_take(Point point);',
		'void df_point() { df_take(Point{1, 2}); }',
		'void df_try() { try { df_point(); } catch (const Error& error) { } }',
		'void df_swap(Slot* a, Slot* b) { std::swap(*a, *b); }',
		'auto df_lambda = [](Filter) { return 0; };',
		'Ring<int, 4>* df_ring = nullptr;',
		'Gate<int>* df_gate = nullptr;',
		'Later<int>* df_later = nullptr;',
		'void df_probe(Probe* probe) { call_touch(probe); }',
		'',
	].join('\n');
	writeFileSync(source, sourceText);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([{ directory: dir, file: source, arguments: ['clang++', '-std=c++20', '-c', source] }]));
	const lineOf = (text) => sourceText.split('\n').findIndex((l) => l.includes(text)) + 1;
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		const init = await own.send('initialize', { compileCommands: [db], maxThreads: 1, cacheSize: 2 });
		assert.equal(init.error, undefined, JSON.stringify(init.error));
		const res = await own.send('dataflow/includes', { file: source, roots: [dir] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		const forward = Object.fromEntries(res.result.nodes.filter((n) => n.parent === 0).map((n) => [n.spelled, n.forward ?? null]));

		// pointers and references, a function declaration with a parameter by value, a pointer to a template, and a
		// template on the short list
		assert.deepEqual(forward['"battery.h"'], {
			state: 'possible', text: 'namespace power { struct Battery; }', types: [{ name: 'power::Battery', lines: [lineOf('df_use(')] }],
		});
		assert.deepEqual([forward['"mode.h"']?.state, forward['"mode.h"']?.text], ['possible', 'enum class Mode : unsigned char;']);
		assert.deepEqual([forward['"box.h"']?.state, forward['"box.h"']?.text], ['possible', 'template <class T> class Box;']);
		assert.deepEqual([forward['"cell.h"']?.state, forward['"cell.h"']?.text], ['possible', 'struct Cell;']);
		// the first use that needs the include
		const blocker = (h) => forward[`"${h}"`]?.blocker;
		assert.deepEqual(blocker('plan.h'), { name: 'power::Plan', kind: 'a variable of the type', line: lineOf('power::Plan df_plan') });
		assert.deepEqual(blocker('pair.h'), { name: 'Pair', kind: 'a type with no forward declaration', line: lineOf('Pair<int>') });
		assert.deepEqual(blocker('macro.h'), { name: 'POWER_LIMIT', kind: 'a macro', line: lineOf('POWER_LIMIT;') });
		assert.deepEqual(blocker('alias.h'), { name: 'Kw', kind: 'a type alias', line: lineOf('Kw df_kw') });
		assert.deepEqual(blocker('member.h'), { name: 'Meter', kind: 'a member access', line: lineOf('meter.read()') });
		assert.deepEqual(blocker('gauge.h'), { name: 'Gauge', kind: 'a variable of the type', line: lineOf('std::unique_ptr<Gauge>') });
		assert.deepEqual(blocker('base.h'), { name: 'Base', kind: 'a base class', line: lineOf('struct Derived') });
		assert.deepEqual(blocker('pool.h'), { name: 'Pool', kind: 'a definition of a member function', line: lineOf('Pool::busy') });
		assert.deepEqual(blocker('point.h'), { name: 'Point', kind: 'an object of the type', line: lineOf('Point{1, 2}') });
		assert.deepEqual(blocker('error.h'), { name: 'Error', kind: 'a catch', line: lineOf('catch (') });
		assert.deepEqual(blocker('slot.h'), { name: 'Slot', kind: 'a template argument', line: lineOf('std::swap') });
		assert.deepEqual(blocker('filter.h'), { name: 'Filter', kind: 'a parameter by value', line: lineOf('df_lambda') });
		// a non-type parameter of a builtin type is no problem. a constraint can need the header
		assert.deepEqual([forward['"ring.h"']?.state, forward['"ring.h"']?.text], ['possible', 'template <class T, int N> class Ring;']);
		assert.deepEqual(blocker('gate.h'), { name: 'Gate', kind: 'a type with no forward declaration', line: lineOf('Gate<int>') });
		// a default argument of a later declaration counts too
		assert.deepEqual(blocker('later.h'), { name: 'Later', kind: 'a type with no forward declaration', line: lineOf('Later<int>') });
		// a header of the standard library gets no check
		assert.equal(forward['<memory>'], null);

		// the check parses a copy of the file with the declarations in the place of the include
		const check = (line, text) => own.send('dataflow/checkForward', { file: source, line, text });
		const clean = await check(lineOf('#include "battery.h"'), forward['"battery.h"'].text);
		assert.equal(clean.error, undefined, JSON.stringify(clean.error));
		assert.deepEqual([clean.result.errorCount, clean.result.errors], [0, []]);
		// the check of the uses does not see the instantiation of call_touch(), but the parse finds the error. Its note in
		// the file gives the line of the call
		assert.deepEqual([forward['"touch.h"']?.state, forward['"touch.h"']?.text], ['possible', 'struct Probe;']);
		const failing = await check(lineOf('#include "touch.h"'), forward['"touch.h"'].text);
		assert.equal(failing.result?.errorCount, 1, JSON.stringify(failing));
		assert.match(failing.result.errors[0].message, /touch/);
		assert.deepEqual([path.basename(failing.result.errors[0].file), failing.result.errors[0].at], ['generic.h', lineOf('call_touch(probe)')]);
		// a line with no include
		assert.match((await check(lineOf('power::Plan df_plan'), 'struct Plan;')).error?.message ?? '', /has no #include/);

		// a parse with an error gives no result, because the ast is not complete
		own.notify('textDocument/didOpen', { file: source, text: `${sourceText}int df_error = df_missing;\n`, version: 2 });
		const bad = await own.send('dataflow/includes', { file: source, roots: [dir] });
		assert.equal(bad.error, undefined, JSON.stringify(bad.error));
		assert.ok(bad.result.errorCount > 0);
		assert.ok(bad.result.nodes.every((n) => n.forward === undefined), JSON.stringify(bad.result.nodes.filter((n) => n.forward)));
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('call graph: the callers, the files of the callers and the frame paths, and updates of the changed source files', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-graph-'));
	const write = (name, lines) => {
		const file = path.join(dir, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, lines.join('\n') + '\n');
		return file;
	};
	// a header of a library out of the project folders, with a frame function of qt
	write('lib/QWidget.h', [
		'#pragma once',
		'class QWidget {',
		' public:',
		'  virtual ~QWidget() = default;',
		'  void update() { paintEvent(nullptr); }',
		' protected:',
		'  virtual void paintEvent(void* e) {}',
		'};',
	]);
	const renderLines = [
		'#pragma once',
		'struct Mesh { int size = 0; };',
		'void draw(const Mesh& m);',
		'int shade(int x);',
		'struct Pass { virtual ~Pass() = default; virtual void run() = 0; };',
		'struct Blur : Pass { void run() override; };',
		'struct Glow : Pass { void run() override; };',
		'inline int helper() { return 1; }',
	];
	const header = write('include/render.h', renderLines);
	const render = write('src/render.cpp', [
		'#include "render.h"',
		'int shade(int x) { return x * 2 + helper(); }',
		'void draw(const Mesh& m) { for (int i = 0; i < m.size; ++i) shade(i); }',
		'void Blur::run() { shade(1); }',
		'void Glow::run() { draw(Mesh{}); }',
	]);
	// a loop that empties a queue is no main loop
	const main = write('src/main.cpp', [
		'#include "render.h"',
		'#include <queue>',
		'static bool running = true;',
		'void frame(Pass& p) { p.run(); draw(Mesh{3}); }',
		'void setup() { helper(); }',
		'void report(int code) { (void)code; }',
		'int main() {',
		'  setup();',
		'  std::queue<int> errors;',
		'  while (!errors.empty()) { report(errors.front()); errors.pop(); }',
		'  Blur b;',
		'  while (running) frame(b);',
		'  return 0;',
		'}',
	]);
	// a header that no source file includes
	const unused = write('include/unused.h', ['#pragma once', 'inline int unused() { return 1; }']);
	const viewLines = [
		'#include "render.h"',
		'#include <QWidget.h>',
		'int lonely(int a) { return a + 1; }',
		'class View : public QWidget {',
		' protected:',
		'  void paintEvent(void* e) override { draw(Mesh{1}); }',
		'};',
		'template <class T> T twice(T v) { return v + v; }',
		'int twiceUser() { return twice(3) + int(twice(4.0)); }',
		'int more() { return twice(5); }',
	];
	const view = write('src/view.cpp', viewLines);
	const db = path.join(dir, 'compile_commands.json');
	const args = (file) => ['clang++', '-std=c++20', `-I${path.join(dir, 'include')}`, `-I${path.join(dir, 'lib')}`, '-c', file];
	writeFileSync(db, JSON.stringify([render, main, view].map((file) => ({ directory: dir, file, arguments: args(file) }))));
	const roots = [path.join(dir, 'include'), path.join(dir, 'src')];
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		assert.equal((await own.send('initialize', { compileCommands: [db], maxThreads: 4, cacheSize: 4 })).error, undefined);
		// the state of the call graph, and the reach of each function of a file by its qualified name
		const reach = async (file, frameFunctions = []) => {
			const res = await own.send('dataflow/metrics', { file, frameFunctions });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
			return [res.result.callGraph, Object.fromEntries(res.result.functions.map((f) => [f.qualifiedName, f.reach]))];
		};
		const scan = async () => {
			const { id, reply } = own.request('dataflow/callGraph', { roots });
			const res = await reply;
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			return { ...res.result, id };
		};

		// before the scan, the metrics have no reach
		const [before, none] = await reach(render);
		assert.deepEqual([before, none.shade], [{ state: 'none' }, undefined]);

		// the scan parses the three source files. the progress starts with 0 and ends with all source files
		const first = await scan();
		assert.deepEqual([first.units, first.scanned, first.isComplete, first.failed], [3, 3, true, []]);
		assert.deepEqual(first.frames.map((f) => `${f.name}: ${f.reason}`).sort(),
			['View::paintEvent: override of QWidget::paintEvent', 'frame: called in the main loop of main']);
		const progress = own.notifications.filter((n) => n.method === 'dataflow/progress' && n.params.id === first.id).map((n) => n.params);
		assert.deepEqual([progress[0], progress.at(-1)], [{ id: first.id, done: 0, total: 3 }, { id: first.id, done: 3, total: 3 }]);

		// draw has callers in main.cpp, render.cpp and view.cpp. its own file does not count. the override of paintEvent
		// calls it. draw calls shade in a loop on the frame path. a virtual call goes to the overrides of Pass::run
		const [state, fns] = await reach(render);
		assert.deepEqual(state, { state: 'ready' });
		const qt = 'override of QWidget::paintEvent';
		const loop = 'called in the main loop of main';
		assert.deepEqual(fns.draw, { callers: 3, transitiveCallers: 4, callerFiles: 2, frame: { reason: qt, path: ['View::paintEvent'], isInLoop: false, calls: 1 } });
		assert.deepEqual(fns.shade, { callers: 2, transitiveCallers: 6, callerFiles: 2, frame: { reason: qt, path: ['View::paintEvent', 'draw'], isInLoop: true, calls: 2 } });
		assert.deepEqual(fns['Blur::run'], { callers: 1, transitiveCallers: 2, callerFiles: 1, frame: { reason: loop, path: ['frame'], isInLoop: false, calls: 1 } });
		assert.deepEqual(fns['Glow::run'], { callers: 1, transitiveCallers: 2, callerFiles: 1, frame: { reason: loop, path: ['frame'], isInLoop: false, calls: 1 } });

		// main calls setup before the loop, and report in a loop that empties a queue. a frame function of the setting starts
		// a frame path
		const [, mains] = await reach(main);
		assert.deepEqual([mains.main, mains.setup, mains.report], [{ callers: 0, transitiveCallers: 0, callerFiles: 0 }, { callers: 1, transitiveCallers: 1, callerFiles: 0 }, { callers: 1, transitiveCallers: 1, callerFiles: 0 }]);
		assert.deepEqual(mains.frame, { callers: 1, transitiveCallers: 1, callerFiles: 0, frame: { reason: loop, path: [], isInLoop: false, calls: 0 } });
		const [, named] = await reach(main, ['setup']);
		assert.deepEqual(named.setup.frame, { reason: 'frame function of the setting', path: [], isInLoop: false, calls: 0 });

		// the instantiations of a template are one node. the functions of the header come from one of the three source
		// files
		const [, views] = await reach(view);
		assert.deepEqual([views.twice, views.lonely], [{ callers: 2, transitiveCallers: 2, callerFiles: 0 }, { callers: 0, transitiveCallers: 0, callerFiles: 0 }]);
		assert.deepEqual(views['View::paintEvent'], { callers: 0, transitiveCallers: 0, callerFiles: 0, frame: { reason: qt, path: [], isInLoop: false, calls: 0 } });
		const [, headers] = await reach(header);
		assert.deepEqual(headers.helper,
			{ callers: 2, transitiveCallers: 8, callerFiles: 3, frame: { reason: qt, path: ['View::paintEvent', 'draw', 'shade'], isInLoop: false, calls: 3 } });
		// no source file includes unused.h, thus its function has no callers
		assert.deepEqual((await reach(unused))[1].unused, { callers: 0, transitiveCallers: 0, callerFiles: 0 });

		// with no change, the next scan parses nothing
		assert.equal((await scan()).scanned, 0);

		// an open file with a new text: only its source file
		viewLines[5] = '  void paintEvent(void* e) override { draw(Mesh{1}); lonely(1); }';
		own.notify('textDocument/didOpen', { file: view, text: viewLines.join('\n') + '\n', version: 1 });
		assert.equal((await scan()).scanned, 1);
		assert.deepEqual((await reach(view))[1].lonely,
			{ callers: 1, transitiveCallers: 1, callerFiles: 0, frame: { reason: qt, path: ['View::paintEvent'], isInLoop: false, calls: 1 } });

		// a change of the header on disk: the three source files that include it
		write('include/render.h', [...renderLines, 'inline int extra() { return shade(2); }']);
		assert.equal((await scan()).scanned, 3);
		assert.equal((await reach(render))[1].shade.callers, 3);

		// a closed file with a text that is not on disk
		own.notify('textDocument/didClose', { file: view });
		assert.equal((await scan()).scanned, 1);
		assert.deepEqual((await reach(view))[1].lonely, { callers: 0, transitiveCallers: 0, callerFiles: 0 });
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('call graph: the scan skips the folder of a compile database in the project folder, for example the fetched libraries', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-graph-build-'));
	const write = (name, lines) => {
		const file = path.join(dir, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, lines.join('\n') + '\n');
		return file;
	};
	const app = write('src/app.cpp', ['#include "dep.h"', 'int app() { return dep(); }']);
	write('build/_deps/dep/dep.h', ['#pragma once', 'inline int dep() { return 1; }']);
	const lib = write('build/_deps/dep/dep.cpp', ['#include "dep.h"', 'int other() { return dep(); }']);
	const build = path.join(dir, 'build');
	const db = path.join(build, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([app, lib].map((file) =>
		({ directory: build, file, arguments: ['clang++', '-std=c++20', `-I${path.join(build, '_deps', 'dep')}`, '-c', file] }))));
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		assert.equal((await own.send('initialize', { compileCommands: [db], maxThreads: 2, cacheSize: 2 })).error, undefined);
		// only app.cpp is a source file of the project, and app() is the only function. A call into the build folder is no
		// edge
		const res = await own.send('dataflow/callGraph', { roots: [dir] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.deepEqual([res.result.units, res.result.scanned, res.result.functions, res.result.calls], [1, 1, 1, 0]);

		// the include reach of the heat counts only the source files of the project
		const includers = await own.send('dataflow/includers', { file: path.join(build, '_deps', 'dep', 'dep.h'), roots: [dir] });
		const r = includers.result;
		assert.deepEqual([r.units.length, r.unitCount, r.projectIncluders, r.projectUnits], [2, 2, 1, 1]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('call graph: one scan at a time, and a stop keeps the parsed source files for the next scan', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-graph-stop-'));
	const write = (name, lines) => {
		const file = path.join(dir, name);
		writeFileSync(file, lines.join('\n') + '\n');
		return file;
	};
	// the headers of the standard library make each parse slow enough for a stop during the scan
	const heavy = ['#include <algorithm>', '#include <map>', '#include <regex>', '#include <string>', '#include <vector>'];
	const units = [0, 1, 2, 3, 4, 5].map((i) =>
		write(`unit${i}.cpp`, [...heavy, `int unit${i}() { std::vector<int> v{3, 1, 2}; std::sort(v.begin(), v.end()); return v[0]; }`]));
	const tiny = write('tiny.cpp', ['int tiny() { return 1; }']);
	const db = path.join(dir, 'compile_commands.json');
	writeFileSync(db, JSON.stringify([...units, tiny].map((file) => ({ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }))));
	// two threads: the scan uses one of them, and the metrics use the other
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		assert.equal((await own.send('initialize', { compileCommands: [db], maxThreads: 2, cacheSize: 2 })).error, undefined);
		const metrics = async () => {
			const res = await own.send('dataflow/metrics', { file: tiny });
			assert.equal(res.error, undefined, JSON.stringify(res.error));
			return res.result;
		};
		const first = own.request('dataflow/callGraph', { roots: [dir] });
		const busy = await own.send('dataflow/callGraph', { roots: [dir] });
		assert.match(busy.error?.message ?? '', /a scan of the call graph runs/);

		// a stop after the first source file
		let scanning;
		do {
			scanning = (await metrics()).callGraph;
		} while (scanning.state === 'scanning' && scanning.done < 1);
		assert.deepEqual([scanning.state, scanning.total], ['scanning', 7]);
		own.notify('$/cancelRequest', { id: first.id });
		assert.equal((await first.reply).error?.code, -32800);

		// a partial graph gives no reach
		const partial = await metrics();
		assert.deepEqual([partial.callGraph, partial.functions[0].reach], [{ state: 'partial' }, undefined]);

		// the next scan parses only the source files that the stopped scan did not parse
		const next = await own.send('dataflow/callGraph', { roots: [dir] });
		assert.equal(next.error, undefined, JSON.stringify(next.error));
		assert.ok(next.result.isComplete && next.result.scanned > 0 && next.result.scanned < 7, JSON.stringify(next.result));
		const ready = await metrics();
		assert.deepEqual([ready.callGraph, ready.functions[0].reach], [{ state: 'ready' }, { callers: 0, transitiveCallers: 0, callerFiles: 0 }]);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('call graph: callers that the graph cannot see, qt connections, a long frame path, the tests, and the callers of a function', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-graph-unknown-'));
	const write = (name, lines) => {
		const file = path.join(dir, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, lines.join('\n') + '\n');
		return file;
	};
	// a small copy of the declarations of qt, out of the project folders
	write('lib/QObject.h', [
		'#pragma once',
		'#define slots',
		'#define signals public',
		'#define emit',
		'class QObject {',
		' public:',
		'  virtual ~QObject() = default;',
		'  template <class S, class R> static bool connect(const QObject*, S, const QObject*, R) { return true; }',
		'  virtual bool event(void* e) { return e != nullptr; }',
		'};',
		'class QPushButton : public QObject {',
		' signals:',
		'  void clicked();',
		'};',
	]);
	write('include/panel.h', [
		'#pragma once',
		'#include <QObject.h>',
		'class Panel : public QObject {',
		' public:',
		'  void build();',
		'  void refresh();',
		'  bool event(void* e) override;',
		' signals:',
		'  void changed();',
		' public slots:',
		'  void onChanged();',
		'  void onClicked();',
		'  void onTimer();',
		'};',
	]);
	const chain = Array.from({ length: 10 }, (_, i) => i + 1).reverse()
		.map((i) => (i === 10 ? 'void c10() {}' : `void c${i}() { c${i + 1}(); }`));
	const panelLines = [
		'#include "panel.h"',
		'static void tick() {}',
		'static void (*handlers[])() = {&tick};',
		'void Panel::build() {',
		'  QPushButton* button = nullptr;',
		'  connect(this, &Panel::changed, this, &Panel::onChanged);',
		'  connect(button, &QPushButton::clicked, this, &Panel::onClicked);',
		'}',
		'void Panel::refresh() { emit changed(); }',
		'bool Panel::event(void* e) { return QObject::event(e); }',
		'void Panel::onChanged() {}',
		'void Panel::onClicked() {}',
		'void Panel::onTimer() {}',
		'void callback() {}',
		'void install() { void (*f)() = callback; f(); }',
		...chain,
		'int main() {',
		'  bool running = handlers[0] != nullptr;',
		'  Panel p;',
		'  while (running) { c1(); p.refresh(); install(); }',
		'  return 0;',
		'}',
	];
	const panel = write('src/panel.cpp', panelLines);
	const test = write('tests/test_panel.cpp', ['#include "panel.h"', 'void test_refresh() { Panel p; p.refresh(); }']);
	const db = path.join(dir, 'compile_commands.json');
	const args = (file) => ['clang++', '-std=c++20', `-I${path.join(dir, 'include')}`, `-I${path.join(dir, 'lib')}`, '-c', file];
	writeFileSync(db, JSON.stringify([panel, test].map((file) => ({ directory: dir, file, arguments: args(file) }))));
	const roots = [path.join(dir, 'include'), path.join(dir, 'src'), path.join(dir, 'tests')];
	const line = (text) => panelLines.findIndex((l) => l.includes(text)) + 1;
	const own = startEngine(env('DATAFLOW_ENGINE'));
	try {
		assert.equal((await own.send('initialize', { compileCommands: [db], maxThreads: 4, cacheSize: 4 })).error, undefined);
		const scan = await own.send('dataflow/callGraph', { roots });
		assert.equal(scan.error, undefined, JSON.stringify(scan.error));
		assert.deepEqual([scan.result.units, scan.result.isComplete, scan.result.failed], [2, true, []]);
		const res = await own.send('dataflow/metrics', { file: panel, testFolders: ['tests'] });
		assert.equal(res.error, undefined, JSON.stringify(res.error));
		assert.equal(res.result.errorCount, 0, res.result.errors.join('\n'));
		const fns = Object.fromEntries(res.result.functions.map((f) => [f.qualifiedName, f.reach]));
		const unknown = (name) => {
			const u = fns[name].unknownCallers;
			return u && [u.cause, u.via, path.basename(u.file), u.line];
		};

		// the address in a table of a global variable and in a body, an override of a library, a slot of a signal of a
		// library, and a slot with no caller
		assert.deepEqual(unknown('tick'), ['address', 'a global variable', 'panel.cpp', line('static void (*handlers')]);
		assert.deepEqual(unknown('callback'), ['address', 'install', 'panel.cpp', line('void install()')]);
		assert.deepEqual(unknown('Panel::event'), ['libraryOverride', 'QObject::event', 'panel.cpp', line('bool Panel::event')]);
		assert.deepEqual(unknown('Panel::onClicked'), ['slot', 'the signal QPushButton::clicked', 'panel.cpp', line('&QPushButton::clicked')]);
		assert.deepEqual(unknown('Panel::onTimer'), ['slot', 'a slots section', 'panel.cpp', line('void Panel::onTimer')]);
		// a call that the graph sees: no cause
		assert.deepEqual([unknown('install'), unknown('c5')], [undefined, undefined]);

		// a connection to a signal of the project: the signal has a node with no body, and its emitters reach the slot. the
		// slot is on the frame path of the emitter
		const onChanged = fns['Panel::onChanged'];
		assert.equal(onChanged.unknownCallers, undefined);
		assert.deepEqual([onChanged.callers, onChanged.transitiveCallers], [1, 4]);
		assert.deepEqual(onChanged.frame, { reason: 'called in the main loop of main', path: ['Panel::refresh', 'Panel::changed'], isInLoop: false, calls: 2 });
		const tests = (reach) => reach.tests && [reach.tests.functions, reach.tests.files.map((x) => path.basename(x))];
		assert.deepEqual(tests(onChanged), [1, ['test_panel.cpp']]);

		// the frame path goes past the limit of 8 calls
		assert.deepEqual([fns.c9.frame.calls, fns.c9.frame.isPastLimit, fns.c10.frame.calls, fns.c10.frame.isPastLimit], [8, undefined, 9, true]);
		assert.deepEqual(tests(fns['Panel::refresh']), [1, ['test_panel.cpp']]);
		assert.deepEqual(tests(fns.c3), [0, []]);

		// the callers of a function up to a depth, with the lines of their calls, and its frame paths
		const callers = await own.send('dataflow/callers', { file: panel, function: 'Panel::onChanged', depth: 2 });
		assert.equal(callers.error, undefined, JSON.stringify(callers.error));
		const r = callers.result;
		assert.deepEqual(r.callers.map((c) => [c.name, c.depth, c.calls, c.lines, !!c.isSignal, !!c.isConnection]), [
			['Panel::changed', 1, 'Panel::onChanged', [line('&Panel::onChanged')], true, true],
			['Panel::refresh', 2, 'Panel::changed', [line('void Panel::refresh')], false, false],
		]);
		assert.deepEqual(r.framePaths, [{ reason: 'called in the main loop of main', calls: 2, path: ['Panel::refresh', 'Panel::changed', 'Panel::onChanged'] }]);
		assert.equal(r.callGraph.state, 'ready');
		const deep = await own.send('dataflow/callers', { file: panel, function: 'Panel::onChanged', depth: 5 });
		assert.deepEqual(deep.result.callers.map((c) => c.name).sort(), ['Panel::changed', 'Panel::refresh', 'main', 'test_refresh']);
	} finally {
		await own.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('sends status notifications', () => {
	const states = engine.notifications.filter((n) => n.method === 'dataflow/status').map((n) => n.params.state);
	assert.ok(states.includes('parsing') && states.includes('ready'), states.join(','));
});
