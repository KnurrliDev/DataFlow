import type { DecisionKind, LogicModel } from '../engine/client';

// Logic Map: path evaluation on the CFG from the engine. A new choice needs no request to the engine.
// This module does not use the VS Code API, so the unit tests can call it directly.
// Lines start at 1, as in the engine.

export const ANY = 'any';
export const OTHER = 'other';

export type ControlKind = DecisionKind | 'chain';

// One control of the outline: a decision, or an else-if chain with one option for each value
export interface Control {
	key: string;
	kind: ControlKind;
	text: string;
	line: number;
	options: string[]; // the first option is 'any'
	decisions: number[]; // a chain has one decision for each value
	parent?: { key: string; option: string }; // the control and the option that contain this control
}

// The option of each control. A control with no entry is 'any'.
export type Choices = Record<string, string>;

export interface EventPair {
	first: number; // indexes in model.events
	second: number;
}

export interface NullWarning {
	nullable: number; // an index in model.nullable
	deref: number; // an index in the derefs of that entry
}

export interface PathResult {
	reachable: Set<number>;
	succs: number[][]; // the successors that the choices permit
	live: number[]; // lines with a statement on the path
	dead: number[]; // lines that the path cannot reach
	events: number[]; // the events on the path, in the sequence of the lines
	pairs: EventPair[]; // two events on one path
	nullWarnings: NullWarning[];
}

export interface WhyItem {
	key: string;
	text: string;
	option: string; // the option that makes the line run. "Use these choices" selects it
	line: number;
	options?: string[]; // a switch with fallthrough: each of these options makes the line run
}

export type PathStepKind = 'decision' | 'event' | 'warning' | 'effect' | 'return' | 'end';

// A change of data that lives after the call of the function. Lines start at 1.
export interface PathChange {
	line: number;
	target: string; // the changed expression, for example new_readings or charge.is_dirty
	action: string; // "=", "+=", "++", or the name of the called member function, for example push_back
	kind: 'member' | 'global' | 'parameter' | 'capture';
}

// A step of the path. Lines start at 1.
export interface PathStep {
	kind: PathStepKind;
	line: number;
	col: number;
	text: string; // the condition, the label of an event, the text of a warning, the changed data, or the returned value
	key?: string; // a decision: the key of its control
	value?: string; // a decision: the option of the path
	options?: string[]; // a decision: the options of its control, with no 'any'
	problem?: string; // an event: the text of the warning for a second event on the path
	changes?: PathChange[]; // an effect: the changes with no other step between them. text has their targets
}

// The text of the warning for an event that a pair gives: a second event after the first one, or the same event again
export function pairWarning(model: LogicModel, first: number, second: number): string {
	const a = model.events[first];
	return first === second ? 'this event can run again on this path, in a loop' : `second event on this path, after ${a.label} (line ${a.line})`;
}

// The controls of the outline, in the sequence of the source. The key of a control stays the same after an edit
// that does not change the control: it has the kind, the text and the position among equal controls.
export function buildControls(model: LogicModel): Control[] {
	const chainOf = new Map<number, { chain: number; item: number }>();
	model.chains.forEach((c, ci) => c.items.forEach((it, ii) => chainOf.set(it.decision, { chain: ci, item: ii })));

	const counts = new Map<string, number>();
	const keyFor = (base: string): string => {
		const n = counts.get(base) ?? 0;
		counts.set(base, n + 1);
		return `${base}#${n}`;
	};

	const controls: Control[] = [];
	const keyOfDecision = new Map<number, string>();
	const chainKeys: string[] = [];
	model.decisions.forEach((d, i) => {
		const link = chainOf.get(i);
		if (link) {
			const chain = model.chains[link.chain];
			if (chainKeys[link.chain] === undefined) {
				chainKeys[link.chain] = keyFor(`chain:${chain.subject}`);
				controls.push({
					key: chainKeys[link.chain], kind: 'chain', text: chain.subject, line: d.line,
					options: [ANY, ...chain.items.map((x) => x.value), OTHER], decisions: chain.items.map((x) => x.decision),
				});
			}
			keyOfDecision.set(i, chainKeys[link.chain]);
			return;
		}
		const key = keyFor(`${d.kind}:${d.text}`);
		keyOfDecision.set(i, key);
		const branches = d.kind === 'switch'
			? [...d.branches].sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity))
			: d.branches;
		controls.push({ key, kind: d.kind, text: d.text, line: d.line, options: [ANY, ...branches.map((b) => b.label)], decisions: [i] });
	});

	// The parent of a control. A branch of a chain item is an option of the chain.
	for (const control of controls) {
		const d = model.decisions[control.decisions[0]];
		if (d.parent < 0) {
			continue;
		}
		let option = d.parentBranch ?? '';
		const link = chainOf.get(d.parent);
		if (link) {
			const chain = model.chains[link.chain];
			if (option === 'yes') {
				option = chain.items[link.item].value;
			} else if (option === 'no' && link.item === chain.items.length - 1) {
				option = OTHER;
			} else {
				continue;
			}
		}
		control.parent = { key: keyOfDecision.get(d.parent)!, option };
	}
	return controls;
}

// The branch that each decision must take. A decision with no entry takes all branches.
export function branchChoices(controls: Control[], choices: Choices): Map<number, string> {
	const out = new Map<number, string>();
	for (const control of controls) {
		const value = choices[control.key];
		if (!value || value === ANY || !control.options.includes(value)) {
			continue;
		}
		if (control.kind !== 'chain') {
			out.set(control.decisions[0], value);
			continue;
		}
		// The value of item k: the items before k are false and item k is true. 'other': all items are false.
		const k = control.options.indexOf(value) - 1;
		control.decisions.forEach((d, i) => {
			if (i < k) {
				out.set(d, 'no');
			} else if (i === k) {
				out.set(d, 'yes');
			}
		});
	}
	return out;
}

// The successors of each block for the choices. A choice removes the edges to the other branches.
// The choices 'enter' and 'repeat' remove no edge: the loop runs its body, and then it ends.
export function prunedSuccs(model: LogicModel, branches: Map<number, string>): number[][] {
	const succs = model.blocks.map((b) => b.succs.filter((s) => s >= 0));
	for (const [index, label] of branches) {
		const d = model.decisions[index];
		if (label === 'enter' || label === 'repeat') {
			continue;
		}
		const targets = d.branches.map((b) => ({ label: b.label, block: model.blocks[d.block].succs[b.succ] }));
		const chosen = new Set(targets.filter((t) => t.label === label).map((t) => t.block));
		if (chosen.size === 0) {
			continue;
		}
		const removed = new Set(targets.filter((t) => !chosen.has(t.block)).map((t) => t.block));
		for (const b of [d.block, ...d.condBlocks]) {
			succs[b] = succs[b].filter((s) => !removed.has(s));
		}
	}
	return succs;
}

// The blocks that a walk from the start block can reach. The walk does not use the blocked edges "from>to".
export function reachableFrom(succs: number[][], start: number, blocked?: Set<string>): Set<number> {
	const seen = new Set<number>([start]);
	const stack = [start];
	while (stack.length > 0) {
		const b = stack.pop()!;
		for (const s of succs[b] ?? []) {
			if (!seen.has(s) && !blocked?.has(`${b}>${s}`)) {
				seen.add(s);
				stack.push(s);
			}
		}
	}
	return seen;
}

// Live lines have a statement on the path. Dead lines have only statements that the path cannot reach,
// or they are in a branch that the path cannot enter. Lines in a dead branch include braces and comments.
export function lineStatus(model: LogicModel, reachable: Set<number>): { live: number[]; dead: number[] } {
	const live = new Set<number>();
	const deadCover = new Set<number>();
	model.blocks.forEach((b, i) => {
		const target = reachable.has(i) ? live : deadCover;
		for (const [first, last] of b.lines) {
			for (let line = first; line <= last; line++) {
				target.add(line);
			}
		}
	});
	const dead = new Set([...deadCover].filter((line) => !live.has(line)));
	for (const d of model.decisions) {
		for (const br of d.branches) {
			if (br.first === undefined || br.last === undefined || reachable.has(model.blocks[d.block].succs[br.succ])) {
				continue;
			}
			for (let line = br.first; line <= br.last; line++) {
				if (!live.has(line)) {
					dead.add(line);
				}
			}
		}
	}
	const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
	return { live: sorted(live), dead: sorted(dead) };
}

// Pairs of events where the second event can follow the first event on one path. If the path can come back to the block
// of an event, for example in a loop, the event is a pair with itself
export function eventPairs(model: LogicModel, succs: number[][], reachable: Set<number>): EventPair[] {
	const events = model.events.map((e, i) => ({ e, i }))
		.filter((x) => reachable.has(x.e.block))
		.sort((a, b) => a.e.line - b.e.line || a.e.col - b.e.col);
	const out: EventPair[] = [];
	for (const a of events) {
		const after = new Set<number>();
		const stack = [...succs[a.e.block]];
		while (stack.length > 0) {
			const b = stack.pop()!;
			if (!after.has(b)) {
				after.add(b);
				stack.push(...succs[b]);
			}
		}
		if (after.has(a.e.block)) {
			out.push({ first: a.i, second: a.i });
		}
		for (const b of events) {
			if (b === a) {
				continue;
			}
			const isLaterInBlock = b.e.block === a.e.block && (b.e.line > a.e.line || (b.e.line === a.e.line && b.e.col > a.e.col));
			if (isLaterInBlock || after.has(b.e.block)) {
				out.push({ first: a.i, second: b.i });
			}
		}
	}
	return out;
}

// Dereferences of a pointer from a nullable function that a path can reach with no null check
export function nullWarnings(model: LogicModel, succs: number[][], reachable: Set<number>): NullWarning[] {
	const out: NullWarning[] = [];
	model.nullable.forEach((n, ni) => {
		if (!reachable.has(n.at.block)) {
			return;
		}
		const checked = new Set(n.checks.map((c) => `${c.block}>${model.blocks[c.block].succs[c.succ]}`));
		const after = reachableFrom(succs, n.at.block, checked);
		n.derefs.forEach((d, di) => {
			const isBefore = d.block === n.at.block && d.line < n.at.line;
			if (reachable.has(d.block) && after.has(d.block) && !isBefore) {
				out.push({ nullable: ni, deref: di });
			}
		});
	});
	return out;
}

export function evaluatePath(model: LogicModel, controls: Control[], choices: Choices): PathResult {
	const succs = prunedSuccs(model, branchChoices(controls, choices));
	const reachable = reachableFrom(succs, model.entry);
	const { live, dead } = lineStatus(model, reachable);
	const events = model.events.map((e, i) => ({ e, i }))
		.filter((x) => reachable.has(x.e.block))
		.sort((a, b) => a.e.line - b.e.line || a.e.col - b.e.col)
		.map((x) => x.i);
	return {
		reachable, succs, live, dead, events,
		pairs: eventPairs(model, succs, reachable),
		nullWarnings: nullWarnings(model, succs, reachable),
	};
}

// The number of lines with a statement on the path of the choices
function liveLineCount(model: LogicModel, controls: Control[], choices: Choices): number {
	const lines = new Set<number>();
	for (const b of reachableFrom(prunedSuccs(model, branchChoices(controls, choices)), model.entry)) {
		for (const [first, last] of model.blocks[b]?.lines ?? []) {
			for (let line = first; line <= last; line++) {
				lines.add(line);
			}
		}
	}
	return lines.size;
}

// The choices of one path: the choices of the user, and for each other control the option that runs the most lines.
// So the path goes past the early returns and into the bodies of the decisions. The controls are in the sequence of the
// source, so an outer control gets its option before the controls in its branches. With equal lines, the first option
// of the control wins.
export function pathChoices(model: LogicModel, controls: Control[], choices: Choices): Choices {
	const out: Choices = {};
	for (const control of controls) {
		const value = choices[control.key];
		if (value !== undefined && control.options.includes(value)) {
			out[control.key] = value;
			continue;
		}
		let best = control.options[1] ?? ANY;
		let most = -1;
		for (const option of control.options.slice(1)) {
			const count = liveLineCount(model, controls, { ...out, [control.key]: option });
			if (count > most) {
				best = option;
				most = count;
			}
		}
		out[control.key] = best;
	}
	return out;
}

// The choices for a new model of the same function, for example after an edit. If the controls have the same kinds in the
// same sequence, each choice goes to the control at the same place, also if the edit changed the text of its condition.
// Else a choice stays only on a control with the same key. An option that the new control does not have goes to the
// option at the same place, if the control has as many options as before.
export function moveChoices(old: Control[], next: Control[], choices: Choices): Choices {
	const out: Choices = {};
	const isSameShape = old.length === next.length && old.every((c, i) => c.kind === next[i].kind);
	for (const [key, value] of Object.entries(choices)) {
		const at = old.findIndex((c) => c.key === key);
		const from = at >= 0 ? old[at] : undefined;
		const to = isSameShape && from ? next[at] : next.find((c) => c.key === key);
		if (!to) {
			continue;
		}
		let option = value;
		if (!to.options.includes(option)) {
			const index = from ? from.options.indexOf(value) : -1;
			if (!from || index < 0 || from.options.length !== to.options.length) {
				continue;
			}
			option = to.options[index];
		}
		out[to.key] = option;
	}
	return out;
}

// The steps of the path, in the sequence of the source: the decisions that the path gets to with their options, the
// events, the dereferences that can get a null pointer, and the returns. If the path gets to the end of the function
// with no return, the end of the function is the last step.
export function pathSteps(model: LogicModel, controls: Control[], choices: Choices, path: PathResult): PathStep[] {
	const steps: (PathStep & { order: number })[] = [];
	for (const control of controls) {
		const d = model.decisions[control.decisions[0]];
		if (path.reachable.has(d.block)) {
			steps.push({
				kind: 'decision', line: d.line, col: d.col, text: control.text, key: control.key, value: choices[control.key] ?? ANY,
				options: control.options.slice(1), order: 0,
			});
		}
	}
	const seconds = new Map<number, string>();
	for (const p of path.pairs) {
		seconds.set(p.second, pairWarning(model, p.first, p.second));
	}
	for (const i of path.events) {
		const e = model.events[i];
		steps.push({ kind: 'event', line: e.line, col: e.col, text: e.label, problem: seconds.get(i), order: 1 });
	}
	for (const w of path.nullWarnings) {
		const n = model.nullable[w.nullable];
		const d = n.derefs[w.deref];
		steps.push({ kind: 'warning', line: d.line, col: d.col, text: `${n.var} can be null`, order: 2 });
	}
	for (const e of model.effects ?? []) {
		if (path.reachable.has(e.block)) {
			const change = { line: e.line, target: e.target, action: e.action, kind: e.kind };
			steps.push({ kind: 'effect', line: e.line, col: e.col, text: e.target, changes: [change], order: 2 });
		}
	}
	const returns = model.returns ?? [];
	for (const r of returns) {
		if (path.reachable.has(r.block)) {
			steps.push({ kind: 'return', line: r.line, col: r.col, text: r.value, order: 3 });
		}
	}
	// a block of the path that goes to the exit and has no return statement: the path gets to the end of the function
	const returnBlocks = new Set(returns.map((r) => r.block));
	const isEnd = model.exit >= 0 && [...path.reachable]
		.some((b) => b !== model.exit && !returnBlocks.has(b) && (path.succs[b] ?? []).includes(model.exit));
	if (isEnd) {
		const end = model.function.range.end;
		steps.push({ kind: 'end', line: end.line, col: end.col, text: '', order: 4 });
	}
	// changes with no other step between them are one step, so a function that sets many data members has a short trail
	const out: PathStep[] = [];
	for (const { order: _order, ...step } of steps.sort((a, b) => a.line - b.line || a.col - b.col || a.order - b.order)) {
		const last = out[out.length - 1];
		if (step.kind === 'effect' && last?.kind === 'effect') {
			last.changes = [...last.changes!, ...step.changes!];
			last.text = [...new Set(last.changes.map((c) => c.target))].join(', ');
			continue;
		}
		out.push(step);
	}
	return out;
}

// The dominators of each block: the blocks that each path from the entry to the block passes through
export function dominators(model: LogicModel): Set<number>[] {
	const n = model.blocks.length;
	const succs = model.blocks.map((b) => b.succs.filter((s) => s >= 0));
	const preds: number[][] = Array.from({ length: n }, () => []);
	succs.forEach((list, b) => list.forEach((s) => preds[s].push(b)));
	const reachable = reachableFrom(succs, model.entry);

	const all = Array.from({ length: n }, (_, i) => i);
	const dom = all.map((i) => (i === model.entry ? new Set([i]) : new Set(all)));
	for (let changed = true; changed;) {
		changed = false;
		for (const b of all) {
			if (b === model.entry || !reachable.has(b)) {
				continue;
			}
			let next: Set<number> | undefined;
			for (const p of preds[b].filter((x) => reachable.has(x))) {
				next = next ? new Set([...next].filter((x) => dom[p].has(x))) : new Set(dom[p]);
			}
			next ??= new Set();
			next.add(b);
			if (next.size !== dom[b].size || [...next].some((x) => !dom[b].has(x))) {
				dom[b] = next;
				changed = true;
			}
		}
	}
	return dom;
}

// The choices that make a line run, with the outer controls first. Undefined if no block contains the line.
// A decision on each path to the line needs a branch if only that branch can reach the line, with no new pass
// through the decision. A loop needs only "enter": a line after the loop runs also if the body runs. In a switch with
// fallthrough, two or more cases can reach the line: the switch needs one of them.
export function whyLine(model: LogicModel, controls: Control[], dom: Set<number>[], line: number): WhyItem[] | undefined {
	let blocks = model.blocks.map((_, i) => i).filter((i) => model.blocks[i].lines.some(([f, l]) => f <= line && line <= l));
	if (blocks.length === 0) {
		// A line with no statement, for example a comment: the smallest branch that contains the line
		let best: { size: number; block: number } | undefined;
		for (const d of model.decisions) {
			for (const br of d.branches) {
				if (br.first !== undefined && br.last !== undefined && br.first <= line && line <= br.last &&
					(!best || br.last - br.first < best.size)) {
					best = { size: br.last - br.first, block: model.blocks[d.block].succs[br.succ] };
				}
			}
		}
		blocks = best ? [best.block] : [];
	}
	if (blocks.length === 0) {
		return undefined;
	}

	const succs = model.blocks.map((b) => b.succs.filter((s) => s >= 0));
	const needsOf = (target: number): Map<number, Set<string>> => {
		const needs = new Map<number, Set<string>>();
		model.decisions.forEach((d, di) => {
			const own = [d.block, ...d.condBlocks];
			if (own.includes(target) || !own.some((b) => dom[target]?.has(b))) {
				return;
			}
			const blocked = new Set<string>();
			succs.forEach((list, from) => list.filter((to) => own.includes(to)).forEach((to) => blocked.add(`${from}>${to}`)));
			const reaching = d.branches.filter((br) => {
				const start = model.blocks[d.block].succs[br.succ];
				return !own.includes(start) && reachableFrom(succs, start, blocked).has(target);
			});
			const isLoopExit = (d.kind === 'loop' || d.kind === 'do') && reaching[0]?.label !== 'enter';
			const labels = new Set(reaching.map((br) => br.label));
			if ((reaching.length === 1 && !isLoopExit) || (d.kind === 'switch' && labels.size > 1 && labels.size < new Set(d.branches.map((br) => br.label)).size)) {
				needs.set(di, labels);
			}
		});
		return needs;
	};

	// The line runs if one of its blocks runs, so it needs only the decisions that all its blocks need, with the options
	// of each block. If the options of the blocks cover all branches of a decision, the line needs no option of it
	const [first, ...rest] = blocks.map(needsOf);
	const needs = new Map<number, string[]>();
	for (const [d, labels] of first) {
		if (!rest.every((m) => m.has(d))) {
			continue;
		}
		const all = new Set([labels, ...rest.map((m) => m.get(d)!)].flatMap((s) => [...s]));
		if (all.size < new Set(model.decisions[d].branches.map((br) => br.label)).size) {
			needs.set(d, [...all]);
		}
	}

	const out: WhyItem[] = [];
	for (const control of controls) {
		if (control.kind !== 'chain') {
			const labels = needs.get(control.decisions[0]);
			if (labels) {
				const options = control.options.filter((o) => labels.includes(o));
				out.push({ key: control.key, text: control.text, option: options[0] ?? labels[0], line: control.line, ...(options.length > 1 ? { options } : {}) });
			}
			continue;
		}
		const labels = control.decisions.map((d) => needs.get(d)?.[0]);
		const yes = labels.indexOf('yes');
		if (yes >= 0) {
			out.push({ key: control.key, text: control.text, option: control.options[yes + 1], line: control.line });
		} else if (labels.every((l) => l === 'no')) {
			out.push({ key: control.key, text: control.text, option: OTHER, line: control.line });
		}
	}
	return out;
}
