import * as path from 'path';

// The requests that stopped the engine with a crash. A request that stops the engine on a file stops each new engine
// again, because the side view sends the request again after the restart. After 3 restarts the engine stays off, and
// all lenses stop for all files. Thus the client does not send such a request again. A new engine client, for example
// after "DataFlow: Restart Engine", tries all requests again.
// > When a crash stops the engine in a request, the engine writes "the engine stopped in request <id>" to stderr. That
//   request is blocked at once.
// > With no such line, each request with a file that was in flight is a suspect. A suspect that is in flight at a
//   second stop is blocked. A reply of the engine to the request clears the suspect.
// > When 2 requests of a file are blocked, all requests of the file are blocked. For example, a crash in the parse of a
//   file stops each request of the file.

// A request to the engine. A request for a different function of the same file is a different request
export interface EngineRequest {
	method: string;
	file?: string;
	fn?: string; // the name of the function, for example of dataflow/flow
}

// What the client learned from a stop of the engine
export interface EngineStop {
	culprit?: EngineRequest; // the request of the stop line of the engine
	inFlight: EngineRequest[]; // the requests in flight at the stop
	blocked: EngineRequest[]; // the requests that are blocked now
	blockedFiles: string[]; // the files that are blocked now
}

// After this time with no stop, the count of the restarts starts again
export const STABLE_MS = 5 * 60 * 1000;

const STOP_LINE = /the engine stopped in request (\d+)/g;

// The lens of a method, for the messages to the user
const LENSES: Record<string, string> = {
	'dataflow/flow': 'Flow Lens',
	'dataflow/member': 'Flow Lens',
	'dataflow/logic': 'Logic Map',
	'dataflow/cost': 'Hidden C++',
	'dataflow/calls': 'Call Hierarchy',
	'dataflow/threads': 'Threads',
	'dataflow/includes': 'Include Hierarchy',
	'dataflow/includers': 'Include Hierarchy',
	'dataflow/checkForward': 'Include Hierarchy',
	'dataflow/metrics': 'Heat',
	'dataflow/memberMetrics': 'Heat',
	'dataflow/callers': 'Heat',
	'dataflow/callGraph': 'Heat',
	'dataflow/slice': 'Change Ripple',
};

// The request of a method and its params: the file, and the name of the function if the params have one
export function requestOf(method: string, params: unknown): EngineRequest {
	const p = (params ?? {}) as { file?: unknown; function?: unknown };
	return {
		method,
		...(typeof p.file === 'string' ? { file: p.file } : {}),
		...(typeof p.function === 'string' ? { fn: p.function } : {}),
	};
}

// A request for the log and the messages, for example "Hidden C++ (dataflow/cost) of main.cpp"
export function describeRequest(r: EngineRequest): string {
	const lens = LENSES[r.method];
	const what = lens ? `${lens} (${r.method})` : r.method;
	const fn = r.fn ? ` for ${r.fn}` : '';
	return r.file ? `${what}${fn} of ${path.basename(r.file)}` : what;
}

export function requestBlockMessage(r: EngineRequest): string {
	return `The engine stopped on ${describeRequest(r)}, so DataFlow does not send this request again. `
		+ 'Run "DataFlow: Restart Engine" to try again.';
}

export function fileBlockMessage(file: string): string {
	return `The engine stopped on 2 requests for ${path.basename(file)}, so DataFlow does not send requests for this file `
		+ 'again. Run "DataFlow: Restart Engine" to try again.';
}

// The count of the restarts before a new restart. It starts again after the engine ran for STABLE_MS with no stop.
// readyAt: the time when the engine got ready, or undefined
export function restartsBefore(restarts: number, readyAt: number | undefined, now: number): number {
	return readyAt !== undefined && now - readyAt >= STABLE_MS ? 0 : restarts;
}

export class CrashMemory {
	private readonly inFlight = new Map<number, EngineRequest>();
	private readonly suspects = new Set<string>();
	private readonly blocked = new Map<string, EngineRequest>();
	private readonly blockedFiles = new Set<string>();
	private stderrTail = '';

	// fileKey: the key of a path, for example with no case on Windows
	constructor(private readonly fileKey: (file: string) => string) {}

	// The reason why the client does not send the request, or undefined
	reasonToSkip(r: EngineRequest): string | undefined {
		if (r.file && this.blockedFiles.has(this.fileKey(r.file))) {
			return fileBlockMessage(r.file);
		}
		return this.blocked.has(this.keyOf(r)) ? requestBlockMessage(r) : undefined;
	}

	// The client sent the request with this id
	begin(id: number, r: EngineRequest): void {
		this.inFlight.set(id, r);
	}

	// The engine replied to the request with this id. The request did not stop the engine, so it is no suspect
	end(id: number): void {
		const r = this.inFlight.get(id);
		if (r) {
			this.inFlight.delete(id);
			this.suspects.delete(this.keyOf(r));
		}
	}

	// Text on stderr of the engine. The stop line can come in two pieces
	onStderr(text: string): void {
		this.stderrTail = (this.stderrTail + text).slice(-1024);
	}

	// The engine stopped. Blocks the request of the stop line, else the suspects that were also in flight at an earlier
	// stop. The requests in flight end
	onStop(): EngineStop {
		const lines = [...this.stderrTail.matchAll(STOP_LINE)];
		const id = lines.length > 0 ? Number(lines[lines.length - 1][1]) : undefined;
		const culprit = id !== undefined ? this.inFlight.get(id) : undefined;
		const inFlight = [...this.inFlight.values()];
		this.inFlight.clear();
		this.stderrTail = '';

		const blocked: EngineRequest[] = [];
		const block = (r: EngineRequest): void => {
			const key = this.keyOf(r);
			if (!this.blocked.has(key)) {
				this.blocked.set(key, r);
				blocked.push(r);
			}
		};
		if (culprit) {
			block(culprit);
		} else {
			for (const r of inFlight.filter((f) => f.file)) {
				const key = this.keyOf(r);
				if (this.suspects.has(key)) {
					block(r);
				} else {
					this.suspects.add(key);
				}
			}
		}

		// 2 blocked requests of a file block the file
		const blockedFiles: string[] = [];
		for (const r of blocked) {
			const key = r.file ? this.fileKey(r.file) : undefined;
			if (!r.file || !key || this.blockedFiles.has(key)) {
				continue;
			}
			const count = [...this.blocked.values()].filter((b) => b.file && this.fileKey(b.file) === key).length;
			if (count >= 2) {
				this.blockedFiles.add(key);
				blockedFiles.push(r.file);
			}
		}
		return { culprit, inFlight, blocked, blockedFiles };
	}

	private keyOf(r: EngineRequest): string {
		return [r.method, r.file ? this.fileKey(r.file) : '', r.fn ?? ''].join('\n');
	}
}
