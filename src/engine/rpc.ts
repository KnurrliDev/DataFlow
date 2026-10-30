import { ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';

// JSON-RPC 2.0 over the stdio of a child process, with the message headers of LSP.

export const REQUEST_CANCELLED = -32800;

export class RpcRequestError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface RpcNotification {
	method: string;
	params: unknown;
}

export class RpcConnection implements vscode.Disposable {
	private buffer = Buffer.alloc(0);
	private nextId = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly notificationEmitter = new vscode.EventEmitter<RpcNotification>();
	readonly onNotification = this.notificationEmitter.event;

	constructor(private readonly proc: ChildProcessWithoutNullStreams) {
		proc.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
		// A write to a stopped process gives an EPIPE error. The exit handler rejects the requests.
		proc.stdin.on('error', () => undefined);
		proc.on('exit', () => this.rejectAll(new Error('The engine stopped.')));
	}

	request<T>(method: string, params: unknown, token?: vscode.CancellationToken): Promise<T> {
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.write({ jsonrpc: '2.0', id, method, params });
			token?.onCancellationRequested(() => this.notify('$/cancelRequest', { id }));
		});
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: '2.0', method, params });
	}

	dispose(): void {
		this.rejectAll(new Error('The connection to the engine is closed.'));
		this.notificationEmitter.dispose();
	}

	private write(message: object): void {
		if (!this.proc.stdin.writable) {
			return;
		}
		const body = Buffer.from(JSON.stringify(message), 'utf8');
		this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		this.proc.stdin.write(body);
	}

	// Reads all complete messages from the buffer. A message can arrive in more than one chunk.
	private receive(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const separator = this.buffer.indexOf('\r\n\r\n');
			if (separator < 0) {
				return;
			}
			const header = this.buffer.subarray(0, separator).toString('ascii');
			const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? NaN);
			if (Number.isNaN(length)) {
				// A bad header. Skip it, so that the next message can still arrive.
				this.buffer = this.buffer.subarray(separator + 4);
				continue;
			}
			if (this.buffer.length < separator + 4 + length) {
				return;
			}
			const body = this.buffer.subarray(separator + 4, separator + 4 + length).toString('utf8');
			this.buffer = this.buffer.subarray(separator + 4 + length);
			this.dispatch(JSON.parse(body));
		}
	}

	private dispatch(message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }): void {
		if (message.id === undefined) {
			if (message.method) {
				this.notificationEmitter.fire({ method: message.method, params: message.params });
			}
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) {
			return;
		}
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new RpcRequestError(message.error.code, message.error.message));
		} else {
			pending.resolve(message.result);
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}
