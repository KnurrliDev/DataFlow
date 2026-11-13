import type * as Api from '../../api/dataflow-api';
import type { SliceConfidence, SliceStepKind } from '../engine/client';
import { functionKey, RippleChange, RippleModel } from '../review/ripple';

// One line that a change reaches. Lines start at 0.
export interface RippleLine {
	line: number;
	wave: number; // the step of the wave that gets to the line
	kind: SliceStepKind;
	confidence: SliceConfidence;
	isChange: boolean;
}

// A hint at the end of a line: an async call, a state that later calls read, or the callers of a return
export interface RippleHint {
	line: number;
	text: string;
}

// The ripple in one file
export interface RippleView {
	lines: RippleLine[];
	hints: RippleHint[];
	waves: number; // the number of steps of the wave
}

// The state of a review for the side view: the review runs, or it has a result. Lines start at 1.
export interface ReviewState {
	isRunning: boolean;
	base?: string; // for example "main (merge base 1a2b3c4)"
	target?: string; // the target branch, for example origin/dev
	message?: string; // an error, or a result with no changes
	notice?: string; // for example: no call hierarchy provider
	other: { file: string; path: string; text: string }[]; // changed lines with no statement
}

const RANK: Record<SliceConfidence, number> = { exact: 0, call: 1, estimated: 2 };

const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;

// The text of a list of lines, for example "69" or "69, 74 to 76"
export function linesText(lines: number[]): string {
	const sorted = [...new Set(lines)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length;) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) {
			j++;
		}
		parts.push(j > i ? `${sorted[i]} to ${sorted[j]}` : `${sorted[i]}`);
		i = j + 1;
	}
	return parts.join(', ');
}

// The number of functions whose callers come from this body
const callerCount = (change: RippleChange, index: number) =>
	new Set(change.bodies.filter((c) => c.from === index).map((c) => functionKey(c.file, c.body.function))).size;

// The lines and the hints of the ripple in each file. The key is the path of the file.
export function buildRippleViews(model: RippleModel): Map<string, RippleView> {
	const lines = new Map<string, Map<number, RippleLine>>();
	const hints = new Map<string, Map<number, string[]>>();
	const setLine = (file: string, next: RippleLine): void => {
		const map = lines.get(file) ?? new Map<number, RippleLine>();
		lines.set(file, map);
		const old = map.get(next.line);
		const isBetter = !old || next.wave < old.wave || (next.wave === old.wave && RANK[next.confidence] < RANK[old.confidence]);
		map.set(next.line, isBetter ? { ...next, isChange: next.isChange || !!old?.isChange } : { ...old!, isChange: old!.isChange || next.isChange });
	};
	const addHint = (file: string, line: number, text: string): void => {
		const map = hints.get(file) ?? new Map<number, string[]>();
		hints.set(file, map);
		const texts = map.get(line) ?? [];
		if (!texts.includes(text)) {
			map.set(line, [...texts, text]);
		}
	};

	for (const change of model.changes) {
		// the changed lines, also the lines with no statement
		for (const line of change.lines) {
			setLine(change.file, { line: line - 1, wave: 0, kind: 'seed', confidence: 'exact', isChange: true });
		}
		change.bodies.forEach((b, index) => {
			for (const step of b.body.steps) {
				for (const line of step.lines) {
					setLine(b.file, { line: line - 1, wave: b.offset + step.distance, kind: step.kind, confidence: step.confidence, isChange: false });
				}
			}
			const callers = callerCount(change, index);
			for (const e of b.body.exits) {
				if (e.kind === 'async') {
					addHint(b.file, e.line - 1, `async: ${e.text}`);
				} else if (e.kind === 'member' && e.followed) {
					addHint(b.file, e.line - 1, `later calls read ${e.text}`);
				} else if (e.kind === 'return' && !b.body.lambda && callers > 0) {
					addHint(b.file, e.line - 1, callers === 1 ? 'returns to 1 caller' : `returns to ${callers} callers`);
				}
			}
		});
	}

	const out = new Map<string, RippleView>();
	for (const [file, map] of lines) {
		const list = [...map.values()].sort((a, b) => a.line - b.line);
		out.set(file, {
			lines: list,
			hints: [...(hints.get(file) ?? new Map<number, string[]>())].map(([line, texts]) => ({ line, text: texts.join(' · ') })),
			waves: Math.max(0, ...list.map((l) => l.wave)) + 1,
		});
	}
	return out;
}

// The state of a review with its result
export function buildReviewState(model: RippleModel, base: string, target?: string): ReviewState {
	const other = model.other.flatMap((o) => [
		...(o.outside.length > 0 ? [{ file: fileName(o.file), path: o.file, text: `lines ${linesText(o.outside)} are outside of a function` }] : []),
		...(o.quiet.length > 0 ? [{ file: fileName(o.file), path: o.file, text: `lines ${linesText(o.quiet)} have no statement` }] : []),
	]);
	const message = model.errors.length > 0 ? model.errors.join('\n')
		: model.changes.length === 0 && other.length === 0 ? 'No C or C++ file changed against the target branch.' : undefined;
	const notice = model.isCallHierarchyMissing
		? 'No call hierarchy provider answered. Change Ripple follows only the callers in the same file. Install the C/C++ extension or clangd to follow the callers in other files.'
		: undefined;
	return { isRunning: false, base, target, message, notice, other };
}

// The facts of a review for a client of DataFlow give this number of changed functions, and this number of statements
// of each body. A change in a long function can reach hundreds of statements
const MAX_FACT_CHANGES = 100;
const MAX_FACT_STEPS = 100;

// The facts of a review of Change Ripple for a client of DataFlow: for each changed function, the bodies that the change
// reaches with their statements and their exits. Depth 0 is the changed function and its lambdas, depth 1 a caller that
// gets its return value, depth 2 a caller of a caller. Lines start at 1. rel gives the path of a file for the client
export function rippleFacts(model: RippleModel, state: ReviewState, rel: (file: string) => string): Omit<Api.RippleFacts, 'state' | 'note' | 'message'> {
	const reached = new Set<string>();
	const changes = model.changes.map((c) => ({
		file: rel(c.file),
		function: c.fn.qualifiedName,
		lines: c.lines,
		bodies: c.bodies.map((b) => {
			const lines = [...new Set(b.body.steps.flatMap((s) => s.lines))].sort((x, y) => x - y);
			lines.forEach((line) => reached.add(`${b.file}#${line}`));
			return {
				file: rel(b.file), function: b.body.function.qualifiedName, ...(b.body.lambda ? { lambdaLine: b.body.lambda.line } : {}), depth: b.depth,
				...(b.call ? { call: { file: rel(b.call.file), line: b.call.line } } : {}),
				lines,
				steps: b.body.steps.slice(0, MAX_FACT_STEPS).map((s) => ({
					line: s.line, kind: s.kind, confidence: s.confidence, distance: s.distance, text: s.text, ...(s.via ? { via: s.via } : {}),
				})),
				...(b.body.steps.length > MAX_FACT_STEPS ? { moreSteps: b.body.steps.length - MAX_FACT_STEPS } : {}),
				exits: b.body.exits.map((e) => ({ kind: e.kind, line: e.line, text: e.text, ...(e.followed ? { followed: true } : {}) })),
			};
		}),
	}));
	return {
		...(state.base ? { base: state.base } : {}),
		...(state.target ? { target: state.target } : {}),
		counts: { changes: model.changes.length, bodies: model.changes.reduce((n, c) => n + c.bodies.length, 0), reachedLines: reached.size },
		changes: changes.slice(0, MAX_FACT_CHANGES),
		...(changes.length > MAX_FACT_CHANGES ? { moreChanges: changes.length - MAX_FACT_CHANGES } : {}),
		...(state.other.length > 0 ? { otherLines: state.other.map((o) => ({ file: rel(o.path), text: o.text })) } : {}),
		...(state.notice ? { notice: state.notice } : {}),
		...(model.errors.length > 0 ? { errors: model.errors } : {}),
	};
}
