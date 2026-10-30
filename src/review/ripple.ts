import type { EngineFunction, SliceBody, SliceConfidence, SliceModel, SliceSeed } from '../engine/client';

// The ripple pipeline of Change Ripple. The engine slices each changed function. For a return value, the pipeline
// finds the callers and asks the engine to continue the slice from each call, up to the maximum depth.

// A call of a function: the file and the position of the called name. Lines start at 1. Columns are UTF-8 bytes,
// as in the engine.
export interface CallSite {
	file: string;
	line: number;
	col: number;
}

// One body of the ripple: the slice of a function or of a lambda
export interface RippleBody {
	file: string;
	depth: number; // 0 for the changed function, 1 for its callers, 2 for their callers
	offset: number; // the step of the wave at the distance 0 of the body
	body: SliceBody;
	from?: number; // the index of the body whose return value leads to this caller
	call?: CallSite; // the call in the caller. The bodies of one call have the same call
}

// The ripple of the changed lines of one function
export interface RippleChange {
	file: string;
	fn: EngineFunction;
	lines: number[];
	bodies: RippleBody[];
}

export interface RippleModel {
	changes: RippleChange[];
	other: { file: string; outside: number[]; quiet: number[] }[]; // changed lines with no statement in a function
	isCallHierarchyMissing: boolean; // no call hierarchy provider answered, so only the callers in the same file count
	errors: string[];
}

// The engine and the call hierarchy of VS Code. The unit tests give fakes.
export interface RippleServices {
	slice(file: string, seed: SliceSeed, confidence: SliceConfidence): Promise<SliceModel>;
	// the callers from the call hierarchy of the editor, or undefined if no provider answers
	callers(file: string, fn: EngineFunction): Promise<CallSite[] | undefined>;
	maxDepth: number;
	// the number of changed files that the ripple works on at the same time. The engine parses the files in parallel.
	// Each file needs its parse until its ripple is complete, so the number must be less than the parses that the
	// engine keeps. The default is 1
	concurrency?: number;
}

export interface ChangedFile {
	file: string;
	lines: number[];
	deleted: { line: number; text: string }[];
}

// The key of a function. The first line keeps overloads apart.
export const functionKey = (file: string, fn: EngineFunction) => `${file}#${fn.qualifiedName}#${fn.range.begin.line}`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The files go to `concurrency` workers. The result has the sequence of the files, as with one worker
export async function runRipple(files: ChangedFile[], services: RippleServices): Promise<RippleModel> {
	// the call hierarchy of the editor answers one request at a time, so the workers ask one after the other
	let queue: Promise<unknown> = Promise.resolve();
	const serial: RippleServices = {
		...services,
		callers: (file, fn) => {
			const answer = queue.then(() => services.callers(file, fn));
			queue = answer.catch(() => undefined);
			return answer;
		},
	};

	const parts: RippleModel[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let i = next++; i < files.length; i = next++) {
			parts[i] = await rippleOfFile(files[i], serial);
		}
	};
	const count = Math.max(1, Math.min(services.concurrency ?? 1, files.length));
	await Promise.all(Array.from({ length: count }, worker));

	const model: RippleModel = { changes: [], other: [], isCallHierarchyMissing: false, errors: [] };
	for (const part of parts) {
		model.changes.push(...part.changes);
		model.other.push(...part.other);
		model.errors.push(...part.errors);
		model.isCallHierarchyMissing ||= part.isCallHierarchyMissing;
	}
	return model;
}

// The ripple of the changes of one file
async function rippleOfFile(f: ChangedFile, services: RippleServices): Promise<RippleModel> {
	const model: RippleModel = { changes: [], other: [], isCallHierarchyMissing: false, errors: [] };
	let slice: SliceModel;
	try {
		slice = await services.slice(f.file, { lines: f.lines, deleted: f.deleted }, 'exact');
	} catch (error) {
		model.errors.push(`${f.file}: ${messageOf(error)}`);
		return model;
	}
	if (slice.outside.length > 0 || slice.quiet.length > 0) {
		model.other.push({ file: f.file, outside: slice.outside, quiet: slice.quiet });
	}

	// The bodies of one function are one change: the function and its lambdas
	const changes = new Map<string, RippleChange>();
	for (const body of slice.bodies) {
		const key = functionKey(f.file, body.function);
		const change = changes.get(key) ?? { file: f.file, fn: body.function, lines: [], bodies: [] };
		changes.set(key, change);
		change.lines.push(...body.seedLines);
		change.bodies.push({ file: f.file, depth: 0, offset: 0, body });
	}
	for (const change of changes.values()) {
		change.lines = [...new Set(change.lines)].sort((a, b) => a - b);
		await followCallers(change, services, model);
		model.changes.push(change);
	}
	return model;
}

// Follows the return values to the callers, one level at a time. The callers in the same file come from the engine,
// the others from the call hierarchy of the editor.
async function followCallers(change: RippleChange, services: RippleServices, model: RippleModel): Promise<void> {
	const seen = new Set<string>();
	for (let i = 0; i < change.bodies.length; i++) {
		const current = change.bodies[i];
		const returns = current.body.exits.filter((e) => e.kind === 'return' && !e.followed);
		if (current.body.lambda || returns.length === 0 || current.depth >= services.maxDepth) {
			continue;
		}
		// the wave gets to the callers one step after the first return
		const offset = current.offset + Math.min(...returns.map((e) => current.body.steps[e.step]?.distance ?? 0)) + 1;

		const sites: CallSite[] = (current.body.callers ?? []).map((c) => ({ file: current.file, line: c.line, col: c.col }));
		const fromEditor = await services.callers(current.file, current.body.function);
		if (fromEditor === undefined) {
			model.isCallHierarchyMissing = true;
		} else {
			// the call hierarchy also gives the callers in the same file again
			sites.push(...fromEditor.filter((s) => !sites.some((t) => t.file === s.file && t.line === s.line)));
		}

		for (const site of sites) {
			const key = `${site.file}:${site.line}:${site.col}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			try {
				const slice = await services.slice(site.file, { call: { line: site.line, col: site.col } }, 'call');
				if (slice.callFound) {
					slice.bodies.forEach((body) => change.bodies.push({ file: site.file, depth: current.depth + 1, offset, body, from: i, call: site }));
				}
			} catch (error) {
				model.errors.push(`${site.file}:${site.line}: ${messageOf(error)}`);
			}
		}
	}
}
