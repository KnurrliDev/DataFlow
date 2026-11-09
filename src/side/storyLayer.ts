import type { SliceExitKind, SliceStep } from '../engine/client';
import { buildRippleViews, ReviewState } from '../lenses/ripple';
import type { DiffLine } from '../review/git';
import { functionKey, RippleBody, RippleChange } from '../review/ripple';
import type { RippleLayerState } from '../state/store';
import { changedPart, lexSpans, pairedSpans } from './model';
import { functionTitle, withBrackets } from './names';
import type { SideCard, SideCardRow, SideDiffRow, SideRipple, SideRow, SideStory, SideStoryChange } from './protocol';

// Change Ripple in the side view: the story of each change, and the ripple in the file view.
// docs/side-view-strategy.md, section 5.5, describes the story.

// A gap of a maximum of this number of lines between two lines of a card shows as lines of context. A larger gap is a fold.
const MAX_CONTEXT_GAP = 2;
// The diff of a change shows a maximum of this number of rows
const MAX_DIFF_ROWS = 80;

// The row of a line with the tokens of the engine, or undefined if the story has no row for the line
export type RowSource = (file: string, line: number) => SideRow | undefined;

// The paths of Windows can have a different case
export const fileKey = (file: string) => (process.platform === 'win32' ? file.toLowerCase() : file);
const sameFile = (a: string, b: string) => fileKey(a) === fileKey(b);
const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const short = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// The last name of a qualified name, for example fire_transition for electricity::power_ctrl::fire_transition. A ::
// in the arguments of a template does not count
export function lastName(qualified: string): string {
	let depth = 0;
	let start = 0;
	for (let i = 0; i + 1 < qualified.length; i++) {
		const c = qualified[i];
		if (c === '<') {
			depth++;
		} else if (c === '>') {
			depth--;
		} else if (depth === 0 && c === ':' && qualified[i + 1] === ':') {
			start = i + 2;
		}
	}
	return qualified.slice(start);
}

const EXIT_TEXT: Record<SliceExitKind, (text: string) => string> = {
	return: (text) => text,
	member: (text) => `writes ${text}`,
	global: (text) => `writes ${text}`,
	reference: (text) => `can change ${text}`,
	argument: (text) => `goes into ${lastName(text)}()`,
	capture: (text) => `captured: ${text}`,
	async: (text) => `async: ${text}`,
	call: (text) => `decides the call of ${lastName(text)}()`,
};

const bodyLabel = (b: RippleBody) => {
	const name = withBrackets(functionTitle(b.body.function));
	return b.body.lambda ? `lambda in ${name}` : name;
};

// The lines of a card: the lines of the steps in the sequence of the source, with the lines of short gaps. Each line of
// a step gets the step with the smallest distance. A large gap is a fold.
function cardPlan(b: RippleBody): { line: number; step?: SliceStep; fold?: number }[] {
	const best = new Map<number, SliceStep>();
	for (const s of b.body.steps) {
		for (const line of s.lines.length > 0 ? s.lines : [s.line]) {
			const old = best.get(line);
			if (!old || s.distance < old.distance) {
				best.set(line, s);
			}
		}
	}
	const lines = [...best.keys()].sort((x, y) => x - y);
	const out: { line: number; step?: SliceStep; fold?: number }[] = [];
	lines.forEach((line, i) => {
		const before = i > 0 ? lines[i - 1] : line;
		if (line - before - 1 > MAX_CONTEXT_GAP) {
			out.push({ line: before + 1, fold: line - before - 1 });
		} else {
			for (let l = before + 1; l < line; l++) {
				out.push({ line: l });
			}
		}
		out.push({ line, step: best.get(line) });
	});
	return out;
}

// The hunks of the diff of the file of a change with a changed line in the function
function changeHunks(layer: RippleLayerState, change: RippleChange): DiffLine[][] {
	const hunks = layer.files.find((f) => sameFile(f.file, change.file))?.hunks ?? [];
	const { begin, end } = change.fn.range;
	return hunks.filter((h) => h.some((l) => l.kind !== 'context' && l.newLine >= begin.line && l.newLine <= end.line));
}

// The lines of each file that the story shows, for the tokens of the engine. The key is the key of the file.
export function storyLines(layer: RippleLayerState): Map<string, { file: string; lines: number[] }> {
	const out = new Map<string, { file: string; lines: number[] }>();
	const add = (file: string, line: number) => {
		const entry = out.get(fileKey(file)) ?? { file, lines: [] };
		out.set(fileKey(file), entry);
		entry.lines.push(line);
	};
	for (const change of layer.model.changes) {
		for (const b of change.bodies) {
			cardPlan(b).filter((p) => p.fold === undefined).forEach((p) => add(b.file, p.line));
		}
		changeHunks(layer, change).flat().filter((l) => l.kind !== 'removed').forEach((l) => add(change.file, l.newLine));
	}
	for (const entry of out.values()) {
		entry.lines = [...new Set(entry.lines)].sort((a, b) => a - b);
	}
	return out;
}

// The groups of near lines, for one request of tokens each. Two lines with a maximum gap of maxGap lines are in one group.
export function lineRanges(lines: number[], maxGap: number): [number, number][] {
	const out: [number, number][] = [];
	for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
		const last = out[out.length - 1];
		if (last && line - last[1] <= maxGap + 1) {
			last[1] = line;
		} else {
			out.push([line, line]);
		}
	}
	return out;
}

// The rows of the diff of a change. A run of removed lines and the added lines after it make pairs: removed line k and
// added line k. A row of the working tree gets the tokens of the engine if the engine has the same text.
function diffRows(file: string, hunks: DiffLine[][], rowOf: RowSource): SideDiffRow[] {
	const out: SideDiffRow[] = [];
	const newRow = (l: DiffLine): SideRow => {
		const row = rowOf(file, l.newLine);
		return row && row.text === l.text ? row : { line: l.newLine, text: l.text, spans: lexSpans(l.text) };
	};
	hunks.forEach((hunk, h) => {
		if (h > 0) {
			const after = hunks[h - 1][hunks[h - 1].length - 1];
			const gap = hunk[0].newLine - after.newLine - (after.kind === 'removed' ? 0 : 1);
			out.push({ kind: 'fold', line: hunk[0].newLine, at: hunk[0].newLine, text: '', spans: [], count: Math.max(0, gap) });
		}
		for (let i = 0; i < hunk.length;) {
			if (hunk[i].kind === 'context') {
				const row = newRow(hunk[i]);
				out.push({ kind: 'context', line: hunk[i].newLine, at: hunk[i].newLine, text: row.text, spans: row.spans });
				i++;
				continue;
			}
			let j = i;
			while (j < hunk.length && hunk[j].kind === 'removed') {
				j++;
			}
			let k = j;
			while (k < hunk.length && hunk[k].kind === 'added') {
				k++;
			}
			const removed = hunk.slice(i, j);
			const added = hunk.slice(j, k);
			removed.forEach((r, n) => {
				const pair = added[n] ? newRow(added[n]) : undefined;
				out.push({
					kind: 'removed', line: r.oldLine ?? r.newLine, at: r.newLine, text: r.text,
					spans: pair ? pairedSpans(r.text, pair) : lexSpans(r.text), changed: pair ? changedPart(r.text, pair.text, true) : undefined,
				});
			});
			added.forEach((a, n) => {
				const row = newRow(a);
				out.push({
					kind: 'added', line: a.newLine, at: a.newLine, text: row.text, spans: row.spans,
					changed: removed[n] ? changedPart(removed[n].text, a.text, false) : undefined,
				});
			});
			i = k;
		}
	});
	if (out.length > MAX_DIFF_ROWS) {
		const hidden = out.length - MAX_DIFF_ROWS;
		const at = out[MAX_DIFF_ROWS].at;
		out.length = MAX_DIFF_ROWS;
		out.push({ kind: 'fold', line: at, at, text: '', spans: [], count: hidden });
	}
	return out;
}

// The note of a step: why the line is in the ripple
function stepNote(b: RippleBody, s: SliceStep, isChange: boolean): string {
	const from = s.from >= 0 ? b.body.steps[s.from] : undefined;
	switch (s.kind) {
		case 'seed':
			return s.confidence === 'exact' ? (isChange ? 'changed' : `uses ${short(s.via) || 'a value of the deleted code'}`) : `calls ${s.via}()`;
		case 'data':
			return `reads ${short(s.via)}`;
		case 'control':
			return from ? `runs on a branch of line ${from.line}` : `runs on a branch of ${short(s.via)}`;
		case 'member':
			return `reads ${short(s.via)}`;
		case 'async':
			return `async call: ${s.via}`;
		case 'lambda':
			return 'gets the value of the lambda';
	}
	return '';
}

// The arrow from the card before: the return value goes to a caller, the value goes through an async call or a
// lambda, or the ripple goes on in the next function of the slice
function cardLink(change: RippleChange, index: number): SideCard['link'] {
	const b = change.bodies[index];
	const call = b.call;
	const isFirstOfCall = !!call && b.from !== undefined && !change.bodies.slice(0, index)
		.some((p) => p.from === b.from && p.call && sameFile(p.call.file, call.file) && p.call.line === call.line && p.call.col === call.col);
	if (call && isFirstOfCall) {
		const source = change.bodies[b.from!];
		const where = sameFile(source.file, b.file) ? `line ${call.line}` : `${fileName(b.file)}:${call.line}`;
		return { kind: 'return', text: `${bodyLabel(source)} returns to ${b.body.lambda ? 'the ' : ''}${bodyLabel(b)}, ${where}` };
	}
	const entry = b.body.steps.find((s) => s.from < 0 && s.kind !== 'seed');
	if (entry?.kind === 'async') {
		const field = b.body.exits.find((e) => e.kind === 'member' && e.followed && e.line === entry.line);
		return { kind: 'async', text: `async call: ${entry.via}. The value comes back ${field ? `through ${field.text}` : 'later'}.` };
	}
	if (entry?.kind === 'lambda') {
		return { kind: 'lambda', text: `the value of the lambda goes to line ${entry.line}` };
	}
	if (b.body.lambda) {
		return { kind: 'lambda', text: `the lambda on line ${b.body.lambda.line} gets the value` };
	}
	return { kind: 'next', text: `the ripple goes on in ${bodyLabel(b)}` };
}

function storyCard(change: RippleChange, index: number, changed: Map<number, [number, number] | undefined>, rowOf: RowSource): SideCard {
	const b = change.bodies[index];
	const isChangedBody = b.depth === 0 && sameFile(b.file, change.file);
	// the functions that the return value goes to
	const callers = new Set(change.bodies.filter((c) => c.from === index).map((c) => functionKey(fileKey(c.file), c.body.function))).size;
	const returnLines = new Set(b.body.exits.filter((e) => e.kind === 'return' && !e.followed).map((e) => e.line));
	const rows: SideCardRow[] = [];
	let lastNote: string | undefined;
	for (const p of cardPlan(b)) {
		if (p.fold !== undefined) {
			rows.push({ line: p.line, text: '', spans: [], fold: p.fold, wave: -1 });
			lastNote = undefined;
			continue;
		}
		const source = rowOf(b.file, p.line);
		const row: SideCardRow = { line: p.line, text: source?.text ?? '', spans: source?.spans ?? [], wave: -1 };
		const s = p.step;
		if (s) {
			const isChange = isChangedBody && changed.has(p.line);
			row.wave = b.offset + s.distance;
			row.kind = s.kind;
			row.isEstimated = s.confidence === 'estimated';
			row.isChange = isChange || undefined;
			row.changed = isChange ? changed.get(p.line) : undefined;
			if (p.line === s.line) {
				const why = callers > 0 && returnLines.has(p.line) ? `returns to ${plural(callers, 'caller', 'callers')}` : stepNote(b, s, isChange);
				row.why = why;
				row.note = why !== lastNote ? why : undefined;
				lastNote = why;
			}
		}
		rows.push(row);
	}
	const exits = b.body.exits
		.filter((e) => !e.followed && !(e.kind === 'return' && callers > 0))
		.map((e) => ({ line: e.line, kind: e.kind, text: EXIT_TEXT[e.kind](e.text) }));
	const waves = rows.filter((r) => r.wave >= 0).map((r) => r.wave);
	return {
		file: b.file,
		name: fileName(b.file),
		label: bodyLabel(b),
		line: b.body.lambda?.line ?? b.body.function.range.begin.line,
		depth: b.depth,
		rows,
		exits,
		link: index > 0 ? cardLink(change, index) : undefined,
		isChange: isChangedBody && rows.some((r) => r.isChange),
		isEstimated: b.body.steps.length > 0 && b.body.steps.every((s) => s.confidence === 'estimated'),
		wave: waves.length > 0 ? Math.min(...waves) : 0,
	};
}

// The bodies of a change in the order of a tree: each body comes before its callers, and the callers of a body come
// before the next body of the same level. The ripple finds the bodies level by level
export function treeOrder(bodies: readonly RippleBody[]): number[] {
	const callers = new Map<number, number[]>();
	const roots: number[] = [];
	bodies.forEach((b, i) => {
		if (b.from === undefined || b.from < 0 || b.from >= i) {
			roots.push(i);
		} else {
			callers.set(b.from, [...(callers.get(b.from) ?? []), i]);
		}
	});
	const out: number[] = [];
	const visit = (i: number): void => {
		out.push(i);
		(callers.get(i) ?? []).forEach(visit);
	};
	roots.forEach(visit);
	return out;
}

function storyChange(layer: RippleLayerState, change: RippleChange, rowOf: RowSource): SideStoryChange {
	const diff = diffRows(change.file, changeHunks(layer, change), rowOf);
	// the changed characters of each changed line, for the cards
	const changed = new Map<number, [number, number] | undefined>(change.lines.map((line) => [line, undefined]));
	for (const row of diff) {
		if (row.kind === 'added' && changed.has(row.line)) {
			changed.set(row.line, row.changed);
		}
	}
	const cards = treeOrder(change.bodies).map((i) => storyCard(change, i, changed, rowOf));

	const steps = new Set(change.bodies.flatMap((b) => b.body.steps.map((s) => `${fileKey(b.file)}:${s.line}`))).size;
	const functions = new Set(change.bodies.map((b) => functionKey(fileKey(b.file), b.body.function))).size;
	const files = new Set(change.bodies.map((b) => fileKey(b.file))).size;
	const asyncCount = change.bodies.reduce((n, b) => n + b.body.exits.filter((e) => e.kind === 'async').length, 0);
	const exits = cards.reduce((n, c) => n + c.exits.length, 0);
	const waves = cards.flatMap((c) => c.rows.map((r) => r.wave));
	return {
		file: change.file,
		name: fileName(change.file),
		label: withBrackets(functionTitle(change.fn)),
		line: change.lines[0] ?? change.fn.range.begin.line,
		diff,
		stats: [
			plural(change.lines.length, 'line changed', 'lines changed'),
			plural(functions, 'function', 'functions'),
			...(files > 1 ? [plural(files, 'file', 'files')] : []),
			...(asyncCount > 0 ? [plural(asyncCount, 'async boundary', 'async boundaries')] : []),
			plural(steps, 'step', 'steps'),
			plural(exits, 'exit', 'exits'),
		],
		cards,
		waves: Math.max(0, ...waves) + 1,
	};
}

// The story of the review. Null if no review ran.
export function buildSideStory(review: ReviewState | undefined, layer: RippleLayerState | undefined, rowOf: RowSource,
	seq: number): SideStory | null {
	if (!review) {
		return null;
	}
	return {
		base: review.base,
		target: review.target,
		isRunning: review.isRunning,
		message: review.message,
		notice: review.notice,
		changes: layer ? layer.model.changes.map((c) => storyChange(layer, c, rowOf)) : [],
		other: review.other.map((o) => ({ file: o.path, name: o.file, text: o.text })),
		seq,
	};
}

// The ripple in a file, for the file view: the changed lines, the lines that the changes reach, and the hints
export function buildSideRipple(layer: RippleLayerState | undefined, file: string | undefined): SideRipple | null {
	if (!layer || !file) {
		return null;
	}
	const lines = new Map<number, { line: number; isChange: boolean; isEstimated: boolean }>();
	const hints: { line: number; text: string }[] = [];
	for (const [key, view] of buildRippleViews(layer.model)) {
		if (!sameFile(key, file)) {
			continue;
		}
		for (const l of view.lines) {
			const old = lines.get(l.line + 1);
			lines.set(l.line + 1, {
				line: l.line + 1, isChange: l.isChange || !!old?.isChange, isEstimated: l.confidence === 'estimated' && (old?.isEstimated ?? true),
			});
		}
		hints.push(...view.hints.map((h) => ({ line: h.line + 1, text: h.text })));
	}
	return lines.size > 0 ? { file, lines: [...lines.values()].sort((a, b) => a.line - b.line), hints } : null;
}
