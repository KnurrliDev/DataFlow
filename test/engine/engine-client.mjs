// A small JSON-RPC client for dataflow-engine, for the engine tests.
import { spawn } from 'node:child_process';

export function startEngine(exe) {
	const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
	const waiters = new Map();
	const notifications = [];
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
			if (msg.id === undefined) {
				notifications.push(msg);
			} else {
				waiters.get(msg.id)?.(msg);
				waiters.delete(msg.id);
			}
		}
	});

	const write = (msg) => {
		const body = Buffer.from(JSON.stringify(msg));
		proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		proc.stdin.write(body);
	};
	// sends a request. the result has the id, so that a test can cancel the request
	const request = (method, params) => {
		const id = ++nextId;
		const reply = new Promise((resolve) => waiters.set(id, resolve));
		write({ jsonrpc: '2.0', id, method, params });
		return { id, reply };
	};
	const send = (method, params) => request(method, params).reply;
	const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
	const close = async () => {
		await send('shutdown', null);
		notify('exit', null);
		await new Promise((resolve) => (proc.exitCode !== null ? resolve() : proc.on('exit', resolve)));
	};
	return { send, request, notify, close, notifications, getStderr: () => stderr, proc };
}
