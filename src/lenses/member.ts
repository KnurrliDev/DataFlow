import * as path from 'path';
import type { FlowRole, MemberEntry, MemberModel, MemberReference } from '../engine/client';
import { buildFlowView, toUtf16Column, type FlowData, type FlowView, type LineText } from './flow';

// Flow Lens for a data member of a class, a static data member or a global variable: the accesses in the files of the
// translation unit, with the threads and the locks of each access. This module does not use the VS Code API, so the
// unit tests can call it directly. Lines start at 0 as in VS Code. The lines of the engine and the lines in the texts
// start at 1.

// A key for the comparison of two paths. The engine and VS Code can write the drive letter and the separators in
// different ways.
export function fileKey(file: string): string {
	const normal = path.normalize(file);
	return process.platform === 'win32' ? normal.toLowerCase() : normal;
}

export function sameFile(a: string, b: string): boolean {
	return fileKey(a) === fileKey(b);
}

// For example "private member of WorkerPool", "public static member of Stats" or "global variable in demo"
export function memberStorage(model: MemberModel): string {
	const { kind, access, className, qualifiedClass } = model.member;
	if (kind === 'global') {
		return qualifiedClass ? `global variable in ${qualifiedClass}` : 'global variable';
	}
	return `${access} ${kind === 'static' ? 'static ' : ''}member of ${className || 'an unnamed class'}`;
}

// The name of the member with its class, for example WorkerPool::jobs_. A global variable has its namespace
export function memberLabel(model: MemberModel): string {
	const { kind, name, className, qualifiedClass } = model.member;
	const scope = kind === 'global' ? qualifiedClass : className;
	return scope ? `${scope}::${name}` : name;
}

// The threads of the trace that call functions of other source files. A different source file of the class gets these
// threads, so that its functions run on them
export function threadEntries(model: MemberModel): MemberEntry[] {
	return model.threads.flatMap((t) => (t.calls ?? []).map((fn) => ({ function: fn, via: t.via, file: t.file, line: t.line, isRepeated: t.isRepeated })));
}

// The flow view of the member in one file: the marks of the accesses in the file, and the rails of the edges in it.
// The engine gives the edges in each body, so a rail never goes to a different file.
export function buildMemberView(model: MemberModel, file: string, lineText: LineText): FlowView {
	const ids = model.refs.flatMap((r, i) => (sameFile(r.file, file) ? [i] : []));
	const index = new Map(ids.map((id, k) => [id, k]));
	const data: FlowData = {
		variables: [{ name: model.member.name, type: model.member.type, storage: memberStorage(model), declRef: ids.findIndex((id) => model.refs[id].fn < 0) }],
		refs: ids.map((id) => {
			const r = model.refs[id];
			return { var: 0, role: r.role, line: r.line, col: r.col, len: r.len, alsoRead: r.alsoRead };
		}),
		edges: model.edges.flatMap(([a, b]): [number, number][] => {
			const from = index.get(a);
			const to = index.get(b);
			return from !== undefined && to !== undefined ? [[from, to]] : [];
		}),
		hasCfg: true,
	};
	return buildFlowView(data, 0, lineText);
}

// The access of the member at a position of a file, as an index in refs, or undefined
export function memberRefAt(model: MemberModel, file: string, line: number, character: number, lineText: LineText): number | undefined {
	const text = lineText(line);
	if (text === undefined) {
		return undefined;
	}
	const i = model.refs.findIndex((r) => r.line - 1 === line && sameFile(r.file, file)
		&& toUtf16Column(text, r.col) <= character && character <= toUtf16Column(text, r.col + r.len));
	return i >= 0 ? i : undefined;
}

// The outermost function of a body. A lambda is a part of the function around it.
export function rootBody(model: MemberModel, fn: number): number {
	let b = fn;
	while (b >= 0 && model.functions[b].outer >= 0) {
		b = model.functions[b].outer;
	}
	return b;
}

// The name of a body for the texts, for example "destroy()" or "WorkerPool(), lambda"
export function bodyLabel(model: MemberModel, fn: number): string {
	if (fn < 0) {
		return 'declaration';
	}
	const body = model.functions[fn];
	if (body.kind !== 'lambda') {
		return `${body.name}()`;
	}
	const root = rootBody(model, fn);
	return root !== fn ? `${model.functions[root].name}(), lambda` : 'lambda';
}

// The thread of a body: the start of the thread, as a short label and as a sentence
export interface MemberThreadInfo {
	index: number; // the index in threads
	label: string; // for example "std::thread"
	title: string;
}

export function threadOf(model: MemberModel, fn: number): MemberThreadInfo | undefined {
	const body = fn >= 0 ? model.functions[fn] : undefined;
	if (!body || body.thread < 0) {
		return undefined;
	}
	const t = model.threads[body.thread];
	const where = `line ${t.line} of ${path.basename(t.file)}`;
	let title = t.via === 'QThread::run'
		? `Runs on the thread of the QThread object, in run() on ${where}`
		: `Runs on ${t.isRepeated ? 'the threads' : 'the thread'} that ${t.via} starts on ${where}`;
	// a function that a body on the thread calls. It can also have other callers on other threads
	for (let b = fn; b >= 0; b = model.functions[b].outer) {
		const call = model.functions[b].threadCall;
		if (call) {
			title += `, through the call on line ${call.line} of ${path.basename(call.file)}. Other callers can run it on other threads`;
			break;
		}
	}
	return { index: body.thread, label: t.via, title: `${title}.` };
}

//----------------------------------
// Summary and race check

export type MemberVerdictKind = 'race' | 'safe';

export interface MemberVerdict {
	kind: MemberVerdictKind;
	text: string;
	places: { file: string; line: number }[]; // lines from 1
}

export interface MemberSummary {
	files: number;
	functions: number; // the functions with an access. A lambda is a part of its function
	threads: string; // for example "the caller and 1 thread start"
	locks: string; // for example "all under mutex_"
	verdict?: MemberVerdict;
}

const isWrite = (r: MemberReference) => r.role === 'write' || r.role === 'mayWrite';

// One run of an access: the thread that runs it, the locks on the way to it, and the threads that it is in sequence
// with, for example after a join. The threads analysis of the engine gives the runs, also more than one run for a
// function that more than one thread calls. An access with no runs gets one run from its function and its locks.
export interface AccessRun {
	ref: MemberReference;
	thread: number; // the index in threads, or -1 for the thread of the caller
	locks: string[];
	ordered: number[];
}

export function runsOf(model: MemberModel, r: MemberReference): AccessRun[] {
	if (r.runs && r.runs.length > 0) {
		return r.runs.map((x) => ({ ref: r, thread: x.thread, locks: x.locks ?? [], ordered: x.ordered ?? [] }));
	}
	return [{ ref: r, thread: r.fn >= 0 ? model.functions[r.fn].thread : -1, locks: r.locks ?? [], ordered: [] }];
}

// True for a run that can be at the same time as a run on a different thread. The declaration cannot, and a constructor
// or a destructor on the thread of the caller cannot: no other thread uses the object before the constructor ends or
// after the destructor starts.
function isConcurrent(model: MemberModel, run: AccessRun): boolean {
	if (run.ref.fn < 0) {
		return false;
	}
	if (run.thread >= 0) {
		return true;
	}
	const root = model.functions[rootBody(model, run.ref.fn)];
	return root.kind !== 'constructor' && root.kind !== 'destructor';
}

// True if the two runs are on two threads, or on a thread start that starts more than one thread
const isApart = (model: MemberModel, a: AccessRun, b: AccessRun) => a.thread !== b.thread || (a.thread >= 0 && model.threads[a.thread].isRepeated);

// True if a join, a start or a check of a handle of the thread of one run puts the other run in sequence with it
const isOrdered = (a: AccessRun, b: AccessRun) => (b.thread >= 0 && a.ordered.includes(b.thread)) || (a.thread >= 0 && b.ordered.includes(a.thread));

const VERBS: Record<FlowRole, [string, string]> = {
	def: ['sets', 'set'],
	write: ['writes', 'write'],
	mayWrite: ['can change', 'change'],
	check: ['reads', 'read'],
	read: ['reads', 'read'],
};

function threadText(model: MemberModel, run: AccessRun): string {
	if (run.thread < 0) {
		return 'on the caller thread';
	}
	return `on ${model.threads[run.thread].isRepeated ? 'a thread' : 'the thread'} of ${model.threads[run.thread].via}`;
}

// The key of a lock: the name of the mutex with no object, because two functions can give the object different names,
// for example _srv.cancel_mutex_ and srv.cancel_mutex_
const lockKey = (lock: string) => lock.split(/\.|->/).pop() ?? lock;

const hasCommonLock = (a: AccessRun, b: AccessRun) => a.locks.some((l) => b.locks.some((m) => lockKey(l) === lockKey(m)));

// The search for a race: the runs that can be at the same time with no common lock, and a write in one of them. A pair
// with a write comes before a pair with a possible write. isOrdered and isLocked tell if an order or a lock kept a pair
// apart.
interface RaceSearch {
	race?: [AccessRun, AccessRun];
	isOrdered: boolean;
	isLocked: boolean;
}

function findRace(model: MemberModel, runs: AccessRun[]): RaceSearch {
	const out: RaceSearch = { isOrdered: false, isLocked: false };
	let bestRank = -1;
	for (let i = 0; i < runs.length; i++) {
		for (let j = i; j < runs.length; j++) {
			const a = runs[i];
			const b = runs[j];
			// one run races with itself only on two threads of the same thread start
			if ((i === j && !(a.thread >= 0 && model.threads[a.thread].isRepeated)) || !isApart(model, a, b)
				|| (!isWrite(a.ref) && !isWrite(b.ref))) {
				continue;
			}
			if (isOrdered(a, b)) {
				out.isOrdered = true;
				continue;
			}
			if (hasCommonLock(a, b)) {
				out.isLocked = true;
				continue;
			}
			const rank = Number(a.ref.role === 'write' || b.ref.role === 'write');
			if (rank > bestRank) {
				out.race = isWrite(a.ref) ? [a, b] : [b, a];
				bestRank = rank;
			}
		}
	}
	return out;
}

function verdictOf(model: MemberModel, runs: AccessRun[]): MemberVerdict | undefined {
	const name = model.member.name;
	const contexts = new Set(runs.map((r) => r.thread));
	const isRepeated = [...contexts].some((t) => t >= 0 && model.threads[t].isRepeated);
	if (contexts.size < 2 && !isRepeated) {
		return undefined;
	}
	if (model.member.isAtomic) {
		return { kind: 'safe', text: `${name} is atomic, so the threads do not race on it.`, places: [] };
	}
	if (model.member.isSync) {
		return { kind: 'safe', text: `${name} is a synchronization object. Threads can use it at the same time.`, places: [] };
	}
	const search = findRace(model, runs);
	if (search.race) {
		const [a, b] = search.race;
		const isSelf = a.ref === b.ref && a.thread === b.thread;
		const where = (r: AccessRun) => (sameFile(a.ref.file, b.ref.file) ? `line ${r.ref.line}` : `line ${r.ref.line} of ${path.basename(r.ref.file)}`);
		const first = `${bodyLabel(model, a.ref.fn)} ${VERBS[a.ref.role][0]} ${name} on ${where(a)}, ${threadText(model, a)}.`;
		const text = isSelf
			? `${first} Two of these threads can do this at the same time, and no lock protects the access.`
			: `${first} ${bodyLabel(model, b.ref.fn)} can ${VERBS[b.ref.role][1]} it at the same time on ${where(b)}, ${threadText(model, b)}. `
				+ 'No common lock protects the two accesses.';
		const places = a.ref === b.ref ? [a.ref] : [a.ref, b.ref];
		return { kind: 'race', text, places: places.map((r) => ({ file: r.file, line: r.line })) };
	}
	if (!runs.some((r) => isWrite(r.ref))) {
		return { kind: 'safe', text: `The threads only read ${name}, so they do not race on it.`, places: [] };
	}
	if (search.isOrdered && !search.isLocked) {
		return {
			kind: 'safe',
			text: `A join, a start or a check of a thread handle puts the accesses in sequence, so the threads do not race on ${name}.`,
			places: [],
		};
	}
	const common = commonLocks(runs);
	return {
		kind: 'safe',
		text: common.length > 0 && !search.isOrdered
			? `Each access holds ${common.join(' and ')}, so the threads do not race on ${name}.`
			: `Each pair of accesses that can run at the same time holds a common lock${search.isOrdered ? ' or is in sequence' : ''}, so the threads do not race on ${name}.`,
		places: [],
	};
}

// The locks that all runs hold, with the names of the first run
function commonLocks(runs: AccessRun[]): string[] {
	if (runs.length === 0) {
		return [];
	}
	return runs[0].locks.filter((l) => runs.every((r) => r.locks.some((m) => lockKey(m) === lockKey(l))));
}

export function memberSummary(model: MemberModel): MemberSummary {
	const files = new Set(model.refs.map((r) => fileKey(r.file))).size;
	const functions = new Set(model.refs.filter((r) => r.fn >= 0).map((r) => rootBody(model, r.fn))).size;
	const concurrent = model.refs.flatMap((r) => runsOf(model, r)).filter((run) => isConcurrent(model, run));
	const contexts = new Set(concurrent.map((run) => run.thread));
	const starts = [...contexts].filter((t) => t >= 0).length;
	const threads = starts === 0 ? 'one thread' : `${contexts.has(-1) ? 'the caller and ' : ''}${starts} thread ${starts === 1 ? 'start' : 'starts'}`;

	const locked = concurrent.filter((run) => run.locks.length > 0).length;
	const common = commonLocks(concurrent);
	let locks: string;
	if (model.member.isAtomic) {
		locks = 'atomic';
	} else if (model.member.isSync) {
		locks = 'synchronization object';
	} else if (concurrent.length === 0 || locked === 0) {
		locks = 'no lock';
	} else if (locked === concurrent.length) {
		locks = common.length > 0 ? `all under ${common.join(' and ')}` : 'all under a lock';
	} else {
		locks = `${concurrent.length - locked} of ${concurrent.length} without a lock`;
	}
	return { files, functions, threads, locks, verdict: verdictOf(model, concurrent) };
}

//----------------------------------
// Other source files

// Adds the traces of the member in other translation units, for example worker_pool_state.cpp. Only the accesses in the
// file of each extra come in: the headers are in the first trace already, so their accesses do not come two times. The
// file of an extra can be an .inc file that the engine parsed in the unit of the source file that includes it. The
// functions, the threads and the edges of these accesses come with them. A thread with the same start in two units, for
// example a thread of the first unit that calls into the other unit, is one thread.
export function mergeMemberModels(primary: MemberModel, extras: { file: string; model: MemberModel }[]): MemberModel {
	const out: MemberModel = {
		...primary, functions: primary.functions.slice(), threads: primary.threads.slice(), refs: primary.refs.slice(), edges: primary.edges.slice(),
	};
	for (const { file, model } of extras) {
		if (sameFile(file, primary.member.decl.file) || primary.refs.some((r) => sameFile(r.file, file))) {
			continue; // a file of the first trace
		}
		const kept = model.refs.flatMap((r, i) => (sameFile(r.file, file) ? [i] : []));

		// the threads of the extra: the same start gives the same thread
		const threadIndex = new Map<number, number>();
		const threadOf = (t: number): number => {
			if (t < 0) {
				return -1;
			}
			let index = threadIndex.get(t);
			if (index === undefined) {
				const thread = model.threads[t];
				index = out.threads.findIndex((x) => x.via === thread.via && x.line === thread.line && sameFile(x.file, thread.file));
				if (index < 0) {
					index = out.threads.length;
					out.threads.push(thread);
				}
				threadIndex.set(t, index);
			}
			return index;
		};

		// the bodies of the accesses and the bodies around them
		const bodies = new Set<number>();
		for (const i of kept) {
			for (let b = model.refs[i].fn; b >= 0 && !bodies.has(b); b = model.functions[b].outer) {
				bodies.add(b);
			}
		}
		const bodyIndex = new Map<number, number>();
		for (const b of [...bodies].sort((x, y) => x - y)) {
			bodyIndex.set(b, out.functions.length);
			out.functions.push(model.functions[b]);
		}
		for (const b of bodies) {
			const f = out.functions[bodyIndex.get(b)!];
			out.functions[bodyIndex.get(b)!] = { ...f, outer: f.outer >= 0 ? bodyIndex.get(f.outer) ?? -1 : -1, thread: threadOf(f.thread) };
		}

		const refIndex = new Map<number, number>();
		for (const i of kept) {
			refIndex.set(i, out.refs.length);
			const r = model.refs[i];
			const runs = r.runs?.map((x) => ({ ...x, thread: threadOf(x.thread), ordered: x.ordered?.map(threadOf) }));
			out.refs.push({ ...r, fn: r.fn >= 0 ? bodyIndex.get(r.fn) ?? -1 : -1, ...(runs ? { runs } : {}) });
		}
		for (const [a, b] of model.edges) {
			const from = refIndex.get(a);
			const to = refIndex.get(b);
			if (from !== undefined && to !== undefined) {
				out.edges.push([from, to]);
			}
		}
	}
	return out;
}
