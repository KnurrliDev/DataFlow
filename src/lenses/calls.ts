import * as path from 'path';
import type { CallFunctionInfo, CallGraphModel, CallSiteInfo } from '../engine/client';
import type { SideCallEdge, SideCallFunction, SideCallKind, SideCalls } from '../side/protocol';
import { toUtf16Column, type LineText } from './flow';

// Call Hierarchy: makes the data of the side view from the call graph of the engine. This module does not use the
// VS Code API, so the unit tests can call it directly. Lines start at 1.

// The kinds of a link, the most important first. A link with more than one call gets the kind of its most important
// call.
const KIND_RANK: SideCallKind[] = ['async', 'event', 'warn', 'check', 'write', 'data', 'call', 'other'];

// The kinds that get a hint on the line of the call
const HINT_KINDS = new Set<SideCallKind>(['async', 'event', 'warn', 'check', 'write']);

export function siteKind(s: CallSiteInfo): SideCallKind {
	if (s.async) {
		return 'async';
	}
	if (s.event) {
		return 'event';
	}
	if (s.optional === 'unchecked') {
		return 'warn';
	}
	if (s.optional === 'checked') {
		return 'check';
	}
	if (s.writes?.length) {
		return 'write';
	}
	return s.result === 'none' || s.result === 'discarded' ? 'call' : 'data';
}

// The parts of a qualified name. A template argument can contain "::", for example vector<std::string>::size
function nameParts(name: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < name.length; i++) {
		const c = name[i];
		if (c === '<' || c === '(') {
			depth++;
		} else if (c === '>' || c === ')') {
			depth--;
		} else if (depth === 0 && c === ':' && name[i + 1] === ':') {
			out.push(name.slice(start, i));
			start = i + 2;
			i++;
		}
	}
	out.push(name.slice(start));
	return out;
}

// For example process(), WorkerPool::post() or lambda (line 12). A class template has no template arguments in the
// label: Future::get(), not Future<std::optional<double>>::get(). With _scope, a function also gets its namespace:
// charge::initial_power()
export function functionLabel(f: CallFunctionInfo, scope = false): string {
	if (f.kind === 'lambda') {
		return `lambda (line ${f.line})`;
	}
	if (f.macroCall) {
		return f.macroCall;
	}
	const parts = nameParts(f.qualifiedName);
	const owner = (f.kind !== 'function' || scope) && parts.length >= 2 ? parts[parts.length - 2].replace(/<.*$/, '') : '';
	return owner ? `${owner}::${f.name}()` : `${f.name}()`;
}

const times = (n: number) => (n > 1 ? ` ×${n}` : '');
const unique = (list: string[]) => [...new Set(list)];
const nameList = (names: string[], max: number) => (names.length > max ? `${names.slice(0, max).join(', ')}, …` : names.join(', '));

// The text of one call, for its hint
function siteText(s: CallSiteInfo, kind: SideCallKind): string {
	switch (kind) {
		case 'async':
			return 'async on another thread';
		case 'event':
			return 'event';
		case 'warn':
			return s.uncheckedLine ? `optional not checked on line ${s.uncheckedLine}` : 'optional not checked';
		case 'check':
			return 'optional checked';
		case 'write':
			return `writes ${nameList(s.writes ?? [], 3)}`;
		default:
			return '';
	}
}

// The short text and the long text of a link
function edgeTexts(kind: SideCallKind, sites: CallSiteInfo[], callee: string, caller: string): { short: string; long: string } {
	const ofKind = sites.filter((s) => siteKind(s) === kind);
	const first = ofKind[0] ?? sites[0];
	const writes = unique(sites.flatMap((s) => s.writes ?? []));
	const into = unique(sites.map((s) => s.into).filter((x): x is string => !!x));
	const intoText = into.length > 0 ? ` The result goes into ${nameList(into, 3)}.` : '';
	const alsoWrites = kind !== 'write' && writes.length > 0 ? ` The call also writes ${nameList(writes, 3)}.` : '';
	switch (kind) {
		case 'async':
			return {
				short: 'async on another thread',
				long: `The call on line ${first.line} is in a lambda that ${first.async} runs on a different thread.${alsoWrites}`,
			};
		case 'event':
			return {
				short: `event${times(ofKind.length)}`,
				long: `${ofKind.length === 1 ? 'One call' : `${ofKind.length} calls`} of the event function ${callee}. `
					+ `The setting dataflow.logic.eventFunctions gives the event functions.${alsoWrites}`,
			};
		case 'warn':
			return {
				short: 'optional not checked',
				long: `Returns std::optional.${intoText} Line ${first.uncheckedLine ?? first.line} reads the value with no check.`,
			};
		case 'check':
			return { short: 'optional checked', long: `Returns std::optional.${intoText} The caller checks it before the use.` };
		case 'write':
			return {
				short: `writes ${nameList(writes, 2)}${times(ofKind.length)}`,
				long: `Writes ${nameList(writes, 6)}: the call gets ${writes.length === 1 ? 'it' : 'them'} by non-const reference or by address.`,
			};
		case 'data': {
			const isReturned = sites.some((s) => s.result === 'returned');
			const isChecked = sites.some((s) => s.result === 'checked');
			const long = isReturned ? `The result is the return value of ${caller}.`
				: into.length > 0 ? `The result goes into ${nameList(into, 3)}.`
					: isChecked ? 'A condition checks the result.' : 'The caller uses the result.';
			return { short: isReturned ? 'result returned' : `result used${times(ofKind.length)}`, long: long + alsoWrites };
		}
		default: {
			const isVoid = sites.every((s) => s.result === 'none');
			return {
				short: sites.length > 1 ? `${sites.length} calls` : 'call',
				long: isVoid ? `${callee} returns nothing.` : 'The caller does not use the result.',
			};
		}
	}
}

// The innermost function of the main file that contains the line, or -1
export function callFunctionAt(model: CallGraphModel, line: number): number {
	let best = -1;
	let size = Infinity;
	model.functions.forEach((f, i) => {
		if (f.where === 'main' && f.range && f.range.begin <= line && line <= f.range.end && f.range.end - f.range.begin < size) {
			best = i;
			size = f.range.end - f.range.begin;
		}
	});
	return best;
}

// The labels of the functions of a graph. Two functions with the same label get their namespaces, for example
// charge::initial_power()
export function graphLabels(model: CallGraphModel): string[] {
	const first = model.functions.map((f) => functionLabel(f));
	const counts = new Map<string, number>();
	first.forEach((l) => counts.set(l, (counts.get(l) ?? 0) + 1));
	return model.functions.map((f, i) => (counts.get(first[i])! > 1 ? functionLabel(f, true) : first[i]));
}

export function buildSideCalls(model: CallGraphModel, file: string, focus: number, lineText: LineText): SideCalls {
	const labels = graphLabels(model);
	const functions: SideCallFunction[] = model.functions.map((f, id) => ({
		id, label: labels[id], qualifiedName: f.qualifiedName, where: f.where, file: f.file, line: f.line, col: f.col - 1, isDefined: f.isDefined,
	}));
	const column = (line: number, col: number) => toUtf16Column(lineText(line - 1) ?? '', col);

	// one link for each caller and called function
	const groups = new Map<string, CallSiteInfo[]>();
	for (const s of model.calls) {
		const key = `${s.from}>${s.to}`;
		groups.set(key, [...(groups.get(key) ?? []), s]);
	}
	const edges: SideCallEdge[] = [...groups.values()].map((sites) => {
		const kind = KIND_RANK[Math.min(...sites.map((s) => KIND_RANK.indexOf(siteKind(s))))];
		const isVirtual = sites.every((s) => s.virtualOf !== undefined);
		const texts = edgeTexts(kind, sites, labels[sites[0].to], labels[sites[0].from]);
		// an override that a virtual call can run: the text tells the function that the call names
		const named = isVirtual ? unique(sites.map((s) => labels[s.virtualOf!])) : [];
		const { short, long } = isVirtual ? {
			short: `virtual call${times(sites.length)}`,
			long: `The call names ${nameList(named, 3)}, a virtual function. ${labels[sites[0].to]} overrides it, so the call runs `
				+ `${labels[sites[0].to]} if the object is of its class. ${texts.long}`,
		} : texts;
		return {
			from: sites[0].from, to: sites[0].to, kind, short, long, file,
			sites: sites.map((s) => ({ line: s.line, col: column(s.line, s.col) })).sort((a, b) => a.line - b.line || a.col - b.col),
			...(isVirtual ? { isVirtual } : {}),
		};
	});

	// the hints on the calls of the function at the cursor that have data. A library call gets no hint, and an override
	// of a virtual call has the hint of the function that the call names
	const hints: SideCalls['hints'] = [];
	for (const s of model.calls) {
		const kind = siteKind(s);
		if (s.from !== focus || !HINT_KINDS.has(kind) || model.functions[s.to].where === 'library' || s.virtualOf !== undefined) {
			continue;
		}
		const edge = edges.find((e) => e.from === s.from && e.to === s.to)!;
		hints.push({ line: s.line, text: `${labels[s.to]} · ${siteText(s, kind)}`, kind, title: edge.long, to: s.to });
	}
	hints.sort((a, b) => a.line - b.line);

	return { file, functions, edges, focus, hints };
}

// A caller in a different file, from the call hierarchy of VS Code. Lines start at 1. Columns are UTF-16 code units
// from 0.
export interface ExternalCaller {
	name: string;
	file: string;
	line: number;
	col: number;
	sites: { line: number; col: number }[];
}

// Adds the callers in other files of a function. A caller in the file of the graph is in the graph already.
export function addExternalCallers(calls: SideCalls, fn: number, callers: ExternalCaller[]): SideCalls {
	const key = (file: string) => path.normalize(file).toLowerCase();
	const functions = calls.functions.slice();
	const edges = calls.edges.filter((e) => !(e.to === fn && e.kind === 'other'));
	for (const c of callers) {
		if (key(c.file) === key(calls.file)) {
			continue;
		}
		// the C/C++ extension can give the parameters with the name, for example main()
		const name = c.name.replace(/\(.*$/, '');
		let id = functions.findIndex((f) => f.where === 'other' && key(f.file) === key(c.file) && f.line === c.line);
		if (id < 0) {
			id = functions.length;
			functions.push({ id, label: `${name}()`, qualifiedName: name, where: 'other', file: c.file, line: c.line, col: c.col, isDefined: true });
		}
		edges.push({
			from: id, to: fn, kind: 'other', short: `from ${path.basename(c.file)}`,
			long: `The call hierarchy of VS Code finds ${c.sites.length === 1 ? 'this call' : `${c.sites.length} calls`} in ${path.basename(c.file)}.`,
			file: c.file, sites: c.sites,
		});
	}
	return { ...calls, functions, edges };
}

//-------------------
// Show Calls

// The name at a column of a line: the letters, the digits, _ and ~ around the column. Empty if no name is there
export function wordAt(text: string, col: number): string {
	const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_~]/.test(c);
	let a = Math.min(col, text.length);
	let b = a;
	while (a > 0 && isWord(text[a - 1])) {
		a--;
	}
	while (b < text.length && isWord(text[b])) {
		b++;
	}
	return text.slice(a, b);
}

// The function of the name at a place of the file: the function whose definition or declaration has the name there,
// else the called function of a call of the name on the line, else a function of the graph with the name. A function
// of the main file comes before a function of the project, and a definition before a declaration. -1 if the graph has
// no such function. line from 1, col: a UTF-16 column from 0
export function callTargetAt(model: CallGraphModel, file: string, line: number, col: number, lineText: LineText): number {
	const text = lineText(line - 1) ?? '';
	const word = wordAt(text, col);
	if (!word) {
		return -1;
	}
	const key = (f: string) => path.normalize(f).toLowerCase();
	const atName = model.functions.findIndex((f) => f.name === word && f.line === line && key(f.file) === key(file));
	if (atName >= 0) {
		return atName;
	}
	const call = model.calls.find((s) => s.line === line && model.functions[s.to]?.name === word);
	if (call) {
		return call.to;
	}
	const rank = (f: CallFunctionInfo) => (f.where === 'main' ? 0 : f.where === 'project' ? 1 : 2) + (f.isDefined ? 0 : 3);
	let best = -1;
	model.functions.forEach((f, i) => {
		if (f.name === word && (best < 0 || rank(f) < rank(model.functions[best]))) {
			best = i;
		}
	});
	return best;
}

// A call of the list of Show Calls: its place, the function that calls, and the kind of the call. Lines from 1, UTF-16
// columns from 0
export interface CallListItem {
	file: string;
	line: number;
	col: number;
	caller: string;
	kind: SideCallKind;
}

// The calls of a function in the graph, in the sequence of the lines. The graph has the calls of the main file. A
// virtual call that can run an override is a call of the override too. The callers have the labels of the tab Calls
export function callsOf(model: CallGraphModel, fn: number, file: string, lineText: LineText): CallListItem[] {
	const labels = graphLabels(model);
	const seen = new Set<string>();
	const out: CallListItem[] = [];
	for (const s of model.calls) {
		if (s.to !== fn) {
			continue;
		}
		const col = toUtf16Column(lineText(s.line - 1) ?? '', s.col);
		if (seen.has(`${s.line}:${col}`)) {
			continue;
		}
		seen.add(`${s.line}:${col}`);
		out.push({ file, line: s.line, col, caller: labels[s.from], kind: siteKind(s) });
	}
	return out.sort((a, b) => a.line - b.line || a.col - b.col);
}
