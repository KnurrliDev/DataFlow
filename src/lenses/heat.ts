import type * as Api from '../../api/dataflow-api';
import type { MemberMetricsMember, MemberMetricsModel, MetricsFunction, MetricsModel, MetricsReach, ThreadsModel, UnknownCallersCause } from '../engine/client';
import { sameFile } from './member';

// The heat score of the functions of a file: how much a change of a function can break. The score adds points of
// reach, risk and history, and each point has a reason. docs/heat-score-strategy.md gives the points. This module does
// not use the VS Code API, so the unit tests can call it directly. Lines start at 1.

export type HeatBand = 'cool' | 'warm' | 'hot' | 'veryHot';
export type HeatGroup = 'reach' | 'risk' | 'history';

// A reason of the score: its group, its points and its text, with the kind (id) and the measure (value) of its signal
// for the clients of DataFlow
export type HeatReason = Api.HeatSignal;

export interface HeatFunction {
	name: string;
	qualifiedName: string;
	first: number; // the first and the last line of the function
	last: number;
	nameLine: number; // the line of the name of the function, for the flames
	score: number; // 0 to 100
	band: HeatBand;
	flames: number; // 1 to 5
	reach: number;
	risk: number;
	history: number;
	isSiloed: boolean; // the reach is less than 10 with the callers, thus the risk and the history count half
	isReachComplete: boolean; // the call graph gives the reach of the function: its callers and its frame path
	reachUnknown?: { cause: UnknownCallersCause; text: string }; // callers that the call graph cannot see
	tests?: { functions: number; files: string[]; isCapped?: boolean }; // the test functions that reach the function
	reasons: HeatReason[]; // the reasons with points, the largest first in each group
}

export interface HeatModel {
	file: string;
	functions: HeatFunction[]; // in the sequence of the file
	types: HeatType[]; // the classes, the structs and the unions of the file, in the sequence of the file
	notices: string[]; // the signals that are not available
	isReachComplete: boolean; // false: the reach of one or more functions has no callers and no frame path
}

// The facts of a class, a struct or a union of the file and of its data members. They have no score: the score of a
// member needs a calibration first
export interface HeatType {
	name: string; // the qualified name
	kind: string; // class, struct or union
	line: number; // the line of the name
	first: number;
	last: number;
	includeReach?: { units: number; total: number }; // the source files of the project that include the file
	isReachComplete: boolean; // the call graph gives the functions that use the members
	members: HeatMember[];
}

export interface HeatMember {
	name: string;
	line: number;
	type: string;
	isStatic: boolean;
	readers?: number; // the functions that read the member. Undefined until the call graph is complete
	writers?: number; // the functions that write the member
	files?: number; // the files of these functions
	users?: { function: string; file: string; line: number; isWrite: boolean }[]; // the first 20 functions
	framePath?: { function: string; reason: string; calls: number }; // the user on the shortest frame path
	// two or more threads use the member, from the analysis of the threads of the file. unprotected: an access has no
	// lock, no atomic and no order to the other threads
	shared?: 'unprotected' | 'locked';
}

// The blame of a file: the commit of each line, and the time and the summary of each commit
export interface Blame {
	lines: string[]; // the commit of each line, line 1 at index 0. An empty text: a line that is not committed
	commits: Map<string, { time: number; summary: string }>; // time: seconds since 1970
}

export interface HeatInputs {
	file: string;
	functions: MetricsFunction[];
	// the number of the source files that include the file of a declaration, and of all source files. Undefined if the
	// include index has no data for the file
	includeReach: (file: string) => { units: number; total: number } | undefined;
	threads?: ThreadsModel; // undefined: no analysis of the threads
	blame?: Blame; // undefined: no git history
	callGraph?: MetricsModel['callGraph']; // the state of the call graph of the engine
	types?: MemberMetricsModel; // the types of the file with the facts of their data members
	now: number; // milliseconds since 1970
}

export const MAX_REACH = 60;
export const MAX_RISK = 25;
export const MAX_HISTORY = 15;
// A change in this time is a recent change
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
// The reach under which a function is siloed. Its risk and history count half, but only with the callers
const SILOED_REACH = 10;
const NOT_COMMITTED = /^0{40}$/;
// a message that starts with "fix", or that has the word "bug", for example not "debug"
const FIX_COMMIT = /^\s*fix|\bbug(s|fix|fixes)?\b/i;

// Points on a log scale: 0 for 0, and more for each doubling, to a maximum
const logPoints = (n: number, scale: number, max: number): number => Math.min(max, Math.round(scale * Math.log2(n + 1)));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const baseName = (file: string): string => file.split(/[\\/]/).pop() ?? file;
const fileKey = (file: string): string => file.replace(/\\/g, '/').toLowerCase();

// A list of names: the first three and the number of the others
function namesText(names: string[]): string {
	const shown = names.slice(0, 3).join(', ');
	return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

export function bandOf(score: number): HeatBand {
	return score < 25 ? 'cool' : score < 50 ? 'warm' : score < 75 ? 'hot' : 'veryHot';
}

export function flamesOf(score: number): number {
	return Math.max(1, Math.min(5, Math.floor(score / 20) + 1));
}

// The blame of git in the porcelain format. The first line of a group of lines gives the commit, the line in the
// original file and the line in the final file. The header lines of a commit come only at its first group. Each line of
// the file comes after a tab.
export function parseBlame(porcelain: string): Blame {
	const lines: string[] = [];
	const commits = new Map<string, { time: number; summary: string }>();
	let commit = '';
	let line = 0;
	for (const raw of porcelain.split('\n')) {
		if (raw.startsWith('\t')) {
			if (line > 0) {
				lines[line - 1] = NOT_COMMITTED.test(commit) ? '' : commit;
			}
			continue;
		}
		const text = raw.replace(/\r$/, '');
		const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(text);
		if (head) {
			commit = head[1];
			line = Number(head[2]);
			if (!commits.has(commit) && !NOT_COMMITTED.test(commit)) {
				commits.set(commit, { time: 0, summary: '' });
			}
			continue;
		}
		const info = commits.get(commit);
		if (info && text.startsWith('author-time ')) {
			info.time = Number(text.slice('author-time '.length));
		} else if (info && text.startsWith('summary ')) {
			info.summary = text.slice('summary '.length);
		}
	}
	return { lines, commits };
}

// The text of a frame path: the frame function with its reason, the functions after it, and the function. A long path
// shows the frame function, the number of the other functions and the last two functions
function framePathText(frame: NonNullable<MetricsReach['frame']>, name: string): string {
	const [first, ...rest] = [...frame.path, name];
	const tail = rest.length > 3 ? [`${rest.length - 2} more`, ...rest.slice(-2)] : rest;
	return [`${first} (${frame.reason})`, ...tail].join(', then ');
}

// The frame path gives points only up to this number of calls from the frame function, as the engine tells it
export const FRAME_LIMIT = 8;

// The text of callers that the call graph cannot see, from the cause of the engine
export function unknownCallersText(u: NonNullable<MetricsReach['unknownCallers']>): string {
	const why = u.cause === 'address' ? `${u.via} uses the address of the function, so a pointer or a std::function can call it`
		: u.cause === 'libraryOverride' ? `a library can call this override of ${u.via}`
			: u.via.startsWith('the signal ') ? `Qt calls it through ${u.via}` : 'Qt can call it as a slot';
	return `Callers that the call graph cannot see: ${why}`;
}

// The reach points: the frame path, the callers and their files from the call graph of the engine, the include reach of
// the declaration, and an interface. Callers that the graph cannot see, a frame path past the limit and the tests give
// reasons with no points
function reachReasons(fn: MetricsFunction, inputs: HeatInputs): HeatReason[] {
	const out: HeatReason[] = [];
	const graph = fn.reach;
	if (graph?.frame) {
		const frame = graph.frame;
		const calls = frame.calls ?? frame.path.length;
		const value = { reason: frame.reason, path: [...frame.path], calls, isInLoop: frame.isInLoop, ...(frame.isPastLimit ? { isPastLimit: true } : {}) };
		if (frame.isPastLimit) {
			out.push({
				group: 'reach', points: 0, id: 'framePath', value,
				text: `On a frame path after ${calls} calls: ${framePathText(frame, fn.qualifiedName)}. The points stop after ${FRAME_LIMIT} calls. `
					+ 'Add a function of the path to dataflow.heat.frameFunctions',
			});
		} else {
			out.push({
				group: 'reach', points: 40, id: 'framePath', value,
				text: frame.path.length === 0 ? `Runs in each frame: ${frame.reason}` : `On the frame path: ${framePathText(frame, fn.qualifiedName)}`,
			});
			if (frame.isInLoop) {
				out.push({ group: 'reach', points: 10, text: 'A caller on the frame path calls it in a loop', id: 'frameLoop', value: true });
			}
		}
	}
	if (graph?.unknownCallers) {
		out.push({ group: 'reach', points: 0, text: unknownCallersText(graph.unknownCallers), id: 'reachUnknown', value: { ...graph.unknownCallers } });
	}
	if (graph?.tests && graph.tests.functions > 0) {
		const t = graph.tests;
		out.push({
			group: 'reach', points: 0, id: 'tests', value: { functions: t.functions, files: [...t.files], isCapped: !!t.isCapped },
			text: `${t.functions}${t.isCapped ? ' or more' : ''} ${t.functions === 1 ? 'test function reaches' : 'test functions reach'} it: ${namesText(t.files.map(baseName))}`,
		});
	}
	// the transitive callers show how much code depends on the function
	if (graph && graph.transitiveCallers > 0) {
		const all = `${graph.transitiveCallers}${graph.isCapped ? ' or more' : ''}`;
		const text = graph.transitiveCallers === graph.callers
			? `${plural(graph.callers, 'function calls', 'functions call')} it directly`
			: `${all} ${graph.transitiveCallers === 1 ? 'function calls' : 'functions call'} it, ${graph.callers} of them directly`;
		out.push({
			group: 'reach', points: logPoints(graph.transitiveCallers, 2, 10), text,
			id: 'callers', value: { direct: graph.callers, transitive: graph.transitiveCallers, isCapped: !!graph.isCapped },
		});
	}
	if (graph && graph.callerFiles > 0) {
		out.push({
			group: 'reach', points: Math.min(5, graph.callerFiles), text: `Callers in ${plural(graph.callerFiles, 'other file', 'other files')}`,
			id: 'callerFiles', value: graph.callerFiles,
		});
	}
	const reach = inputs.includeReach(fn.declaration.file);
	if (reach && reach.total > 0 && reach.units > 0) {
		const points = Math.min(8, Math.round((16 * reach.units) / reach.total));
		if (points > 0) {
			out.push({
				group: 'reach', points,
				text: `${baseName(fn.declaration.file)} with the declaration is in ${reach.units} of ${plural(reach.total, 'source file', 'source files')}`,
				id: 'includeReach', value: { file: fn.declaration.file, units: reach.units, total: reach.total },
			});
		}
	}
	if (fn.override || fn.virtual) {
		out.push({
			group: 'reach', points: 2, text: fn.override ? 'Override of a virtual function' : 'Virtual function',
			id: 'virtual', value: fn.override ? 'override' : 'virtual',
		});
	}
	return out;
}

// The bodies of the analysis of the threads in the lines of a function: the function and its lambdas
function threadBodies(fn: MetricsFunction, inputs: HeatInputs): Set<number> {
	const out = new Set<number>();
	inputs.threads?.functions.forEach((b, i) => {
		if (fileKey(b.file) === fileKey(inputs.file) && b.first >= fn.range.begin.line && b.first <= fn.range.end.line) {
			out.add(i);
		}
	});
	return out;
}

// The risk points from the metrics of the engine and from the threads
function riskReasons(fn: MetricsFunction, inputs: HeatInputs): HeatReason[] {
	const out: HeatReason[] = [];
	const decisions = logPoints(fn.decisions, 2.5, 10);
	if (decisions > 0) {
		out.push({ group: 'risk', points: decisions, text: plural(fn.decisions, 'decision', 'decisions'), id: 'decisions', value: fn.decisions });
	}
	if (fn.depth >= 4) {
		out.push({ group: 'risk', points: 3, text: `Nesting depth of ${fn.depth}`, id: 'depth', value: fn.depth });
	}
	if (fn.writes.length > 0) {
		const names = fn.writes.map((w) => w.path);
		out.push({ group: 'risk', points: Math.min(5, fn.writes.length), text: `Writes shared state: ${namesText(names)}`, id: 'writes', value: names });
	}

	// the data that two or more threads share. An access with a lock, an atomic or an order to the threads is protected
	const bodies = threadBodies(fn, inputs);
	const unprotected: string[] = [];
	const locked: string[] = [];
	for (const item of inputs.threads?.items ?? []) {
		if (new Set(item.refs.map((r) => r.thread)).size < 2) {
			continue;
		}
		const mine = item.refs.filter((r) => bodies.has(r.fn));
		if (mine.length === 0) {
			continue;
		}
		const isSafe = (r: (typeof mine)[number]) => item.isAtomic || !!r.atomic || r.locks.length > 0
			|| !!(r.order.after?.length || r.order.before?.length || r.order.empty?.length || r.order.ready?.length);
		(mine.every(isSafe) ? locked : unprotected).push(item.label);
	}
	if (unprotected.length > 0) {
		out.push({ group: 'risk', points: 6, text: `Data that threads share, with no protection: ${namesText(unprotected)}`, id: 'sharedUnprotected', value: unprotected });
	} else if (locked.length > 0) {
		out.push({ group: 'risk', points: 3, text: `Data that threads share, with a lock: ${namesText(locked)}`, id: 'sharedLocked', value: locked });
	}

	const costs = Math.min(3, fn.allocationsInLoops + Math.ceil(fn.copiesInLoops / 2));
	if (costs > 0) {
		const parts = [
			...(fn.allocationsInLoops > 0 ? [plural(fn.allocationsInLoops, 'allocation', 'allocations')] : []),
			...(fn.copiesInLoops > 0 ? [plural(fn.copiesInLoops, 'copy', 'copies')] : []),
		];
		out.push({
			group: 'risk', points: costs, text: `In loops: ${parts.join(', ')}`,
			id: 'loopCosts', value: { allocations: fn.allocationsInLoops, copies: fn.copiesInLoops },
		});
	}
	const length = fn.bodyLines > 100 ? 2 : fn.bodyLines > 50 ? 1 : 0;
	if (length > 0) {
		out.push({ group: 'risk', points: length, text: `Long body: ${fn.bodyLines} lines`, id: 'length', value: fn.bodyLines });
	}
	return out;
}

// The history points from the blame of the lines of a function
function historyReasons(fn: MetricsFunction, inputs: HeatInputs): HeatReason[] {
	const blame = inputs.blame;
	if (!blame) {
		return [];
	}
	const commits = new Set<string>();
	let isChanged = false; // a line that is not committed
	for (let line = fn.range.begin.line; line <= fn.range.end.line; line++) {
		const commit = blame.lines[line - 1];
		if (commit === '') {
			isChanged = true;
		} else if (commit) {
			commits.add(commit);
		}
	}
	const out: HeatReason[] = [];
	const count = logPoints(commits.size, 2, 7);
	if (count > 0) {
		out.push({ group: 'history', points: count, text: `Changed in ${plural(commits.size, 'commit', 'commits')}`, id: 'commits', value: commits.size });
	}
	const fixes = [...commits].map((c) => blame.commits.get(c)?.summary ?? '').filter((s) => FIX_COMMIT.test(s));
	if (fixes.length > 0) {
		out.push({
			group: 'history', points: Math.min(6, 2 * fixes.length),
			text: `${fixes.length === 1 ? '1 commit that fixes a bug' : `${fixes.length} commits that fix bugs`}: ${namesText(fixes.map((s) => `"${s}"`))}`,
			id: 'fixes', value: fixes,
		});
	}
	const since = (inputs.now - RECENT_MS) / 1000;
	if (isChanged || [...commits].some((c) => (blame.commits.get(c)?.time ?? 0) >= since)) {
		out.push({
			group: 'history', points: 2, text: isChanged ? 'Changes that are not committed' : 'Changed in the last 30 days',
			id: 'recent', value: isChanged ? 'uncommitted' : 'recent',
		});
	}
	return out;
}

const sum = (reasons: HeatReason[]): number => reasons.reduce((n, r) => n + r.points, 0);
const byPoints = (a: HeatReason, b: HeatReason): number => b.points - a.points;

export function buildHeat(inputs: HeatInputs): HeatModel {
	const functions = inputs.functions.map((fn): HeatFunction => {
		const reach = reachReasons(fn, inputs).sort(byPoints);
		const risk = riskReasons(fn, inputs).sort(byPoints);
		const history = historyReasons(fn, inputs).sort(byPoints);
		const reachPoints = Math.min(MAX_REACH, sum(reach));
		// only the callers show that a function is siloed. With callers that the graph cannot see, it is not
		const isSiloed = !!fn.reach && !fn.reach.unknownCallers && reachPoints < SILOED_REACH;
		const factor = isSiloed ? 0.5 : 1;
		const riskPoints = Math.floor(Math.min(MAX_RISK, sum(risk)) * factor);
		const historyPoints = Math.floor(Math.min(MAX_HISTORY, sum(history)) * factor);
		const score = Math.min(100, reachPoints + riskPoints + historyPoints);
		return {
			name: fn.name,
			qualifiedName: fn.qualifiedName,
			first: fn.range.begin.line,
			last: fn.range.end.line,
			nameLine: fn.nameAt?.line ?? fn.range.begin.line,
			score,
			band: bandOf(score),
			flames: flamesOf(score),
			reach: reachPoints,
			risk: riskPoints,
			history: historyPoints,
			isSiloed,
			isReachComplete: !!fn.reach,
			...(fn.reach?.unknownCallers ? { reachUnknown: { cause: fn.reach.unknownCallers.cause, text: unknownCallersText(fn.reach.unknownCallers) } } : {}),
			...(fn.reach?.tests ? { tests: { ...fn.reach.tests, files: [...fn.reach.tests.files] } } : {}),
			reasons: [...reach, ...risk, ...history],
		};
	});

	// the engine gives the reach of all functions when the call graph is complete. A function that is newer than the
	// scan has no node in the graph
	const notices: string[] = [];
	const missing = inputs.functions.filter((f) => f.reach === null).length;
	if (inputs.functions.some((f) => f.reach === undefined)) {
		notices.push(inputs.callGraph?.state === 'scanning'
			? 'The scan of the call graph runs. Until it is complete, the reach has no callers and no frame path.'
			: 'The call graph is not complete. The reach has no callers and no frame path.');
	} else if (missing > 0) {
		notices.push(`The call graph has no data for ${plural(missing, 'function', 'functions')} of the file, for example a function that is newer than the scan. The reach of ${missing === 1 ? 'this function' : 'these functions'} has no callers.`);
	}
	const pastLimit = inputs.functions.filter((f) => f.reach?.frame?.isPastLimit).length;
	if (pastLimit > 0) {
		notices.push(`${plural(pastLimit, 'function of the file is', 'functions of the file are')} on a frame path after more than ${FRAME_LIMIT} calls. `
			+ 'Such a path gives no points. To give it points, add a function of the path to dataflow.heat.frameFunctions.');
	}
	if (!inputs.blame) {
		notices.push('No history: the file is not in a git repository, or git cannot blame it.');
	}
	if (!inputs.threads) {
		notices.push('No threads: the analysis of the threads gave no result.');
	}
	const types = (inputs.types?.types ?? []).map((t): HeatType => {
		const reach = inputs.includeReach(inputs.file);
		return {
			name: t.qualifiedName || t.name, kind: t.kind, line: t.line, first: t.first, last: t.last,
			...(reach ? { includeReach: { ...reach } } : {}),
			isReachComplete: inputs.types!.callGraph.state === 'ready',
			members: t.members.map((m) => heatMember(m, inputs)),
		};
	});
	return { file: inputs.file, functions, types, notices, isReachComplete: inputs.functions.every((f) => !!f.reach) };
}

// The facts of a data member, with the data that threads share: an item of the analysis of the threads with the
// declaration of the member, which two or more threads use
function heatMember(m: MemberMetricsMember, inputs: HeatInputs): HeatMember {
	let shared: HeatMember['shared'];
	for (const item of inputs.threads?.items ?? []) {
		if (!item.decl || item.decl.line !== m.line || !sameFile(item.decl.file, inputs.file) || new Set(item.refs.map((r) => r.thread)).size < 2) {
			continue;
		}
		const isSafe = (r: (typeof item.refs)[number]) => item.isAtomic || !!r.atomic || r.locks.length > 0
			|| !!(r.order.after?.length || r.order.before?.length || r.order.empty?.length || r.order.ready?.length);
		shared = item.refs.every(isSafe) && shared !== 'unprotected' ? 'locked' : 'unprotected';
	}
	return {
		name: m.name, line: m.line, type: m.type, isStatic: !!m.isStatic,
		...(m.readers !== undefined ? { readers: m.readers, writers: m.writers ?? 0, files: m.files ?? 0 } : {}),
		...(m.users ? { users: m.users.map((u) => ({ function: u.name, file: u.file, line: u.line, isWrite: u.isWrite })) } : {}),
		...(m.frame ? { framePath: { ...m.frame } } : {}),
		...(shared ? { shared } : {}),
	};
}

//-------------------
// The heat of the changes, for the guided review and the diff walk

// The list of the hottest changed functions for a language model has a maximum of this number of functions
export const MAX_HOT_CHANGES = 10;

// The hottest function with a line in the lines first to last. Undefined if no function has a line there
export function hottestIn(model: HeatModel, first: number, last: number): HeatFunction | undefined {
	let out: HeatFunction | undefined;
	for (const fn of model.functions) {
		if (fn.first <= last && fn.last >= first && (!out || fn.score > out.score)) {
			out = fn;
		}
	}
	return out;
}

// The functions with one or more of the changed lines, the hottest first
export function changedFunctions(model: HeatModel, lines: readonly number[]): HeatFunction[] {
	return model.functions.filter((fn) => lines.some((l) => l >= fn.first && l <= fn.last))
		.sort((a, b) => b.score - a.score || a.first - b.first);
}

// The band as a text, for example "very hot"
export const bandText = (band: HeatBand): Api.HeatBand => (band === 'veryHot' ? 'very hot' : band);

// The heat of a function for a language model: the name, the lines, the score, the band and the reasons with the most
// points
export function heatFact(fn: HeatFunction, reasons = 3): Omit<Api.HotChange, 'file'> {
	const top = [...fn.reasons].sort(byPoints).slice(0, reasons);
	return {
		function: fn.qualifiedName || fn.name, lines: [fn.first, fn.last], score: fn.score, band: bandText(fn.band), isReachComplete: fn.isReachComplete,
		reasons: top.map((r) => `${r.text} (+${r.points} ${r.group})`),
	};
}

// A changed function with its heat, and the ids of the hunks of a diff walk that change it
export interface HeatChange {
	file: string;
	fn: HeatFunction;
	hunks: string[];
}

// The changed functions, the hottest first, at most max
export function hottestChanges(changes: readonly HeatChange[], max: number): HeatChange[] {
	return [...changes].sort((a, b) => b.fn.score - a.fn.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.fn.first - b.fn.first))
		.slice(0, max);
}
