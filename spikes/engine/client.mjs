// Spike P0 (b) and (c) client.
// Starts dataflow-engine, sends JSON-RPC requests over stdio, and prints a summary.
// Usage: node spikes/engine/client.mjs <engine exe> <llvm root> <cmake db> <qmake db> <output json>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [engineExe, llvmRoot, cmakeDb, qmakeDb, outFile] = process.argv.slice(2);
const repo = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(repo, 'test/fixtures/battery/src/battery.cpp');
const fixtureHeader = path.join(repo, 'test/fixtures/battery/include/battery/types.hpp');
const qtFile = path.join(repo, 'test/fixtures/battery-qmake/battery_qt.cpp');
const resourceDir = path.join(llvmRoot, 'lib/clang/23');

function startEngine() {
	const proc = spawn(engineExe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
	const waiters = new Map();
	let buf = Buffer.alloc(0);
	let nextId = 0;
	let stderr = '';
	proc.stderr.on('data', (d) => { stderr += d; });
	proc.stdout.on('data', (d) => {
		buf = Buffer.concat([buf, d]);
		while (true) {
			const sep = buf.indexOf('\r\n\r\n');
			if (sep < 0) { break; }
			const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, sep).toString())[1]);
			if (buf.length < sep + 4 + len) { break; }
			const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
			buf = buf.subarray(sep + 4 + len);
			waiters.get(msg.id)?.(msg);
			waiters.delete(msg.id);
		}
	});
	const send = (method, params, notify = false) => {
		const msg = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++nextId, method, params };
		const body = Buffer.from(JSON.stringify(msg));
		proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		proc.stdin.write(body);
		return notify ? Promise.resolve() : new Promise((resolve) => waiters.set(msg.id, resolve));
	};
	const close = async () => {
		await send('shutdown', null);
		await send('exit', null, true);
		await new Promise((resolve) => proc.on('exit', resolve));
	};
	return { send, close, getStderr: () => stderr };
}

const base = (r) => r.error ? { error: r.error.message } : {
	function: r.result.function, parseMs: Math.round(r.result.parseMs), analysisMs: Math.round(r.result.analysisMs),
	errorCount: r.result.errorCount, errors: r.result.errors,
};
const cfgSummary = (r) => r.error ? base(r) : {
	...base(r),
	blocks: r.result.cfg.blocks.length,
	branches: r.result.cfg.blocks.filter((b) => b.terminator?.cond).map((b) =>
		`${b.terminator.stmt} @${b.terminator.range.begin.line}: (${b.terminator.cond}) -> ${b.succs.map((s) => `${s.label || 'next'}:B${s.block}`).join(', ')}`),
	dtors: r.result.cfg.blocks.flatMap((b) => b.elements.filter((e) => e.kind === 'dtor').map((e) => `~${e.var} @${e.at.line}`)),
};
const optSummary = (r) => r.error ? base(r) : {
	...base(r), unchecked: r.result.unchecked.map((u) => `line ${u.range.begin.line}:${u.range.begin.col}  ${u.text}`),
};

const full = {};
const summary = {};
for (const [name, db, requests] of [
	['cmake', cmakeDb, [
		['cfg initial_power', 'dataflow/cfg', fixture, 'initial_power', cfgSummary],
		['optional initial_power', 'dataflow/optionalAccess', fixture, 'initial_power', optSummary],
		['optional solve_power_plan', 'dataflow/optionalAccess', fixture, 'solve_power_plan', optSummary],
		['cfg header charge::isValidKw', 'dataflow/cfg', fixtureHeader, 'charge::isValidKw', cfgSummary],
	]],
	['qmake', qmakeDb, [
		['optional describe (Qt)', 'dataflow/optionalAccess', qtFile, 'describe', optSummary],
		['cfg describe (Qt)', 'dataflow/cfg', qtFile, 'describe', cfgSummary],
		['optional initial_power', 'dataflow/optionalAccess', fixture, 'initial_power', optSummary],
	]],
]) {
	const engine = startEngine();
	const init = await engine.send('initialize', { compileCommands: db, resourceDir });
	summary[name] = { initialize: init.error ? init.error.message : init.result };
	for (const [label, method, file, fn, summarize] of requests) {
		const res = await engine.send(method, { file, function: fn });
		full[`${name}: ${label}`] = res;
		summary[name][label] = summarize(res);
	}
	await engine.close();
	summary[name].stderr = engine.getStderr().slice(0, 400);
}
writeFileSync(outFile, JSON.stringify(full, null, 2));
console.log(JSON.stringify(summary, null, 2));
