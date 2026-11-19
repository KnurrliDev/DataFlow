import * as assert from 'assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { EngineBlock, EngineClient } from '../../engine/client';

// The engine client with an engine that stops on purpose. DATAFLOW_TEST_CRASH gives the method that stops the engine,
// or * for all methods, and DATAFLOW_TEST_CRASH_FILE the file. The engine names the request of the crash on stderr

const ENGINE = path.resolve(__dirname, '../../../build/engine', process.platform === 'win32' ? 'dataflow-engine.exe' : 'dataflow-engine');

suite('The engine client after a crash of the engine', () => {
	let dir: string;
	let client: EngineClient | undefined;
	let blocks: EngineBlock[];
	let lines: string[];
	const saved = { method: process.env.DATAFLOW_TEST_CRASH, file: process.env.DATAFLOW_TEST_CRASH_FILE };

	setup(function () {
		if (!existsSync(ENGINE)) {
			this.skip();
		}
		dir = mkdtempSync(path.join(os.tmpdir(), 'dataflow-client-crash-'));
		blocks = [];
		lines = [];
	});

	teardown(async () => {
		await client?.stop();
		client?.dispose();
		client = undefined;
		for (const [name, value] of [['DATAFLOW_TEST_CRASH', saved.method], ['DATAFLOW_TEST_CRASH_FILE', saved.file]] as const) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		rmSync(dir, { recursive: true, force: true });
	});

	// starts a client with an engine that stops in the method on a.cpp. b.cpp never stops the engine
	const start = async (method: string): Promise<{ client: EngineClient; a: string; b: string }> => {
		const a = path.join(dir, 'a.cpp');
		const b = path.join(dir, 'b.cpp');
		writeFileSync(a, 'struct S { int v_ = 0; };\nint df_a(S s) { return s.v_; }\n');
		writeFileSync(b, 'int df_b() { return 2; }\n');
		const db = path.join(dir, 'compile_commands.json');
		writeFileSync(db, JSON.stringify([a, b].map((file) => ({ directory: dir, file, arguments: ['clang++', '-std=c++20', '-c', file] }))));
		// each start of the engine reads the environment, also a restart after a crash
		process.env.DATAFLOW_TEST_CRASH = method;
		process.env.DATAFLOW_TEST_CRASH_FILE = 'a.cpp';
		const record = (level: string) => (message: string) => lines.push(`${level} ${message}`);
		const log = { trace: record('trace'), debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
		const c = new EngineClient({ enginePath: ENGINE, compileCommands: [db], maxThreads: 2, cacheSize: 2, log: log as unknown as vscode.LogOutputChannel });
		client = c;
		c.onDidBlock((block) => blocks.push(block));
		await c.start();
		return { client: c, a, b };
	};

	// the next state ready, after the restart of a crash
	const ready = (c: EngineClient): Promise<void> => new Promise((resolve) => {
		const sub = c.onDidChangeState((state) => {
			if (state === 'ready') {
				sub.dispose();
				resolve();
			}
		});
	});

	const outcome = (run: Promise<unknown>): Promise<string> => run.then(() => 'ok', (error: Error) => error.message);

	test('a crash in one request blocks that request. The other requests and the other files still work', async () => {
		const { client: c, a, b } = await start('dataflow/cost');
		assert.equal(await outcome(c.functions(a)), 'ok');
		const restarted = ready(c);
		assert.equal(await outcome(c.cost(a, 16)), 'The engine stopped.');
		await restarted;

		// the client does not send the request again, so the engine does not stop again
		assert.match(await outcome(c.cost(a, 16)), /^The engine stopped on Hidden C\+\+ \(dataflow\/cost\) of a\.cpp, so DataFlow does not send this request again/);
		assert.equal(await outcome(c.functions(a)), 'ok');
		assert.equal(await outcome(c.cost(b, 16)), 'ok');
		assert.equal(c.currentState, 'ready');
		assert.deepEqual(blocks.map((block) => [block.request?.method, block.file]), [['dataflow/cost', undefined]]);
		assert.ok(lines.includes('error The engine stopped in Hidden C++ (dataflow/cost) of a.cpp.'), lines.join('\n'));
		assert.deepEqual(lines.filter((l) => l.startsWith('info Restart')), ['info Restart 1 of 3.']);
	});

	test('a crash in each request of a file blocks the file after 2 stops', async () => {
		const { client: c, a, b } = await start('*');
		let restarted = ready(c);
		assert.equal(await outcome(c.functions(a)), 'The engine stopped.');
		await restarted;
		restarted = ready(c);
		assert.equal(await outcome(c.cost(a, 16)), 'The engine stopped.');
		await restarted;

		// a third request for the file does not go to the engine
		assert.match(await outcome(c.flow(a, { function: 'df_a' }, {})), /^The engine stopped on 2 requests for a\.cpp, so DataFlow does not send requests for this file again/);
		assert.equal(await outcome(c.functions(b)), 'ok');
		assert.equal(c.currentState, 'ready');
		// one message for the first request, then one message for the file
		assert.deepEqual(blocks.map((block) => [block.request?.method, block.file && path.basename(block.file)]),
			[['dataflow/functions', undefined], [undefined, 'a.cpp']]);
	});
});
