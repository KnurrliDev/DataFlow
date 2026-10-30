import type { FlowModel, FlowReference, FlowRole } from '../engine/client';

// Flow Lens: makes the data of the side view from the flow model of a function.
// This module does not use the VS Code API, so the unit tests can call it directly.
// Lines start at 0. Columns are UTF-16 code units from 0, as in VS Code.

export type FlowColor = 'definition' | 'read' | 'write' | 'check' | 'problem';

// The text of a line of the document, or undefined if the line does not exist
export type LineText = (line: number) => string | undefined;

// A reference of the traced variable in the editor
export interface FlowMark {
	line: number;
	start: number;
	end: number;
	role: FlowRole;
	finding?: string;
}

// A dot on a lane. A definition gets a large dot. A possible write gets a ring.
export interface FlowNode {
	line: number;
	color: FlowColor;
	isDef: boolean;
	isHollow: boolean;
}

// The part of a lane between two nodes. A segment that goes to a use with a finding is a problem segment.
export interface FlowSegment {
	from: number;
	to: number;
	isProblem: boolean;
}

// The rail of one definition. It connects the definition and the uses that the definition reaches.
export interface FlowLane {
	from: number;
	to: number;
	color: FlowColor;
	segments: FlowSegment[];
	nodes: FlowNode[];
}

export interface FlowFinding {
	line: number;
	text: string;
}

export interface FlowView {
	varIndex: number;
	name: string;
	type: string;
	storage: string;
	declLine: number; // -1 if the declaration is in a different file
	marks: FlowMark[];
	edges: [number, number][]; // from a definition to a use that it reaches, as indexes in marks
	hasCfg: boolean; // false if the engine has no CFG for the function, so the view has no lanes
	lanes: FlowLane[];
	findings: FlowFinding[];
	counts: Record<FlowRole, number>;
}

// The parts of a flow model that the view needs. Flow Lens for a data member makes these parts for each file.
export type FlowData = Pick<FlowModel, 'variables' | 'refs' | 'edges' | 'hasCfg'>;

// The texts for the findings of the engine
const FINDING_TEXT: Record<string, string> = {
	'unchecked optional access': 'optional not checked here',
};

export function findingText(finding: string): string {
	return FINDING_TEXT[finding] ?? finding;
}

function utf8Length(code: number): number {
	return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

// Converts a column of the engine to a column of VS Code. The engine counts UTF-8 bytes from 1.
export function toUtf16Column(text: string, byteCol: number): number {
	let bytes = 0;
	let i = 0;
	while (i < text.length && bytes < byteCol - 1) {
		const code = text.codePointAt(i)!;
		bytes += utf8Length(code);
		i += code > 0xffff ? 2 : 1;
	}
	return i;
}

// Converts a column of VS Code to a column of the engine
export function toUtf8Column(text: string, character: number): number {
	let bytes = 0;
	let i = 0;
	while (i < Math.min(character, text.length)) {
		const code = text.codePointAt(i)!;
		bytes += utf8Length(code);
		i += code > 0xffff ? 2 : 1;
	}
	return bytes + 1;
}

function markOf(ref: FlowReference, lineText: LineText): FlowMark | undefined {
	const text = lineText(ref.line - 1);
	if (text === undefined) {
		return undefined;
	}
	const start = toUtf16Column(text, ref.col);
	const end = toUtf16Column(text, ref.col + ref.len);
	return { line: ref.line - 1, start, end, role: ref.role, finding: ref.finding };
}

// The variable of the reference at the position, or undefined if no reference is there
export function variableAt(model: FlowModel, line: number, character: number, lineText: LineText): number | undefined {
	for (const ref of model.refs) {
		if (ref.line - 1 !== line) {
			continue;
		}
		const mark = markOf(ref, lineText);
		if (mark && mark.start <= character && character <= mark.end) {
			return ref.var;
		}
	}
	return undefined;
}

// The position of a variable among the variables with the same name. After an edit, this finds the variable again.
export function ordinalOf(model: FlowModel, varIndex: number): number {
	const name = model.variables[varIndex].name;
	return model.variables.slice(0, varIndex).filter((v) => v.name === name).length;
}

export function findVariable(model: FlowModel, name: string, ordinal: number): number | undefined {
	const indexes = model.variables.map((v, i) => (v.name === name ? i : -1)).filter((i) => i >= 0);
	return indexes[ordinal];
}

export function buildFlowView(model: FlowData, varIndex: number, lineText: LineText): FlowView {
	const variable = model.variables[varIndex];
	const refIds = model.refs.map((_, i) => i).filter((i) => model.refs[i].var === varIndex);
	const counts: Record<FlowRole, number> = { def: 0, write: 0, mayWrite: 0, check: 0, read: 0 };
	const marks: FlowMark[] = [];
	const markOfRef = new Map<number, number>();
	const findings: FlowFinding[] = [];
	for (const i of refIds) {
		const ref = model.refs[i];
		counts[ref.role]++;
		const mark = markOf(ref, lineText);
		if (mark) {
			markOfRef.set(i, marks.length);
			marks.push(mark);
		}
		if (ref.finding) {
			findings.push({ line: ref.line - 1, text: findingText(ref.finding) });
		}
	}
	const edges: [number, number][] = [];
	for (const [from, to] of model.edges) {
		const a = markOfRef.get(from);
		const b = markOfRef.get(to);
		if (a !== undefined && b !== undefined) {
			edges.push([a, b]);
		}
	}
	return {
		varIndex,
		name: variable.name,
		type: variable.type,
		storage: variable.storage,
		declLine: variable.declRef >= 0 ? model.refs[variable.declRef].line - 1 : -1, // -1: the declaration is in a different file
		marks,
		edges,
		hasCfg: model.hasCfg !== false,
		lanes: buildLanes(model, refIds),
		findings,
		counts,
	};
}

// If a lane has more than one use on a line, the node shows the role with the highest rank
const NODE_RANK: Record<FlowColor, number> = { definition: 0, read: 1, check: 2, write: 3, problem: 4 };

function useColor(ref: FlowReference): FlowColor {
	if (ref.finding) {
		return 'problem';
	}
	switch (ref.role) {
		case 'write':
		case 'mayWrite':
			return 'write';
		case 'check':
			return 'check';
		default:
			return 'read';
	}
}

// One lane for each declaration and each write that reaches a use. A possible write gets no lane.
// The old value stays, so a possible write shows as a node on the lanes that reach it.
function buildLanes(model: FlowData, refIds: number[]): FlowLane[] {
	const usesOf = new Map<number, number[]>();
	for (const [from, to] of model.edges) {
		const uses = usesOf.get(from) ?? [];
		uses.push(to);
		usesOf.set(from, uses);
	}

	const lanes: FlowLane[] = [];
	for (const d of refIds) {
		const def = model.refs[d];
		const uses = usesOf.get(d) ?? [];
		if ((def.role !== 'def' && def.role !== 'write') || uses.length === 0) {
			continue;
		}
		const color: FlowColor = def.role === 'def' ? 'definition' : 'write';
		const nodes = new Map<number, FlowNode>();
		for (const u of uses) {
			const ref = model.refs[u];
			const node: FlowNode = { line: ref.line - 1, color: useColor(ref), isDef: false, isHollow: ref.role === 'mayWrite' };
			const old = nodes.get(node.line);
			if (!old || NODE_RANK[node.color] > NODE_RANK[old.color]) {
				nodes.set(node.line, node);
			}
		}
		// The definition has priority on its own line.
		nodes.set(def.line - 1, { line: def.line - 1, color, isDef: true, isHollow: false });

		const sorted = [...nodes.values()].sort((a, b) => a.line - b.line);
		lanes.push({
			from: sorted[0].line,
			to: sorted[sorted.length - 1].line,
			color,
			segments: sorted.slice(1).map((node, k) => ({ from: sorted[k].line, to: node.line, isProblem: node.color === 'problem' })),
			nodes: sorted,
		});
	}
	return lanes;
}

// Gives each lane a slot: a column of the rails at the left of the code. Lanes that do not share a line can share a slot.
// Lanes with a problem get a slot first. The result has the slot of each lane, or -1 if no slot is free.
export function assignSlots(lanes: FlowLane[], slotCount: number): number[] {
	const hasProblem = (lane: FlowLane) => lane.segments.some((s) => s.isProblem);
	const order = lanes.map((_, i) => i).sort((a, b) =>
		Number(hasProblem(lanes[b])) - Number(hasProblem(lanes[a])) || lanes[a].from - lanes[b].from);
	const used: FlowLane[][] = Array.from({ length: slotCount }, () => []);
	const slots = new Array<number>(lanes.length).fill(-1);
	for (const i of order) {
		const lane = lanes[i];
		const slot = used.findIndex((list) => list.every((u) => u.to < lane.from || lane.to < u.from));
		if (slot >= 0) {
			slots[i] = slot;
			used[slot].push(lane);
		}
	}
	return slots;
}
