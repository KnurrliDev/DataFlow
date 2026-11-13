import type * as Api from '../../api/dataflow-api';
import type { StructureAccess, StructureBranch, StructureModel, StructureStatement } from '../engine/client';
import { CodePlace, findCode, textBetween } from '../side/details';
import { functionTitle, withBrackets } from '../side/names';
import type {
	SideCommentColor, SideItemAction, SideModel, SideModelBlock, SideModelComment, SideModelDetail, SideModelExtra, SideModelNote, SideNoteKind,
} from '../side/protocol';

// The logical blocks of a language model. A model groups the statements of a function and gives each group a name and a
// summary. DataFlow moves the lines of each block to whole statements, and it calculates the data that goes into the
// block and comes out of it from the accesses of the engine. The engine keeps the facts, and the model adds the words.
// Lines start at 1.

export interface ModelBlockInput {
	lines: [number, number];
	title: string;
	summary?: string;
	children?: ModelBlockInput[];
}

export interface ModelNoteInput {
	lines?: [number, number];
	block?: string; // the id of a block, for example 5b
	function?: string; // the function of the block, if more functions have a block with the id
	kind?: string;
	note: string;
	actions?: unknown; // the buttons of an extension: [{ id, title }]
}

export interface ModelCommentInput {
	line: number;
	text: string;
	color?: string;
}

export interface ModelDetailInput {
	line?: number; // the first line of the code. With no line, the selection of the user
	expression?: string; // the code. With no expression, the line
	title?: string;
	text: string;
	actions?: unknown; // the buttons of an extension: [{ id, title }]
}

export interface BlockData {
	ins: string[]; // read in the block and set before it
	outs: string[]; // written in the block and used after it, or visible to the caller
	extra: SideModelExtra[]; // the exits, the thread starts, the events and the calls of the block
}

export interface SnapResult {
	blocks: SideModelBlock[]; // in the sequence of the lines, each block before its children
	problems: string[]; // if there is a problem, the view does not change
}

const MAX_TITLE = 80;
const MAX_SUMMARY = 400;
const MAX_NOTE = 300;
const MAX_COMMENT = 200;

// The levels of blocks: the blocks of the function, and four levels of children
export const MAX_BLOCK_LEVELS = 5;
// The comments in one file
export const MAX_COMMENTS = 2000;
export const COMMENT_COLORS: readonly SideCommentColor[] = ['blue', 'green', 'purple', 'yellow', 'orange', 'red', 'gray'];
// The details in one file, the lines of the code of a detail, and the length of a text
export const MAX_DETAILS = 300;
export const MAX_DETAIL_LINES = 40;
export const MAX_DETAIL_TEXT = 4000;
// The buttons of an item of an extension, and the length of their ids and titles
export const MAX_ACTIONS = 3;
const MAX_ACTION_ID = 64;
const MAX_ACTION_TITLE = 40;

// The buttons of an item: a list of a maximum of MAX_ACTIONS objects with an id and a title. The ids of one item are
// different. A problem goes to problems with the name of the item. Undefined for no buttons
export function resolveActions(input: unknown, name: string, problems: string[]): SideItemAction[] | undefined {
	if (input === undefined || input === null) {
		return undefined;
	}
	const isAction = (a: unknown): a is { id: string; title: string } => !!a && typeof a === 'object'
		&& typeof (a as { id?: unknown }).id === 'string' && !!(a as { id: string }).id.trim()
		&& typeof (a as { title?: unknown }).title === 'string' && !!(a as { title: string }).title.trim();
	if (!Array.isArray(input) || input.length > MAX_ACTIONS || !input.every(isAction)) {
		problems.push(`${name}: "actions" must be a list of a maximum of ${MAX_ACTIONS} objects with "id" and "title".`);
		return undefined;
	}
	const out = input.map((a) => ({ id: clip(a.id.trim(), MAX_ACTION_ID), title: clip(a.title.trim(), MAX_ACTION_TITLE) }));
	if (new Set(out.map((a) => a.id)).size !== out.length) {
		problems.push(`${name}: the actions must have different ids.`);
		return undefined;
	}
	return out.length > 0 ? out : undefined;
}

// The items with ids: an item with no id gets the next number after the largest id with the prefix, for example n3
// after n2. The order stays
export function withIds<T extends { id?: string }>(items: readonly T[], prefix: string, after: readonly { id?: string }[] = []): T[] {
	const numberOf = (id?: string) => (id?.startsWith(prefix) ? Number(id.slice(prefix.length)) || 0 : 0);
	let last = Math.max(0, ...after.map((x) => numberOf(x.id)), ...items.map((x) => numberOf(x.id)));
	return items.map((x) => (x.id ? x : { ...x, id: `${prefix}${++last}` }));
}

// A layer with ids on all its notes and comments, for example a layer of an older version
export function withLayerIds(layer: SideModel): SideModel {
	const notes = layer.notes.some((n) => !n.id) ? withIds(layer.notes, 'n') : layer.notes;
	const comments = layer.comments.some((c) => !c.id) ? withIds(layer.comments, 'c') : layer.comments;
	return notes === layer.notes && comments === layer.comments ? layer : { ...layer, notes, comments };
}

// The owner of a layer: its client, else the model
export const ownerOf = (layer: { client?: string }): string => layer.client ?? 'model';

// The layers of the clients in one file as one layer for the side view, in the sequence of the layers. Each item gets
// its client. With two clients or more, the ids get the name of their client, for example claude-code:2a. The bars of
// the blocks of each client go into the columns after the columns of the clients before it, so they stand side by side
export function mergeModelLayers(layers: readonly SideModel[]): SideModel | null {
	if (layers.length === 0) {
		return null;
	}
	const clients = layers.map(ownerOf);
	// the names of the clients for the user. A layer with no client has no name
	const names = layers.flatMap((l) => (l.client ? [l.client] : []));
	const isMany = layers.length > 1;
	const out: SideModel = {
		file: layers[0].file, ...(names.length > 0 ? { client: names.join(', ') } : {}), clients, blocks: [], notes: [], comments: [], details: [],
		...(layers.length === 1 && layers[0].fn ? { fn: layers[0].fn } : {}),
	};
	let levels = 0;
	layers.forEach((layer, i) => {
		const client = clients[i];
		const id = (x: string) => (isMany ? `${client}:${x}` : x);
		out.blocks.push(...layer.blocks.map((b) => ({
			...b, id: id(b.id), column: b.level + levels, client, ...(b.parent ? { parent: id(b.parent) } : {}),
		})));
		out.notes.push(...layer.notes.map((n) => ({
			...n, client, ...(n.id ? { id: id(n.id) } : {}),
			...(n.block ? { block: id(n.block), blockFn: n.blockFn ?? layer.fn } : {}),
		})));
		out.comments.push(...layer.comments.map((c) => ({ ...c, client, ...(c.id ? { id: id(c.id) } : {}) })));
		out.details.push(...layer.details.map((d) => ({ ...d, client, id: id(d.id) })));
		levels += layer.blocks.reduce((n, b) => Math.max(n, b.level + 1), 0);
	});
	out.blocks.sort((a, b) => a.first - b.first || a.level - b.level);
	out.notes.sort((a, b) => a.first - b.first || a.last - b.last);
	out.comments.sort((a, b) => a.line - b.line);
	out.details.sort((a, b) => a.line - b.line || a.col - b.col);
	return out;
}

// A unit of the statements: a statement, or a branch of an if chain or of a switch
interface Unit {
	first: number;
	last: number;
	children: Unit[];
}

function statementUnit(s: StructureStatement): Unit {
	const children = s.branches?.length ? s.branches.map(branchUnit) : (s.body ?? []).map(statementUnit);
	return { first: s.first, last: s.last, children };
}

function branchUnit(b: StructureBranch): Unit {
	return { first: b.first, last: b.last, children: b.statements.map(statementUnit) };
}

const overlapping = (units: Unit[], first: number, last: number) => units.filter((u) => u.last >= first && u.first <= last);

// The lines of the function
export function functionLines(model: StructureModel): [number, number] {
	return [model.function.range.begin.line, model.function.range.end.line];
}

const isLines = (v: unknown): v is [number, number] =>
	Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]) && v[0] <= v[1];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// A block id: 1, 2, ... for the blocks of the function. A child adds a letter to the id of its parent, and a child of a
// child adds a number: 5, 5a, 5a1, 5a1b. After a level with more than 26 children, the ids use points: 5.27, 5.27.1
function idOf(index: number, level: number, parent?: string): string {
	if (parent === undefined) {
		return String(index + 1);
	}
	if (parent.includes('.')) {
		return `${parent}.${index + 1}`;
	}
	if (level % 2 === 0) {
		return `${parent}${index + 1}`;
	}
	return index < 26 ? `${parent}${String.fromCharCode(97 + index)}` : `${parent}.${index + 1}`;
}

// Moves the blocks of the model to whole statements and adds the data of each block. A block of the function covers
// the statements of the function body that its lines touch. A child of a block covers the units in its parent: the
// branches of an if chain, or the statements of a block or a loop. The children of a child obey the same rule, to
// MAX_BLOCK_LEVELS levels. Blocks of the same level must not overlap. Each block gets the title of the function, fn
export function snapBlocks(model: StructureModel, input: ModelBlockInput[], fn = functionTitle(model.function, true)): SnapResult {
	const problems: string[] = [];
	const blocks: SideModelBlock[] = [];
	const bounds = functionLines(model);
	if (!Array.isArray(input) || input.length === 0) {
		return { blocks, problems: ['Give at least one block.'] };
	}

	// one level of blocks in the units, in the sequence of the lines
	const placeLevel = (list: ModelBlockInput[], units: Unit[], range: [number, number], level: number, parent?: SideModelBlock) => {
		const placed: { block: SideModelBlock; covered: Unit[]; input: ModelBlockInput }[] = [];
		list.forEach((b, i) => {
			const name = parent ? `Child ${i + 1} of block ${parent.id}` : `Block ${i + 1}`;
			if (!b || typeof b !== 'object' || !isLines(b.lines)) {
				problems.push(`${name}: "lines" must be [first, last] with first <= last.`);
				return;
			}
			if (typeof b.title !== 'string' || !b.title.trim()) {
				problems.push(`${name}: "title" must be a text.`);
				return;
			}
			const [a, z] = b.lines;
			if (z < range[0] || a > range[1]) {
				problems.push(`${name}: lines ${a}-${z} are outside of ${parent ? `block ${parent.id}` : 'the function'} (${range[0]}-${range[1]}).`);
				return;
			}
			const from = Math.max(a, range[0]);
			const to = Math.min(z, range[1]);
			const covered = overlapping(units, from, to);
			const first = covered.length > 0 ? Math.min(...covered.map((u) => u.first)) : from;
			const last = covered.length > 0 ? Math.max(...covered.map((u) => u.last)) : to;
			const block: SideModelBlock = {
				id: '',
				fn,
				level,
				first,
				last,
				title: clip(b.title.trim(), MAX_TITLE),
				summary: clip(typeof b.summary === 'string' ? b.summary.trim() : '', MAX_SUMMARY),
				...blockData(model, first, last),
				...(first !== a || last !== z ? { from: [a, z] as [number, number] } : {}),
				...(parent ? { parent: parent.id } : {}),
			};
			placed.push({ block, covered, input: b });
		});
		placed.sort((x, y) => x.block.first - y.block.first || x.block.last - y.block.last);
		placed.forEach((p, i) => {
			p.block.id = idOf(i, level, parent?.id);
		});
		for (let i = 1; i < placed.length; i++) {
			const [x, y] = [placed[i - 1].block, placed[i].block];
			if (y.first <= x.last) {
				problems.push(`Blocks ${x.id} (${x.first}-${x.last}) and ${y.id} (${y.first}-${y.last}) overlap after DataFlow moved them to whole statements.`);
			}
		}
		return placed;
	};

	// a level, and after each block its children
	const place = (list: ModelBlockInput[], units: Unit[], range: [number, number], level: number, parent?: SideModelBlock) => {
		for (const { block, covered, input: b } of placeLevel(list, units, range, level, parent)) {
			blocks.push(block);
			if (b.children === undefined || (Array.isArray(b.children) && b.children.length === 0)) {
				continue;
			}
			if (!Array.isArray(b.children)) {
				problems.push(`Block ${block.id}: "children" must be a list of blocks.`);
				continue;
			}
			if (level + 1 >= MAX_BLOCK_LEVELS) {
				problems.push(`Block ${block.id}: the view shows ${MAX_BLOCK_LEVELS} levels of blocks. Give the blocks of level ${MAX_BLOCK_LEVELS} no children.`);
				continue;
			}
			// the children of one statement are its branches or its statements. The children of more statements are statements.
			// A single unit gives its own units, for example the one branch of an if with no else gives its statements
			let inner = covered.length === 1 ? covered[0].children : covered;
			while (inner.length === 1 && inner[0].children.length > 0) {
				inner = inner[0].children;
			}
			place(b.children, inner, [block.first, block.last], level + 1, block);
		}
	};
	place(input, model.statements.map(statementUnit), bounds, 0);
	return { blocks, problems };
}

// path covers sub: a write of charge covers a read of charge.is_dirty and of charge.optimizers[].kw
const covers = (path: string, sub: string) => sub === path || sub.startsWith(`${path}.`) || sub.startsWith(`${path}[`);
const related = (a: string, b: string) => covers(a, b) || covers(b, a);
const isRead = (a: StructureAccess) => a.role === 'read' || a.role === 'readwrite';

// The data of the lines first to last of the function: what goes in, what comes out, and the items of the statements
export function blockData(model: StructureModel, first: number, last: number): BlockData {
	const fnLast = functionLines(model)[1];
	const inside = model.accesses.filter((a) => a.line >= first && a.line <= last);
	const after = model.accesses.filter((a) => a.line > last && a.line <= fnLast);

	// in: a read of a path that the block did not write or declare before the read
	const ins: string[] = [];
	const defined: string[] = [];
	for (const a of inside) {
		if (isRead(a) && !defined.some((d) => covers(d, a.path)) && !ins.includes(a.path)) {
			ins.push(a.path);
		}
		if (a.role !== 'read') {
			defined.push(a.path);
		}
	}

	// out: a write whose value a read outside of the block gets. The engine gives the reads that each write reaches over
	// the control flow, so a write that each path writes again before the read is not out. A read in a later turn of a
	// loop can be on a line before the block. With no lines from the engine, for example for a captured variable in a
	// lambda, a later read before a new declaration of the name counts. A member, a global and a field of a parameter are
	// visible to the caller.
	const outs: string[] = [];
	for (const a of inside) {
		if (a.role === 'read' || outs.includes(a.path)) {
			continue;
		}
		const isVisible = a.scope === 'member' || a.scope === 'global' || (a.scope === 'param' && (a.path.includes('.') || a.role === 'readwrite'));
		const isReadOutside = a.reaches ? a.reaches.some((l) => l < first || l > last) : isUsedAfter(a.path, after);
		if (isVisible || isReadOutside) {
			outs.push(a.path);
		}
	}
	return { ins, outs, extra: itemsOf(model.statements, first, last) };
}

// The rule for a write with no lines from the engine. A later write does not stop the search: it can be in a branch, and
// the lines show no control flow. So the result can have a write that each path writes again before the read.
function isUsedAfter(path: string, after: StructureAccess[]): boolean {
	const root = path.split('.')[0];
	for (const a of after) {
		if (isRead(a) && related(a.path, path)) {
			return true;
		}
		// a new variable with the same name, for example in the next branch
		if (a.role === 'decl' && a.path === root) {
			return false;
		}
	}
	return false;
}

// The exits, the thread starts, the events and the calls on the lines. A statement of the function body has the items
// of the statements in it, so the items of the top-level statements are enough.
function itemsOf(statements: StructureStatement[], first: number, last: number): SideModelExtra[] {
	const out: SideModelExtra[] = [];
	const seen = new Set<string>();
	const add = (item: SideModelExtra) => {
		const key = `${item.kind}:${item.line}:${item.text}`;
		if (item.line >= first && item.line <= last && !seen.has(key)) {
			seen.add(key);
			out.push(item);
		}
	};
	for (const s of statements) {
		if (s.last < first || s.first > last) {
			continue;
		}
		s.exits.forEach((e) => add({ kind: 'exit', line: e.line, text: e.kind }));
		s.threads.forEach((t) => add({ kind: 'thread', line: t.line, text: t.runs && t.runs !== 'lambda' ? `${t.via} runs ${t.runs}` : t.via }));
		s.events.forEach((e) => add({ kind: 'event', line: e.line, text: e.name || 'event' }));
		s.calls.forEach((c) => add({ kind: 'call', line: c.line, text: c.name }));
	}
	return out.sort((a, b) => a.line - b.line);
}

const NOTE_KINDS: Record<string, SideNoteKind> = {
	problem: 'problem', error: 'problem', bug: 'problem', race: 'problem',
	warning: 'warning', warn: 'warning', check: 'warning',
	info: 'info', information: 'info', note: 'info',
};

// The notes of the highlight tool. A note on a block gets the lines of the block.
export function resolveNotes(input: ModelNoteInput[], blocks: SideModelBlock[], bounds: [number, number]): { notes: SideModelNote[]; problems: string[] } {
	const notes: SideModelNote[] = [];
	const problems: string[] = [];
	if (!Array.isArray(input) || input.length === 0) {
		return { notes, problems: ['Give at least one range.'] };
	}
	input.forEach((n, i) => {
		const name = `Range ${i + 1}`;
		if (!n || typeof n !== 'object') {
			problems.push(`${name}: give an object with "lines" or "block", "kind" and "note".`);
			return;
		}
		if (typeof n.note !== 'string' || !n.note.trim()) {
			problems.push(`${name}: "note" must be a text.`);
			return;
		}
		let lines: [number, number] | undefined;
		let block: SideModelBlock | undefined;
		if (n.block !== undefined) {
			const id = String(n.block);
			const matches = blocks.filter((b) => b.id === id && (n.function === undefined || isFunction(b.fn, String(n.function))));
			if (matches.length === 0) {
				problems.push(`${name}: no block ${id}${n.function !== undefined ? ` in ${n.function}` : ''}. `
					+ `${blocks.length > 0 ? `The blocks are ${blockList(blocks)}.` : 'Call show_blocks first.'}`);
				return;
			}
			if (matches.length > 1) {
				// overloads have the same name, so only the lines select their blocks
				const fns = [...new Set(matches.map((b) => withBrackets(b.fn)))];
				problems.push(fns.length > 1 ? `${name}: block ${id} is in ${fns.join(' and ')}. Give "function".`
					: `${name}: block ${id} is in ${matches.length} functions with the name ${fns[0]}. Give "lines".`);
				return;
			}
			block = matches[0];
			lines = [block.first, block.last];
		} else if (isLines(n.lines)) {
			lines = n.lines;
		} else {
			problems.push(`${name}: give "lines" as [first, last] or the id of a block in "block".`);
			return;
		}
		if (lines[1] < bounds[0] || lines[0] > bounds[1]) {
			problems.push(`${name}: lines ${lines[0]}-${lines[1]} are outside of the file.`);
			return;
		}
		const kind = NOTE_KINDS[String(n.kind ?? 'info').toLowerCase()] ?? 'info';
		const before = problems.length;
		const actions = resolveActions(n.actions, name, problems);
		if (problems.length > before) {
			return;
		}
		notes.push({
			first: Math.max(lines[0], bounds[0]),
			last: Math.min(lines[1], bounds[1]),
			kind,
			text: clip(n.note.trim(), MAX_NOTE),
			...(block ? { block: block.id, blockFn: block.fn } : {}),
			...(actions ? { actions } : {}),
		});
	});
	return { notes, problems };
}

// True if a name of the model is the function of a title, for example process or power_ctrl::process for
// electricity::power_ctrl::process
function isFunction(title: string, name: string): boolean {
	const a = title.replace(/\(\)$/, '');
	const b = name.trim().replace(/\(\)$/, '');
	return a === b || a.endsWith(`::${b}`);
}

// The ids of the blocks for a problem, with their functions if the blocks are in more than one function
function blockList(blocks: readonly SideModelBlock[]): string {
	const byFn = new Map<string, string[]>();
	for (const b of blocks) {
		byFn.set(b.fn, [...(byFn.get(b.fn) ?? []), b.id]);
	}
	return byFn.size <= 1 ? blocks.map((b) => b.id).join(', ') : [...byFn].map(([fn, ids]) => `${ids.join(', ')} in ${withBrackets(fn)}`).join('; ');
}

// The key of a block in a function: the function and the id. Two overloads of a function have the same keys
const blockKey = (fn: string | undefined, id: string) => `${fn ?? ''}#${id}`;

// For each block in the sequence of the lines: true if the block stays. A block goes if isKept gives false, or if its
// parent goes. The parent of a child is the last block before it with the id of the parent, because two overloads of a
// function have the same name and the same ids
function keptBlocks(blocks: readonly SideModelBlock[], isKept: (index: number) => boolean): boolean[] {
	const latest = new Map<string, boolean>();
	return blocks.map((b, i) => {
		const kept = (b.parent === undefined || latest.get(blockKey(b.fn, b.parent)) !== false) && isKept(i);
		latest.set(blockKey(b.fn, b.id), kept);
		return kept;
	});
}

// True if the blocks have the block of a note. A note on a block is in the lines of the block
function hasBlock(blocks: readonly SideModelBlock[], note: SideModelNote): boolean {
	return blocks.some((b) => b.id === note.block && b.fn === note.blockFn && b.first <= note.first && note.last <= b.last);
}

// The comments of the comment tool: one short text on a line, in one line of text. Two comments on one line are a
// problem, because the model possibly gave a wrong line
export function resolveComments(input: ModelCommentInput[], bounds: [number, number]): { comments: SideModelComment[]; problems: string[] } {
	const problems: string[] = [];
	if (!Array.isArray(input) || input.length === 0) {
		return { comments: [], problems: ['Give at least one comment.'] };
	}
	if (input.length > MAX_COMMENTS) {
		return { comments: [], problems: [`Give a maximum of ${MAX_COMMENTS} comments.`] };
	}
	const byLine = new Map<number, { comment: SideModelComment; index: number }>();
	input.forEach((c, i) => {
		const name = `Comment ${i + 1}`;
		if (!c || typeof c !== 'object') {
			problems.push(`${name}: give an object with "line" and "text".`);
			return;
		}
		if (!Number.isInteger(c.line) || c.line < bounds[0] || c.line > bounds[1]) {
			problems.push(`${name}: "line" must be a line of the file (${bounds[0]}-${bounds[1]}).`);
			return;
		}
		const text = typeof c.text === 'string' ? c.text.replace(/\s+/g, ' ').trim() : '';
		if (!text) {
			problems.push(`${name}: "text" must be a text.`);
			return;
		}
		const color = c.color === undefined || c.color === null || c.color === '' ? undefined : String(c.color).toLowerCase();
		if (color !== undefined && !COMMENT_COLORS.includes(color as SideCommentColor)) {
			problems.push(`${name}: "color" must be one of ${COMMENT_COLORS.join(', ')}, or no color.`);
			return;
		}
		const old = byLine.get(c.line);
		if (old) {
			problems.push(`Comments ${old.index + 1} and ${i + 1} are on line ${c.line}. Give one comment for each line.`);
			return;
		}
		byLine.set(c.line, { comment: { line: c.line, text: clip(text, MAX_COMMENT), ...(color ? { color: color as SideCommentColor } : {}) }, index: i });
	});
	const comments = [...byLine.values()].map((v) => v.comment).sort((a, b) => a.line - b.line);
	return { comments, problems };
}

// The comments of a layer with more comments. A new comment on a line replaces the old comment of the line
export function mergeComments(old: readonly SideModelComment[], added: readonly SideModelComment[]): SideModelComment[] {
	const byLine = new Map(old.map((c) => [c.line, c]));
	for (const c of added) {
		byLine.set(c.line, c);
	}
	return [...byLine.values()].sort((a, b) => a.line - b.line);
}

// The code of a detail: the expression on the line or near it, the line with no white space at its ends, or the
// selection of the user. The result has no id
export function resolveDetail(input: ModelDetailInput, textOf: (line: number) => string | undefined, lineCount: number, selection?: CodePlace): {
	detail?: Omit<SideModelDetail, 'id'>;
	problem?: string;
} {
	if (!input || typeof input.text !== 'string' || !input.text.trim()) {
		return { problem: '"text" must be a text.' };
	}
	let place: CodePlace | undefined;
	const expression = typeof input.expression === 'string' && input.expression.trim() ? input.expression : undefined;
	if (input.line === undefined) {
		if (!selection) {
			return { problem: 'The user selected no code. Give "line", and "expression" for a part of the line.' };
		}
		place = selection;
	} else if (!Number.isInteger(input.line) || input.line < 1 || input.line > lineCount) {
		return { problem: `"line" must be a line of the file (1-${lineCount}).` };
	} else if (expression) {
		const lines = expression.split(/\r?\n/).length;
		place = findCode(textOf, expression, { line: input.line, col: 0 }, [Math.max(1, input.line - 2), Math.min(lineCount, input.line + lines + 1)]);
		if (!place) {
			return { problem: `Line ${input.line} has no "${clip(expression, 80)}": ${(textOf(input.line) ?? '').trim()}` };
		}
	} else {
		const text = textOf(input.line) ?? '';
		const col = text.length - text.trimStart().length;
		if (col === text.length) {
			return { problem: `Line ${input.line} is empty. Give a line with code.` };
		}
		place = { line: input.line, col, endLine: input.line, endCol: text.trimEnd().length };
	}
	if (place.endLine - place.line + 1 > MAX_DETAIL_LINES) {
		return { problem: `A detail is for an expression or a few statements. Give a maximum of ${MAX_DETAIL_LINES} lines.` };
	}
	const code = textBetween(textOf, place);
	if (!code || !code.trim()) {
		return { problem: 'The code of the detail is empty.' };
	}
	const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : code.replace(/\s+/g, ' ').trim();
	const problems: string[] = [];
	const actions = resolveActions(input.actions, 'The detail', problems);
	if (problems.length > 0) {
		return { problem: problems[0] };
	}
	return { detail: { ...place, code, title: clip(title, MAX_TITLE), text: clip(input.text.trim(), MAX_DETAIL_TEXT), ...(actions ? { actions } : {}) } };
}

// The details of a layer with one more detail. A detail on the same code replaces the old detail. A new detail gets
// the next free id
export function addDetail(old: readonly SideModelDetail[], added: Omit<SideModelDetail, 'id'>): { details: SideModelDetail[]; id: string } {
	const isSame = (d: CodePlace) => d.line === added.line && d.col === added.col && d.endLine === added.endLine && d.endCol === added.endCol;
	const same = old.find(isSame);
	const id = same?.id ?? `d${Math.max(0, ...old.map((d) => Number(d.id.slice(1)) || 0)) + 1}`;
	const details = [...old.filter((d) => !isSame(d)), { id, ...added }].sort((a, b) => a.line - b.line || a.col - b.col);
	return { details, id };
}

//-------------------
// Edits

// A change of a text: the range that the change replaced, with lines and columns from 0, and the new text. VS Code
// gives the changes of one edit from the end of the text to its start, so each range is also a range of the text after
// the changes before it
export interface TextChange {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	text: string;
}

// Moves the lines of the blocks and the notes of a model with the changes of an edit, as the text editor moves its
// decorations. A block, a note or an item whose lines the edit deleted goes away. The function returns the same layer
// if no line moved, and undefined if a change replaced the text from its start to the last line of the layer
export function moveModelLayer(layer: SideModel, changes: readonly TextChange[]): SideModel | undefined {
	let out = layer;
	for (const change of changes) {
		const moved = moveByChange(out, change);
		if (!moved) {
			return undefined;
		}
		out = moved;
	}
	return out;
}

function moveByChange(layer: SideModel, change: TextChange): SideModel | undefined {
	const { start, end } = change.range;
	const added = change.text.split('\n').length - 1; // the number of lines that the new text adds
	const delta = added - (end.line - start.line);
	const lastLine = Math.max(0, ...layer.blocks.map((b) => b.last), ...layer.notes.map((n) => n.last), ...layer.comments.map((c) => c.line),
		...layer.details.map((d) => d.endLine)) - 1;
	if (start.line === 0 && start.character === 0 && end.line >= lastLine && end.line > start.line) {
		return undefined;
	}
	if (start.line > lastLine || (delta === 0 && end.line === start.line)) {
		return layer; // a change below the layer, or a change in one line that adds no line
	}

	// a line from 0 that the change deleted: a line between the two ends of the change, and its first line if the
	// change starts at the start of the line. The last line of the change keeps the text after the change
	const isDeleted = (l: number) => (l > start.line && l < end.line) || (l === start.line && start.character === 0 && end.line > l);
	// the new line of a line from 1. A line in the change goes to the start of the change if it is the first line of a
	// range and the change starts after the start of the line, so the start of the line stays. Else it goes to the last
	// line of the new text, for example after a new line at the start of the line
	const map = (line: number, isFirst: boolean): number => {
		const l = line - 1;
		if (l < start.line) {
			return line;
		}
		if (l > end.line) {
			return line + delta;
		}
		return (isFirst && l === start.line && start.character > 0 ? start.line : start.line + added) + 1;
	};
	// the deleted lines are one range, so a range of lines from 1 goes away if its first and its last line are deleted
	const isGone = (first: number, last: number) => isDeleted(first - 1) && isDeleted(last - 1);

	// a block before its children, so a deleted block takes all levels of its children with it
	const isKept = keptBlocks(layer.blocks, (i) => !isGone(layer.blocks[i].first, layer.blocks[i].last));
	const blocks = layer.blocks.filter((_, i) => isKept[i]).map((b) => ({
		...b,
		first: map(b.first, true),
		last: map(b.last, false),
		extra: b.extra.filter((x) => !isDeleted(x.line - 1)).map((x) => ({ ...x, line: map(x.line, true) })),
		...(b.from ? { from: [map(b.from[0], true), map(b.from[1], false)] as [number, number] } : {}),
	}));
	const notes = layer.notes.filter((n) => !isGone(n.first, n.last)).map((n) => {
		const note: SideModelNote = { ...n, first: map(n.first, true), last: map(n.last, false) };
		if (note.block !== undefined && !hasBlock(blocks, note)) {
			delete note.block;
			delete note.blockFn;
		}
		return note;
	});
	const comments = layer.comments.filter((c) => !isGone(c.line, c.line)).map((c) => ({ ...c, line: map(c.line, true) }));
	// the columns of a detail stay. The side view finds the code of the detail again, if a column moved
	const details = layer.details.filter((d) => !isGone(d.line, d.endLine)).map((d) => ({ ...d, line: map(d.line, true), endLine: map(d.endLine, false) }));
	return { ...layer, blocks, notes, comments, details };
}

//-------------------
// Sessions

// A layer of a model for a later session of VS Code: the layer, and the text of the first and the last line of each
// block and note, with no space at the start and the end
export interface StoredModelLayer {
	layer: SideModel;
	texts: Record<string, string>; // a line from 1 -> its text
}

export function storeModelLayer(layer: SideModel, lineText: (line: number) => string | undefined): StoredModelLayer {
	const texts: Record<string, string> = {};
	const ranges = [...layer.comments.map((c) => ({ first: c.line, last: c.line })), ...layer.details.map((d) => ({ first: d.line, last: d.endLine }))];
	for (const r of [...layer.blocks, ...layer.notes, ...ranges]) {
		for (const line of [r.first, r.last]) {
			const text = lineText(line);
			if (text !== undefined) {
				texts[line] = text.trim();
			}
		}
	}
	return { layer, texts };
}

// Finds the blocks, the notes and the comments of a stored layer in the text of a new session. A block or a note moves
// to the nearest place where its first and its last line have their stored texts, and the items of a block move with
// it. A comment moves to the nearest line with its stored text. A block that the text does not have goes away with its
// children. Returns undefined if nothing stays
export function restoreModelLayer(stored: StoredModelLayer, lineText: (line: number) => string | undefined, lineCount: number): SideModel | undefined {
	const isSame = (line: number, text: string | undefined) => text !== undefined && lineText(line)?.trim() === text;
	const shiftOf = (first: number, last: number): number | undefined => {
		const firstText = stored.texts[first];
		const lastText = stored.texts[last];
		for (let d = 0; d < lineCount; d++) {
			for (const s of d === 0 ? [0] : [d, -d]) {
				if (first + s >= 1 && last + s <= lineCount && isSame(first + s, firstText) && isSame(last + s, lastText)) {
					return s;
				}
			}
		}
		return undefined;
	};

	// a layer of an older version of DataFlow has the function of its blocks only on the layer
	const fnOf = (fn: string | undefined) => fn ?? stored.layer.fn ?? '';
	const olds = stored.layer.blocks.map((b) => ({ ...b, fn: fnOf(b.fn) }));
	const shifts = olds.map((b) => shiftOf(b.first, b.last));
	const isKept = keptBlocks(olds, (i) => shifts[i] !== undefined);
	const blocks: SideModelBlock[] = [];
	olds.forEach((b, i) => {
		const d = shifts[i];
		if (isKept[i] && d !== undefined) {
			blocks.push({
				...b,
				first: b.first + d,
				last: b.last + d,
				extra: b.extra.map((x) => ({ ...x, line: x.line + d })),
				...(b.from ? { from: [b.from[0] + d, b.from[1] + d] as [number, number] } : {}),
			});
		}
	});
	const notes: SideModelNote[] = [];
	for (const n of stored.layer.notes) {
		const d = shiftOf(n.first, n.last);
		if (d === undefined) {
			continue;
		}
		const note: SideModelNote = { ...n, first: n.first + d, last: n.last + d, ...(n.block !== undefined ? { blockFn: fnOf(n.blockFn) } : {}) };
		if (note.block !== undefined && !hasBlock(blocks, note)) {
			delete note.block;
			delete note.blockFn;
		}
		notes.push(note);
	}
	// a layer of an older version of DataFlow has no comments
	const comments: SideModelComment[] = [];
	for (const c of stored.layer.comments ?? []) {
		const d = shiftOf(c.line, c.line);
		if (d !== undefined && !comments.some((x) => x.line === c.line + d)) {
			comments.push({ ...c, line: c.line + d });
		}
	}
	comments.sort((a, b) => a.line - b.line);
	const details: SideModelDetail[] = [];
	for (const x of stored.layer.details ?? []) {
		const d = shiftOf(x.line, x.endLine);
		if (d !== undefined) {
			details.push({ ...x, line: x.line + d, endLine: x.endLine + d });
		}
	}
	return blocks.length > 0 || notes.length > 0 || comments.length > 0 || details.length > 0
		? { ...stored.layer, blocks, notes, comments, details } : undefined;
}

// A list for the model: the first items and the count of the others
function short(list: string[], max = 12): string[] {
	return list.length > max ? [...list.slice(0, max), `${list.length - max} more`] : list;
}

// The statements of the function for the model, with the data of each statement. Lists with no items are not in the
// output, to keep it short. Statements deeper than the third level show only their count.
export function structureSummary(model: StructureModel): Omit<Api.StructureFacts, 'file' | 'parseErrors'> {
	const itemTexts = (s: StructureStatement | { first: number; last: number }) => {
		const items = itemsOf(model.statements, s.first, s.last);
		const of = (kind: SideModelExtra['kind']) => items.filter((i) => i.kind === kind).map((i) => `${i.text} on ${i.line}`);
		const out: Record<string, string[]> = {};
		for (const [key, kind] of [['exits', 'exit'], ['threads', 'thread'], ['events', 'event'], ['calls', 'call']] as const) {
			const list = of(kind);
			if (list.length > 0) {
				out[key] = list;
			}
		}
		return out;
	};
	const data = (first: number, last: number) => {
		const d = blockData(model, first, last);
		return { ...(d.ins.length ? { in: short(d.ins) } : {}), ...(d.outs.length ? { out: short(d.outs) } : {}) };
	};
	const statement = (s: StructureStatement, depth: number): Api.StatementFacts => {
		const nested = (list: StructureStatement[]) => (depth < 2 ? list.map((x) => statement(x, depth + 1)) : `${list.length} statements`);
		return {
			lines: [s.first, s.last],
			kind: s.kind,
			text: s.text,
			...data(s.first, s.last),
			...itemTexts(s),
			...(s.branches?.length ? {
				branches: s.branches.map((b) => ({ lines: [b.first, b.last], label: b.label, ...data(b.first, b.last), statements: nested(b.statements) })),
			} : {}),
			...(s.body?.length ? { body: nested(s.body) } : {}),
		};
	};
	return {
		function: model.function.qualifiedName,
		lines: functionLines(model),
		statements: model.statements.map((s) => statement(s, 0)),
	};
}
