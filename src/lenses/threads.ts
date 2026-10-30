import * as path from 'path';
import type { ThreadsAccessInfo, ThreadsItemInfo, ThreadsModel, ThreadsStartInfo } from '../engine/client';
import type {
	SideFlowRole, SideThread, SideThreadAccess, SideThreadItem, SideThreadMark, SideThreads, SideThreadStep, SideThreadVerdict,
} from '../side/protocol';
import { toUtf16Column, type LineText } from './flow';
import { sameFile } from './member';

// Threads and races: the pairs of accesses that can run at the same time, the verdict of each item, and the data of the
// side view. This module does not use the VS Code API, so the unit tests can call it directly. Lines start at 1.

const WRITE_ROLES = new Set(['def', 'write', 'mayWrite']);
const VERDICT_RANK: SideThreadVerdict[] = ['race', 'check', 'safe'];

// Two accesses that can run at the same time on different threads, with a write, and with no common lock and no
// order. check: a condition around the access of the caller thread can keep the threads apart, but the engine cannot see
// if it does. a and b are indexes in the refs of the item.
export interface ThreadPair {
	a: number;
	b: number;
	kind: 'race' | 'check';
}

// True if two accesses touch the same data: the steps of one start with the steps of the other. An access of the whole
// object has no steps
export function overlaps(a: string[], b: string[]): boolean {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

// True if the access is in sequence with the thread: after a join, before the start, where the handle is empty, or where
// the future is ready
export function isOrderedTo(r: ThreadsAccessInfo, thread: number): boolean {
	if (thread < 0) {
		return false;
	}
	const o = r.order;
	return !!(o.after?.includes(thread) || o.before?.includes(thread) || o.empty?.includes(thread) || o.ready?.includes(thread));
}

const isWrite = (r: ThreadsAccessInfo) => WRITE_ROLES.has(r.role);

export function threadPairs(model: ThreadsModel, item: ThreadsItemInfo): ThreadPair[] {
	if (item.isAtomic) {
		return [];
	}
	const out: ThreadPair[] = [];
	const refs = item.refs;
	for (let i = 0; i < refs.length; i++) {
		for (let j = i + 1; j < refs.length; j++) {
			const a = refs[i];
			const b = refs[j];
			// the same thread runs the two accesses one after the other, if only one thread of the start runs
			if (a.thread === b.thread && (a.thread < 0 || !model.threads[a.thread]?.isRepeated)) {
				continue;
			}
			if ((!isWrite(a) && !isWrite(b)) || (a.atomic && b.atomic) || !overlaps(a.sub, b.sub)) {
				continue;
			}
			if (a.locks.some((l) => b.locks.includes(l)) || isOrderedTo(a, b.thread) || isOrderedTo(b, a.thread)) {
				continue;
			}
			const isGuarded = (a.thread < 0 && a.guards.length > 0) || (b.thread < 0 && b.guards.length > 0);
			out.push({ a: i, b: j, kind: isGuarded ? 'check' : 'race' });
		}
	}
	return out;
}

//----------------------------------
// Texts

const shortName = (file: string) => path.basename(file);

// The label of a thread: the function that it runs. For a lambda, the function that the lambda calls first on the way
// to the accesses, as in [&]() { return solve_power_plan(charge); }. Else the lambda and its line
export function threadLabel(model: ThreadsModel, index: number): string {
	const t = model.threads[index];
	const runs = t && t.runs >= 0 ? model.functions[t.runs] : undefined;
	if (runs && runs.kind !== 'lambda') {
		return `${runs.name}()`;
	}
	for (const item of model.items) {
		for (const r of item.refs) {
			// the first step is the start, the second step is the call in the lambda
			if (r.thread !== index || r.via.length < 2 || r.via[1].fn !== t.runs) {
				continue;
			}
			const callee = model.functions[r.via.length > 2 ? r.via[2].fn : r.fn];
			if (callee && callee.kind !== 'lambda') {
				return `${callee.name}()`;
			}
		}
	}
	return `lambda on line ${runs?.line ?? t?.at?.line ?? 0}`;
}

// The text of a start in the lanes, for example "line 95 starts solve_power_plan() on a worker thread"
function startText(model: ThreadsModel, thread: number): string {
	const t = model.threads[thread];
	const label = threadLabel(model, thread);
	return `line ${t.at?.line ?? 0} starts ${label.startsWith('lambda on line') ? 'a lambda' : label} on a worker thread`;
}

const fnLabel = (model: ThreadsModel, fn: number) => {
	const f = model.functions[fn];
	return !f ? '' : f.kind === 'lambda' ? `lambda on line ${f.line}` : `${f.name}()`;
};

// The verb of an access: "reads", "writes", "can change" or "sets"
function verb(r: ThreadsAccessInfo, base = false): string {
	switch (r.role) {
		case 'write':
			return base ? 'write' : 'writes';
		case 'mayWrite':
			return base ? 'change' : 'can change';
		case 'def':
			return base ? 'set' : 'sets';
		default:
			return base ? 'read' : 'reads';
	}
}

const sideRole = (r: ThreadsAccessInfo): SideFlowRole => r.role;

// The lines of the accesses of one lane, for example "reads 94 · writes 116, 129"
function laneText(refs: ThreadsAccessInfo[], file: string): string {
	const place = (r: ThreadsAccessInfo) => (sameFile(r.file, file) ? `${r.line}` : `${shortName(r.file)}:${r.line}`);
	const list = (rs: ThreadsAccessInfo[]) => [...new Set(rs.map(place))].join(', ');
	const reads = refs.filter((r) => !isWrite(r));
	const writes = refs.filter(isWrite);
	const parts = [];
	if (reads.length > 0) {
		parts.push(`reads ${list(reads)}`);
	}
	if (writes.length > 0) {
		parts.push(`writes ${list(writes)}`);
	}
	return parts.join(' · ') || '–';
}

const guardText = (g: { text: string; isNegated: boolean }) => (g.isNegated ? `not (${g.text})` : g.text);

// The note of an access in the lanes: its function, the call on the way, its locks, its order and its conditions
function accessNote(model: ThreadsModel, r: ThreadsAccessInfo, thread: number): string {
	const parts: string[] = [];
	const call = r.via.length > 0 ? r.via[r.via.length - 1] : undefined;
	if (call && r.via.length > 0 && !(r.thread >= 0 && r.via.length === 1)) {
		parts.push(`called on line ${call.line}`);
	}
	if (r.whole) {
		parts.push('gets the whole object');
	}
	if (r.locks.length > 0) {
		parts.push(`holds ${r.locks.join(', ')}`);
	}
	const t = thread >= 0 ? model.threads[thread] : undefined;
	if (t && r.thread < 0) {
		const join = t.joins[0];
		if (r.order.after?.includes(thread) && join) {
			parts.push(`after ${join.kind}() on line ${join.line}`);
		} else if (r.order.ready?.includes(thread)) {
			parts.push(`${t.handle || 'the future'} is ready`);
		} else if (r.order.before?.includes(thread) && t.at) {
			parts.push(`before the start on line ${t.at.line}`);
		} else if (r.order.empty?.includes(thread)) {
			parts.push(`no thread runs: ${t.handle} is empty`);
		}
	}
	if (r.thread < 0 && r.guards.length > 0) {
		parts.push(`if ${guardText(r.guards[0])}`);
	}
	return parts.join(' · ');
}

function access(model: ThreadsModel, r: ThreadsAccessInfo, thread: number): SideThreadAccess {
	return {
		lane: r.thread < 0 ? 'caller' : 'worker', file: r.file, line: r.line, col: r.col - 1, fn: fnLabel(model, r.fn), role: sideRole(r),
		note: accessNote(model, r, thread), isOrdered: r.thread < 0 && isOrderedTo(r, thread),
	};
}

//----------------------------------
// Items

// The worker thread of an item: the thread of its first pair, else its first worker thread
function mainThread(item: ThreadsItemInfo, pairs: ThreadPair[]): number {
	for (const p of pairs) {
		for (const i of [p.a, p.b]) {
			if (item.refs[i].thread >= 0) {
				return item.refs[i].thread;
			}
		}
	}
	return item.refs.find((r) => r.thread >= 0)?.thread ?? -1;
}

// The protection of the accesses: the common locks, the joins and the checks of the handle
function protectionText(model: ThreadsModel, item: ThreadsItemInfo, pairs: ThreadPair[], thread: number): string {
	if (item.isAtomic || item.refs.every((r) => r.atomic)) {
		return 'atomic';
	}
	const threads = new Set(item.refs.map((r) => r.thread));
	if (threads.size < 2 && ![...threads].some((t) => t >= 0 && model.threads[t]?.isRepeated)) {
		return 'one thread only';
	}
	const parts: string[] = [];
	const common = item.refs.reduce<string[] | undefined>((acc, r) => (acc ? acc.filter((l) => r.locks.includes(l)) : [...r.locks]), undefined) ?? [];
	if (common.length > 0) {
		parts.push(common.join(', '));
	}
	const t = thread >= 0 ? model.threads[thread] : undefined;
	const callers = item.refs.filter((r) => r.thread < 0);
	if (t && t.joins[0] && callers.some((r) => r.order.after?.includes(thread) || r.order.ready?.includes(thread))) {
		const after = [...new Set(callers.filter((r) => r.order.after?.includes(thread) || r.order.ready?.includes(thread)).map((r) => r.line))];
		parts.push(`${t.joins[0].kind}() on line ${t.joins[0].line}, for line ${after.join(', ')}`);
	}
	if (t?.at && callers.some((r) => r.order.before?.includes(thread))) {
		parts.push(`the start on line ${t.at.line}`);
	}
	if (t && callers.some((r) => r.order.empty?.includes(thread))) {
		parts.push(`a check of ${t.handle}`);
	}
	if (parts.length > 0) {
		return parts.join(' · ');
	}
	if (pairs.length === 0 && item.refs.every((r) => !isWrite(r))) {
		return 'only reads';
	}
	return 'none';
}

// The two sides of a pair: the access of the caller thread, if there is one, and the other access
function sidesOf(item: ThreadsItemInfo, p: ThreadPair): { caller: ThreadsAccessInfo; worker: ThreadsAccessInfo; kind: ThreadPair['kind'] } {
	const [x, y] = [item.refs[p.a], item.refs[p.b]];
	const caller = x.thread < 0 ? x : y.thread < 0 ? y : x;
	return { caller, worker: caller === x ? y : x, kind: p.kind };
}

// One pair for each access of the caller thread: the races first, and the best partner of each access. A write in the
// file of the side view is the best partner, then a write, then an access in the file
function shownPairs(item: ThreadsItemInfo, pairs: ThreadPair[], file: string): ReturnType<typeof sidesOf>[] {
	const rank = (r: ThreadsAccessInfo) => (isWrite(r) ? 0 : 2) + (sameFile(r.file, file) ? 0 : 1);
	const best = new Map<string, ReturnType<typeof sidesOf>>();
	for (const p of pairs) {
		const s = sidesOf(item, p);
		const key = `${s.caller.file}:${s.caller.line}:${s.caller.thread}`;
		const old = best.get(key);
		if (!old || (old.kind === 'check' && s.kind === 'race')
			|| (old.kind === s.kind && (rank(s.worker) < rank(old.worker) || (rank(s.worker) === rank(old.worker) && s.worker.line < old.worker.line)))) {
			best.set(key, s);
		}
	}
	return [...best.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'race' ? -1 : 1) || a.caller.line - b.caller.line);
}

// The sentence of the verdict
function summaryText(model: ThreadsModel, item: ThreadsItemInfo, pairs: ThreadPair[], verdict: SideThreadVerdict, protection: string,
	file: string): string {
	const shown = shownPairs(item, pairs, file);
	const pair = shown.find((p) => p.kind === verdict) ?? shown[0];
	if (pair) {
		const caller = pair.caller;
		const other = pair.worker;
		if (caller.thread >= 0) {
			return `Two threads of the start on line ${model.threads[caller.thread]?.at?.line ?? 0} can use ${item.label} at the same time: line ${caller.line} ${verb(caller)} it, and line ${other.line} ${verb(other)} it. No lock and no atomic puts them in sequence.`;
		}
		const first = `Line ${caller.line} ${verb(caller)} ${item.label} on the caller thread, and the worker thread can ${verb(other, true)} it on line ${other.line} at the same time.`;
		if (pair.kind === 'race') {
			return `${first} No lock, no atomic and no join puts the two accesses in sequence.`;
		}
		const guards = caller.guards.slice(0, 3).map(guardText).join(' and ');
		return `${first} It is safe only if no worker thread runs when ${guards}. The engine cannot see this.`;
	}
	if (protection === 'one thread only') {
		return item.kind === 'static' || item.kind === 'global'
			? `Only one thread uses ${item.label} now. A use from a second thread would be a race.`
			: `Only one thread uses ${item.label}.`;
	}
	if (protection === 'atomic') {
		return `${item.label} is atomic, so the threads can use it at the same time.`;
	}
	if (protection === 'only reads') {
		return `The threads only read ${item.label}.`;
	}
	return `Each pair of accesses on different threads has a common lock or an order: ${protection}.`;
}

// The lanes of an item: the steps of the caller thread and of the worker thread in sequence. The accesses before the
// start come first, then the start, the accesses that can run at the same time, the join, and the accesses after it
function laneSteps(model: ThreadsModel, item: ThreadsItemInfo, pairs: ThreadPair[], thread: number, file: string): SideThreadStep[] {
	const steps: SideThreadStep[] = [];
	const t = thread >= 0 ? model.threads[thread] : undefined;
	const inPair = new Set(pairs.flatMap((p) => [p.a, p.b]));
	const seen = new Set<string>();
	const add = (r: ThreadsAccessInfo) => {
		const key = `${r.thread < 0 ? 'c' : 'w'}:${r.file}:${r.line}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		steps.push({ kind: 'access', ...access(model, r, thread) });
	};
	const callers = item.refs.map((r, i) => ({ r, i })).filter(({ r }) => r.thread < 0);
	const ordered = (r: ThreadsAccessInfo, kinds: (keyof ThreadsAccessInfo['order'])[]) => kinds.some((k) => r.order[k]?.includes(thread));

	// before the start, and where no thread of the start runs
	for (const { r, i } of callers) {
		if (!inPair.has(i) && ordered(r, ['before', 'empty'])) {
			add(r);
		}
	}
	if (t?.at) {
		steps.push({ kind: 'sync', dir: 'start', text: startText(model, thread), file: t.at.file, line: t.at.line });
	}
	// the worker thread, then the pairs, one for each access of the caller thread
	item.refs.forEach((r, i) => {
		if (r.thread === thread && !inPair.has(i)) {
			add(r);
		}
	});
	for (const { caller, worker, kind } of shownPairs(item, pairs, file)) {
		const text = kind === 'race'
			? 'These two accesses can run at the same time. No lock, no atomic and no join puts them in sequence.'
			: `Not proven. It is safe only if no worker thread runs when ${caller.guards.slice(0, 2).map(guardText).join(' and ')}.`;
		steps.push({ kind: 'pair', verdict: kind, text, caller: access(model, caller, thread), worker: access(model, worker, thread) });
	}
	// the other accesses of the caller thread that are not in sequence, for example under a common lock
	for (const { r, i } of callers) {
		if (!inPair.has(i) && !ordered(r, ['before', 'empty', 'after', 'ready'])) {
			add(r);
		}
	}
	const join = t?.joins[0];
	if (join) {
		steps.push({ kind: 'sync', dir: 'join', text: `line ${join.line}: ${join.kind}() waits until the worker thread ends`, file: join.file, line: join.line });
	}
	for (const { r, i } of callers) {
		if (!inPair.has(i) && ordered(r, ['after', 'ready'])) {
			add(r);
		}
	}
	return steps;
}

// The marks of the accesses of an item in the file of the side view
function itemMarks(item: ThreadsItemInfo, pairs: ThreadPair[], file: string, lineText: LineText): SideThreadMark[] {
	const partner = new Map<number, { other: ThreadsAccessInfo; kind: 'race' | 'check' }>();
	for (const p of pairs) {
		for (const [self, other] of [[p.a, p.b], [p.b, p.a]]) {
			const old = partner.get(self);
			if (!old || (old.kind === 'check' && p.kind === 'race')) {
				partner.set(self, { other: item.refs[other], kind: p.kind });
			}
		}
	}
	// one mark for each place. An access of a pair comes before the other accesses at the same place
	const rank = (m: SideThreadMark) => (m.pair === 'race' ? 2 : m.pair === 'check' ? 1 : 0);
	const byPlace = new Map<string, SideThreadMark>();
	item.refs.forEach((r, i) => {
		const text = lineText(r.line - 1);
		if (!sameFile(r.file, file) || text === undefined) {
			return;
		}
		const mark: SideThreadMark = {
			line: r.line, start: toUtf16Column(text, r.col), end: toUtf16Column(text, r.col + r.len), role: sideRole(r), lane: r.thread < 0 ? 'caller' : 'worker',
		};
		const p = partner.get(i);
		if (p) {
			mark.pair = p.kind;
			mark.hint = `${p.kind} with line ${p.other.line}`;
		}
		const key = `${mark.line}:${mark.start}`;
		const old = byPlace.get(key);
		if (!old || rank(mark) > rank(old)) {
			byPlace.set(key, mark);
		}
	});
	return [...byPlace.values()].sort((a, b) => a.line - b.line || a.start - b.start);
}

export function buildThreadItem(model: ThreadsModel, item: ThreadsItemInfo, file: string, lineText: LineText): SideThreadItem {
	const pairs = threadPairs(model, item);
	const verdict: SideThreadVerdict = pairs.some((p) => p.kind === 'race') ? 'race' : pairs.length > 0 ? 'check' : 'safe';
	const thread = mainThread(item, pairs);
	const protection = protectionText(model, item, pairs, thread);
	const pill = verdict === 'race' ? 'Race' : verdict === 'check' ? 'Check'
		: protection === 'one thread only' && (item.kind === 'static' || item.kind === 'global') ? 'Safe now' : 'Safe';

	// a swap of the conditions checks the handle before the read, as in the possible fix of the design study
	let fix: SideThreadItem['fix'];
	for (const p of pairs) {
		const swap = [item.refs[p.a], item.refs[p.b]].find((r) => r.thread < 0 && r.swap)?.swap;
		const line = [item.refs[p.a], item.refs[p.b]].find((r) => r.thread < 0 && r.swap)?.line;
		if (p.kind === 'race' && swap && line) {
			fix = {
				line,
				text: `Swap the two conditions. Then the check of ${model.threads[swap.thread]?.handle || 'the handle'} comes first, and line ${line} reads ${item.label} only when no worker thread runs.`,
				before: swap.from,
				after: swap.to,
			};
			break;
		}
	}
	return {
		key: item.key, label: item.label, kind: item.kind, type: item.type, verdict, pill,
		caller: laneText(item.refs.filter((r) => r.thread < 0), file),
		worker: laneText(item.refs.filter((r) => r.thread >= 0), file),
		protection, summary: summaryText(model, item, pairs, verdict, protection, file), thread, fix,
		decl: item.decl ? { file: item.decl.file, line: item.decl.line } : undefined,
		marks: itemMarks(item, pairs, file, lineText), steps: laneSteps(model, item, pairs, thread, file),
	};
}

// The variables that a thread captures by reference, when the thread can run after its function returns. A reference
// goes to an object of the caller of the function. A local object ends with the function
function captureItems(model: ThreadsModel, file: string): SideThreadItem[] {
	return model.captures.map((c) => {
		const names = c.vars.map((v) => v.name);
		const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
		const fn = fnLabel(model, c.fn);
		const isObject = c.vars.some((v) => v.kind === 'object');
		const t = model.threads[c.thread];
		const join = t?.joins[0];
		const steps: SideThreadStep[] = [];
		if (t?.at) {
			steps.push({ kind: 'sync', dir: 'start', text: `line ${t.at.line} starts ${threadLabel(model, c.thread)}. The lambda captures ${list} by reference`, file: t.at.file, line: t.at.line });
		}
		if (join) {
			steps.push({ kind: 'sync', dir: 'join', text: `line ${join.line}: ${join.kind}() ends the use, maybe in a later call`, file: join.file, line: join.line });
		}
		return {
			key: `capture:${c.thread}`, label: `${list}, captured by [&]`, kind: 'capture', type: '', verdict: isObject ? 'race' : 'check',
			pill: isObject ? 'Dangling' : 'Check', caller: `${fn} ends`, worker: 'uses them until it ends', protection: isObject ? 'none' : 'the caller must keep them alive',
			summary: isObject
				? `The worker thread can use ${list} after ${fn} returns, but the local objects end there. Join the thread in ${fn}, or capture copies.`
				: `The worker thread uses ${list} after ${fn} can return. They belong to the caller of ${fn}, so the caller must keep them alive until the join${join ? ` on line ${join.line}` : ''}.`,
			thread: c.thread, marks: c.vars.filter((v) => sameFile(v.file, file)).map((v) => ({
				line: v.line, start: Math.max(0, v.col - 1), end: Math.max(0, v.col - 1) + v.name.length, role: 'def' as const, lane: 'caller' as const,
			})), steps,
		};
	});
}

export function buildSideThreads(model: ThreadsModel, file: string, lineText: LineText): SideThreads {
	const threads: SideThread[] = model.threads.map((t: ThreadsStartInfo, index) => ({
		index, label: threadLabel(model, index), via: t.via, file: t.at?.file ?? file, line: t.at?.line ?? 0, fn: fnLabel(model, t.fn),
		handle: t.handle, isRepeated: t.isRepeated,
		joins: t.joins.map((j) => ({ kind: j.kind, file: j.file, line: j.line, fn: fnLabel(model, j.fn) })),
	}));
	const items = [...model.items.map((i) => buildThreadItem(model, i, file, lineText)), ...captureItems(model, file)];
	const firstLine = (i: SideThreadItem) => i.marks[0]?.line ?? Number.MAX_SAFE_INTEGER;
	items.sort((a, b) => VERDICT_RANK.indexOf(a.verdict) - VERDICT_RANK.indexOf(b.verdict) || firstLine(a) - firstLine(b));

	const lanes = model.functions
		.filter((f) => sameFile(f.file, file) && f.threads.some((t) => t >= 0))
		.map((f) => ({ first: f.first, last: f.last, threads: f.threads.filter((t) => t >= 0), isCaller: f.threads.includes(-1) }));
	const tags: SideThreads['tags'] = [];
	model.threads.forEach((t, index) => {
		const label = threadLabel(model, index);
		if (t.at && sameFile(t.at.file, file)) {
			tags.push({ line: t.at.line, text: `starts ${label}${t.isRepeated ? ', more than one' : ''}`, title: `${t.via} starts ${label} on a worker thread${t.handle ? `. ${t.handle} keeps it` : ''}.`, kind: 'start', thread: index });
		}
		for (const j of t.joins) {
			if (sameFile(j.file, file)) {
				tags.push({ line: j.line, text: `${j.kind}() waits for ${label}`, title: `${j.kind}() on ${t.handle} waits until ${label} ends.`, kind: 'join', thread: index });
			}
		}
	});
	tags.sort((a, b) => a.line - b.line);
	const counts: Record<SideThreadVerdict, number> = { race: 0, check: 0, safe: 0 };
	items.forEach((i) => counts[i.verdict]++);
	return { file, threads, items, lanes, tags, counts, isTruncated: model.isTruncated };
}
