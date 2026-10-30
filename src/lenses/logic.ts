import type { LogicModel } from '../engine/client';
import { pairWarning, PathResult } from '../logic/paths';
import { LineText, toUtf16Column } from './flow';

// Logic Map: makes the data for the side view from the model and the path.
// This module does not use the VS Code API, so the unit tests can call it directly.
// The view has lines from 0 and UTF-16 columns, as in VS Code. The warnings have lines from 1.

export interface LogicMark {
	line: number;
	start: number;
	end: number;
}

export interface LogicView {
	dead: number[]; // lines that the path cannot reach
	events: (LogicMark & { label: string })[]; // the events on the path
	problems: LogicMark[]; // dereferences that can get a null pointer
	hints: { line: number; text: string }[];
}

// A warning of the path: a second event on one path, or a dereference of a pointer that can be null. Lines start at 1.
export interface LogicWarning {
	line: number;
	text: string;
	short: string; // the text for the bar of the side view
}

function markOf(m: { line: number; col: number; len: number }, lineText: LineText): LogicMark | undefined {
	const text = lineText(m.line - 1);
	if (text === undefined) {
		return undefined;
	}
	return { line: m.line - 1, start: toUtf16Column(text, m.col), end: toUtf16Column(text, m.col + m.len) };
}

// The texts of the warnings. The side view shows them in its bar and in the path panel. An event in a loop is a pair with
// itself
function pairText(model: LogicModel, first: number, second: number): string {
	const a = model.events[first];
	const b = model.events[second];
	return first === second
		? `The event ${a.label} (line ${a.line}) can run two or more times on one path, in a loop.`
		: `Two events on one path: ${a.label} (line ${a.line}), then ${b.label} (line ${b.line}).`;
}

function nullText(model: LogicModel, nullable: number, deref: number): string {
	const n = model.nullable[nullable];
	return `${n.var} can be null on line ${n.derefs[deref].line}. It comes from ${n.source} on line ${n.at.line}, and no null check is on the path.`;
}

export function buildLogicView(model: LogicModel, path: PathResult, lineText: LineText): LogicView {
	const events: (LogicMark & { label: string })[] = [];
	for (const i of path.events) {
		const mark = markOf(model.events[i], lineText);
		if (mark) {
			events.push({ ...mark, label: model.events[i].label });
		}
	}

	const problems: LogicMark[] = [];
	const hints = new Map<number, string[]>();
	const addHint = (line: number, text: string) => hints.set(line, [...(hints.get(line) ?? []), text]);
	for (const p of path.pairs) {
		addHint(model.events[p.second].line - 1, pairWarning(model, p.first, p.second));
	}
	for (const w of path.nullWarnings) {
		const n = model.nullable[w.nullable];
		const d = n.derefs[w.deref];
		const mark = markOf(d, lineText);
		if (mark) {
			problems.push(mark);
		}
		addHint(d.line - 1, `${n.var} can be null here (${n.source}, line ${n.at.line})`);
	}

	return {
		dead: path.dead.map((line) => line - 1),
		events,
		problems,
		hints: [...hints].map(([line, texts]) => ({ line, text: texts.join('; ') })),
	};
}

// The warnings of the path: the second events of the pairs, then the pointers that can be null
export function logicWarnings(model: LogicModel, path: PathResult): LogicWarning[] {
	return [
		...path.pairs.map((p) => ({
			line: model.events[p.second].line, text: pairText(model, p.first, p.second),
			short: p.first === p.second ? 'event in a loop' : 'two events on one path',
		})),
		...path.nullWarnings.map((w) => ({
			line: model.nullable[w.nullable].derefs[w.deref].line, text: nullText(model, w.nullable, w.deref),
			short: `${model.nullable[w.nullable].var} can be null`,
		})),
	];
}
