import { useMemo } from 'preact/hooks';
import { anchorDetail, CodePlace, MdInline, parseMarkdown } from '../side/details';
import { isMacroCall } from '../side/names';
import type {
	FromSide, SideCommentColor, SideItemAction, SideMcp, SideModel, SideModelBlock, SideModelComment, SideModelDetail, SideModelExtra, SideModelNote, SideNoteKind,
} from '../side/protocol';
import { vscode } from './vscode';
import type { Wrap } from './wraps';

// The layers of a language model in the side view: a bar beside the line numbers of each block, one bar for each level,
// the title of each block at the end of its first line, the color and the note of each highlighted range, the comments
// on single lines, and the details column with the blocks, the notes and the comments. The model sends the titles, the
// summaries, the notes and the comments through the MCP server of DataFlow. A badge or a star marks them as text of a
// model. The lines and the data of each block come from the engine.

const post = (message: FromSide) => vscode.postMessage(message);

export type ModelTag = { text: string; kind: 'block' | SideNoteKind | 'comment'; title: string; block?: string; color?: SideCommentColor };

// The bar of a block on one of its lines. level: the column of the bar. depth: the level of the block in the blocks of
// its client. client: the index of the client in the layer, for the color of the bar
export interface ModelBarMark {
	level: number;
	depth?: number;
	client?: number;
	isFirst: boolean;
	isLast: boolean;
}

// The name of the client of an item in a text for the user. A layer with no client is the layer of the model
const who = (client: string | undefined) => (client && client !== 'model' ? client : 'the model');

// The id of an item for its client. With two clients or more, the side view puts the name of the client before the ids
export const ownId = (id: string | undefined, client: string | undefined): string | undefined =>
	(id && client && id.startsWith(`${client}:`) ? id.slice(client.length + 1) : id);

// The buttons of a client on a note, a detail or a step. A click sends the id of the button to the extension of the client
export function ItemActions({ actions, owner, kind, item, line, step }: {
	actions?: SideItemAction[]; owner?: string; kind: 'note' | 'detail' | 'step'; item?: string; line?: number; step?: number;
}) {
	if (!actions || actions.length === 0 || !owner) {
		return null;
	}
	return (
		<span class="item-actions" role="group" aria-label={`Actions of ${owner}`}>
			{actions.map((a) => (
				<button type="button" class="link small item-action" title={`${a.title} (${owner})`}
					onClick={(e) => {
						e.stopPropagation();
						e.preventDefault();
						post({
							type: 'clientAction', owner, kind, action: a.id, ...(item ? { item } : {}), ...(line !== undefined ? { line } : {}),
							...(step !== undefined ? { step } : {}),
						});
					}}>
					{a.title}
				</button>
			))}
		</span>
	);
}

export interface ModelDecorations {
	bars: Map<number, ModelBarMark[]>; // the bars on each line, one for each level of block
	levels: number; // the number of levels of the blocks
	notes: Map<number, SideNoteKind>; // the color of each line in a highlighted range
	tags: Map<number, ModelTag[]>; // the titles, the notes and the comments at the end of the lines
}

// A short title of a function for the user, for example process(). The text of a macro call stays
const shortTitle = (fn: string) => (isMacroCall(fn) ? fn : `${fn.split('::').pop()}()`);

// The class of the color of a comment. A comment with no color has the color of the comments of the model
export const commentClass = (color?: SideCommentColor) => (color ? ` mc-${color}` : '');

// The symbol of a detail at the end of the first line of its code
export type DetailMark = { id: string; title: string };

// The places of the details of a model in the text of the side view, the symbols at the end of their first lines, and
// the box of the code of the active detail, whose card shows. Only that detail has a box, so the box cannot hide a box
// of a lens that crosses it. A line after the first line of a detail has the box from its first character that is not
// white space. A detail whose code is not in the text keeps its symbol on its line
export function detailBoxes(model: SideModel | null, textOf: (line: number) => string | undefined, active?: string): {
	wraps: Map<number, Wrap[]>;
	places: Map<string, CodePlace>;
	marks: Map<number, DetailMark[]>;
} {
	const wraps = new Map<number, Wrap[]>();
	const places = new Map<string, CodePlace>();
	const marks = new Map<number, DetailMark[]>();
	for (const d of model?.details ?? []) {
		const p = anchorDetail(d, textOf);
		const line = p?.line ?? d.line;
		marks.set(line, [...(marks.get(line) ?? []), { id: d.id, title: d.title }]);
		if (!p) {
			continue;
		}
		places.set(d.id, p);
		if (d.id !== active) {
			continue;
		}
		for (let line = p.line; line <= p.endLine; line++) {
			const text = textOf(line) ?? '';
			const start = line === p.line ? p.col : text.length - text.trimStart().length;
			const end = line === p.endLine ? p.endCol : text.trimEnd().length;
			if (end > start) {
				wraps.set(line, [...(wraps.get(line) ?? []), { start, end, cls: 'mdetail', detail: d.id }]);
			}
		}
	}
	return { wraps, places, marks };
}

function Inline({ parts }: { parts: MdInline[] }) {
	return (
		<>
			{parts.map((p) => (p.kind === 'code' ? <code>{p.text}</code> : p.kind === 'bold' ? <strong>{p.text}</strong>
				: p.kind === 'italic' ? <em>{p.text}</em> : p.text))}
		</>
	);
}

// The text of a detail: the elements of the small part of Markdown of side/details.ts. The text cannot add HTML
export function Markdown({ text }: { text: string }) {
	const blocks = useMemo(() => parseMarkdown(text), [text]);
	return (
		<div class="md">
			{blocks.map((b) => {
				switch (b.kind) {
					case 'heading':
						return <p class="md-h"><Inline parts={b.parts} /></p>;
					case 'paragraph':
						return <p><Inline parts={b.parts} /></p>;
					case 'list':
						return b.isOrdered
							? <ol>{b.items.map((item) => <li><Inline parts={item} /></li>)}</ol>
							: <ul>{b.items.map((item) => <li><Inline parts={item} /></li>)}</ul>;
					case 'code':
						return <pre><code>{b.text}</code></pre>;
				}
			})}
		</div>
	);
}

// The card of a detail: the title and the text. The mouse can go into the card, for example to scroll a long text or
// to copy an example
export function DetailCard({ detail, left, top, isAbove, onEnter, onLeave }: {
	detail: SideModelDetail;
	left: number;
	top: number;
	isAbove: boolean;
	onEnter: () => void;
	onLeave: () => void;
}) {
	return (
		<div class={isAbove ? 'card detail-card above' : 'card detail-card'} style={{ left: `${left}px`, top: `${top}px` }} role="dialog"
			aria-label={`Detail of ${who(detail.client)}: ${detail.title}`} onMouseEnter={onEnter} onMouseLeave={onLeave}>
			<div class="card-title">
				<span class="mpill">model</span>
				{detail.client && detail.client !== 'model' && <span class="mclient">{detail.client}</span>}
				<span class="detail-title">{detail.title}</span>
			</div>
			<Markdown text={detail.text} />
			<ItemActions actions={detail.actions} owner={detail.client} kind="detail" item={ownId(detail.id, detail.client)} line={detail.line} />
		</div>
	);
}

const NOTE_RANK: Record<SideNoteKind, number> = { problem: 3, warning: 2, info: 1 };

export function modelDecorations(model: SideModel | null): ModelDecorations {
	const bars = new Map<number, ModelBarMark[]>();
	const notes = new Map<number, SideNoteKind>();
	const tags = new Map<number, ModelTag[]>();
	if (!model) {
		return { bars, levels: 0, notes, tags };
	}
	const addTag = (line: number, tag: ModelTag) => tags.set(line, [...(tags.get(line) ?? []), tag]);
	let levels = 0;
	for (const b of model.blocks) {
		// the bars of each client stand in their own columns, after the columns of the clients before it
		const column = b.column ?? b.level;
		const client = b.client ? Math.max(0, model.clients?.indexOf(b.client) ?? 0) : 0;
		levels = Math.max(levels, column + 1);
		for (let line = b.first; line <= b.last; line++) {
			bars.set(line, [...(bars.get(line) ?? []), { level: column, depth: b.level, client, isFirst: line === b.first, isLast: line === b.last }]);
		}
		addTag(b.first, { text: `${b.id} · ${b.title}`, kind: 'block', title: b.summary || b.title, block: b.id });
	}
	for (const n of model.notes) {
		for (let line = n.first; line <= n.last; line++) {
			const old = notes.get(line);
			if (!old || NOTE_RANK[n.kind] > NOTE_RANK[old]) {
				notes.set(line, n.kind);
			}
		}
		addTag(n.first, { text: n.text, kind: n.kind, title: `Note of ${who(n.client)}${n.block ? ` on block ${n.block}` : ''}: ${n.text}`, block: n.block });
	}
	for (const c of model.comments) {
		addTag(c.line, { text: c.text, kind: 'comment', title: `Comment of ${who(c.client)}: ${c.text}`, color: c.color });
	}
	return { bars, levels, notes, tags };
}

// The blocks in the lines of a function. The lines select the blocks, because overloads have the same name
function blocksIn(blocks: readonly SideModelBlock[], range?: [number, number]): SideModelBlock[] {
	return range ? blocks.filter((b) => b.first <= range[1] && b.last >= range[0]) : [];
}

// The bar of the model under the toolbar: the blocks and the note at the line of the cursor. The titles at the end of the
// lines are often outside of the visible part of a narrow side view, so the bar always shows the block of the cursor.
export function ModelBar({ model, cursor, fn, fnRange, onOpen }: {
	model: SideModel; cursor?: number; fn?: string; fnRange?: [number, number]; onOpen: () => void;
}) {
	// the blocks at the cursor: the blocks of each client from the outer block to the inner block, in the sequence of the
	// clients
	const clientIndex = (client?: string) => Math.max(0, model.clients?.indexOf(client ?? '') ?? 0);
	const blocks = cursor === undefined ? [] : model.blocks.filter((b) => b.first <= cursor && cursor <= b.last)
		.sort((a, b) => clientIndex(a.client) - clientIndex(b.client) || a.level - b.level);
	const notes = cursor === undefined ? [] : model.notes.filter((n) => n.first <= cursor && cursor <= n.last);
	const note = notes.sort((a, b) => NOTE_RANK[b.kind] - NOTE_RANK[a.kind])[0];
	const comment = cursor === undefined ? undefined : model.comments.find((c) => c.line === cursor);
	const detail = cursor === undefined ? undefined : model.details.find((d) => d.line <= cursor && cursor <= d.endLine);
	const inner = blocks[blocks.length - 1];
	const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
	// the blocks of the function at the cursor, else the functions with blocks in the file
	const fnBlocks = fn ? blocksIn(model.blocks, fnRange).length : 0;
	const fns = new Set(model.blocks.map((b) => b.fn)).size;
	const where = fn && fnBlocks > 0 ? `${shortTitle(fn)}: ${count(fnBlocks, 'block', 'blocks')}`
		: `The file: ${fns > 1 ? `${fns} functions with blocks` : count(model.blocks.length, 'block', 'blocks')}`;
	return (
		<div class="lensbar modelbar" role="group" aria-label="Blocks of the model">
			<span class="mpill">model</span>
			{inner ? (
				<span class="bar-text mcrumb" title={inner.summary || inner.title}>
					{blocks.map((b, i) => (
						<>
							{i > 0 && <span class="sep">{b.client !== blocks[i - 1].client ? '|' : '›'}</span>}
							<span class="mnum">{b.id}</span>
							<span class="mtitle">{b.title}</span>
						</>
					))}
				</span>
			) : (
				<span class="bar-text sub">
					{where}, {count(model.notes.length, 'note', 'notes')}
					{model.comments.length > 0 ? `, ${count(model.comments.length, 'comment', 'comments')}` : ''}
					{model.details.length > 0 ? `, ${count(model.details.length, 'detail', 'details')}` : ''}.
					{model.blocks.length > 0 ? ' Put the cursor in a block to see its name.' : ''}
				</span>
			)}
			{note && <span class={`mbar-note k-${note.kind}`} title={note.text}>{note.text}</span>}
			{note && <ItemActions actions={note.actions} owner={note.client} kind="note" item={ownId(note.id, note.client)} line={note.first} />}
			{comment && <span class={`mbar-comment${commentClass(comment.color)}`} title={`Comment of ${who(comment.client)}: ${comment.text}`}>{comment.text}</span>}
			{detail && (
				<span class="mbar-detail" title={`Detail of ${who(detail.client)}. Move the mouse on the symbol i at the end of the line to see it.\n\n${detail.text.slice(0, 600)}`}>
					{detail.title}
				</span>
			)}
			{detail && <ItemActions actions={detail.actions} owner={detail.client} kind="detail" item={ownId(detail.id, detail.client)} line={detail.line} />}
			<button type="button" class="lens" onClick={onOpen}>Blocks</button>
		</div>
	);
}

const EXTRA_TEXT: Record<SideModelExtra['kind'], string> = { exit: 'exit', thread: 'thread', event: 'event', call: 'call' };
const MAX_NAMES = 6;

// The names that go in or come out of a block. More names show in the tooltip of the last chip
function Names({ names, cls, title }: { names: string[]; cls: string; title: string }) {
	return (
		<>
			{names.slice(0, MAX_NAMES).map((n) => <span class={`io ${cls}`} title={`${n}: ${title}`}>{n}</span>)}
			{names.length > MAX_NAMES && <span class={`io ${cls} more`} title={names.slice(MAX_NAMES).join(', ')}>{names.length - MAX_NAMES} more</span>}
		</>
	);
}

function BlockData({ block }: { block: SideModelBlock }) {
	if (block.ins.length === 0 && block.outs.length === 0 && block.extra.length === 0) {
		return null;
	}
	return (
		<div class="mdata">
			<Names names={block.ins} cls="in" title="Goes in: read in the block, and set before it" />
			{block.outs.length > 0 && <span class="io arrow" aria-hidden="true">→</span>}
			<Names names={block.outs} cls="out" title="Comes out: written in the block, and used after it or visible to the caller" />
			{block.extra.map((e) => (
				<button type="button" class={`io k-${e.kind}`} title={`Show line ${e.line}`} onClick={() => post({ type: 'revealLine', line: e.line })}>
					{EXTRA_TEXT[e.kind]}: {e.text} on {e.line}
				</button>
			))}
		</div>
	);
}

const lines = (first: number, last: number) => (first === last ? String(first) : `${first}-${last}`);

// The state of the MCP server, with the button that starts it or that copies the setup for Claude Code
function McpStatus({ mcp }: { mcp?: SideMcp }) {
	if (!mcp || mcp.state === 'off') {
		return (
			<div class="mcp-status">
				<span class="sub">The MCP server of DataFlow is off.</span>
				<button type="button" class="link small" onClick={() => post({ type: 'command', command: 'dataflow.mcp.start' })}>Start it</button>
			</div>
		);
	}
	if (mcp.state === 'failed') {
		return <div class="mcp-status"><span class="sub notice">The MCP server did not start: {mcp.error}</span></div>;
	}
	return (
		<div class="mcp-status">
			<span class="sub">MCP server on {mcp.url}{mcp.client ? ` · ${mcp.client} connected` : ''}</span>
			<button type="button" class="link small" onClick={() => post({ type: 'command', command: 'dataflow.mcp.copySetup' })}>Copy the setup</button>
		</div>
	);
}

// The blocks of the function at the cursor, and the notes, the details and the comments of one client in the tab Model
function ClientItems({ model, blocks, lineNotes, details, comments, selected, onSelect }: {
	model: SideModel;
	blocks: SideModelBlock[];
	lineNotes: SideModelNote[];
	details: SideModelDetail[];
	comments: SideModelComment[];
	selected?: string;
	onSelect: (id: string) => void;
}) {
	// a note on a block is in the lines of the block
	const blockNotes = (b: SideModelBlock) => model.notes.filter((n) => n.block === b.id && (n.blockFn ?? model.fn) === b.fn
		&& n.first >= b.first && n.last <= b.last);
	return (
		<>
			{blocks.length > 0 && (
				<div class="mblocks" role="list" aria-label="Logical blocks">
					{blocks.map((b) => {
						const notes = blockNotes(b);
						const kind = notes.find((n) => n.kind === 'problem')?.kind ?? notes[0]?.kind;
						return (
							<div role="listitem" class={`mblock lvl-${Math.min(b.level, 4)}${b.id === selected ? ' sel' : ''}${kind ? ` k-${kind}` : ''}`}>
								<button type="button" class="mhead" title={`Show lines ${lines(b.first, b.last)}`}
									onClick={() => {
										onSelect(b.id);
										post({ type: 'revealLine', line: b.first });
									}}>
									<span class="mnum">{ownId(b.id, b.client)}</span>
									<span class="mtitle">{b.title}</span>
									<span class="mlines">{lines(b.first, b.last)}</span>
								</button>
								{b.summary && <p class="msum">{b.summary}</p>}
								<BlockData block={b} />
								{notes.map((n) => (
									<p class={`mnote k-${n.kind}`}>
										<span class="mpill">model</span>{n.text}
										<ItemActions actions={n.actions} owner={n.client} kind="note" item={ownId(n.id, n.client)} line={n.first} />
									</p>
								))}
								{b.from && <p class="sub small">The model gave lines {lines(b.from[0], b.from[1])}. DataFlow moved them to whole statements.</p>}
							</div>
						);
					})}
				</div>
			)}
			{lineNotes.length > 0 && (
				<div class="mnotes">
					<div class="sub-title">Notes</div>
					{lineNotes.map((n) => (
						<div class="mnote-row">
							<button type="button" class={`mnote k-${n.kind}`} title={`Show line ${n.first}`} onClick={() => post({ type: 'revealLine', line: n.first })}>
								<span class="mlines">{lines(n.first, n.last)}</span>
								<span>{n.text}</span>
							</button>
							<ItemActions actions={n.actions} owner={n.client} kind="note" item={ownId(n.id, n.client)} line={n.first} />
						</div>
					))}
				</div>
			)}
			{details.length > 0 && (
				<div class="mnotes">
					<div class="sub-title">Details</div>
					{details.map((d) => (
						<details class="mdetail-item">
							<summary title={`Show line ${d.line}`} onClick={() => post({ type: 'revealLine', line: d.line })}>
								<span class="mlines">{lines(d.line, d.endLine)}</span> <span class="mtitle">{d.title}</span>
							</summary>
							<Markdown text={d.text} />
							<ItemActions actions={d.actions} owner={d.client} kind="detail" item={ownId(d.id, d.client)} line={d.line} />
						</details>
					))}
				</div>
			)}
			{comments.length > 0 && (
				<div class="mnotes">
					<div class="sub-title">Comments</div>
					{comments.map((c) => (
						<button type="button" class={`mcomment${commentClass(c.color)}`} title={`Show line ${c.line}`} onClick={() => post({ type: 'revealLine', line: c.line })}>
							<span class="mlines">{c.line}</span>
							<span class="mctext">{c.text}</span>
						</button>
					))}
				</div>
			)}
		</>
	);
}

export interface ModelDetailsProps {
	model: SideModel | null;
	isShown: boolean; // the layers show in the code view
	fn?: string; // the function at the cursor
	fnRange?: [number, number]; // the lines of the function at the cursor
	mcp?: SideMcp;
	selected?: string; // the id of the selected block
	onSelect: (id: string) => void;
}

// The details column of the model: the blocks of the function at the cursor with their summaries and their data, and
// the notes, the comments and the details in that function. A list of the functions with blocks goes to each of them.
// With the cursor outside of a function, the column has the notes, the comments and the details of the file
export function ModelDetails({ model, isShown, fn, fnRange, mcp, selected, onSelect }: ModelDetailsProps) {
	if (!model || (model.blocks.length === 0 && model.notes.length === 0 && model.comments.length === 0 && model.details.length === 0)) {
		return (
			<div class="details-body model">
				<p class="sub">
					A language model in an MCP client, for example Claude Code, can show the logical blocks of a function here, with names
					and summaries, notes on lines, comments on single lines, and details with examples in a card on the code. The engine gives the
					lines and the data of each block.
				</p>
				<McpStatus mcp={mcp} />
			</div>
		);
	}
	// the functions with blocks in the sequence of the lines, and the blocks of the function at the cursor
	const fns = [...new Set(model.blocks.map((b) => b.fn))];
	const blocks = fn ? blocksIn(model.blocks, fnRange) : [];
	const active = blocks[0]?.fn;
	const isIn = (first: number, last: number) => !fnRange || (first <= fnRange[1] && last >= fnRange[0]);
	const lineNotes = model.notes.filter((n) => n.block === undefined && isIn(n.first, n.last));
	const details = model.details.filter((d) => isIn(d.line, d.endLine));
	const comments = model.comments.filter((c) => isIn(c.line, c.line));
	const isEmpty = blocks.length === 0 && lineNotes.length === 0 && details.length === 0 && comments.length === 0;
	// with two clients or more, the items of each client are in a group with the name of the client
	const owners: (string | undefined)[] = (model.clients?.length ?? 0) > 1 ? model.clients! : [undefined];
	const of = <T extends { client?: string }>(items: T[], owner?: string) => (owner === undefined ? items : items.filter((x) => x.client === owner));
	return (
		<div class="details-body model">
			<div class="flow-title">
				<strong class="mono" title={fn ?? model.file}>{fn ? shortTitle(fn) : 'The file'}</strong>
				<button type="button" class="link small" onClick={() => post({ type: 'clearModel' })}>Remove model layers</button>
			</div>
			{fns.length > 0 && (fns.length > 1 || !active) && (
				<div class="mfns" role="group" aria-label="Functions with blocks">
					<span class="sub">{fns.length === 1 ? 'Blocks in' : `Blocks in ${fns.length} functions:`}</span>
					{fns.map((f) => {
						const first = model.blocks.find((b) => b.fn === f)!.first;
						return (
							<button type="button" class={f === active ? 'link small mfn current' : 'link small mfn'} title={`Show line ${first}`}
								onClick={() => post({ type: 'revealLine', line: first })}>
								{shortTitle(f)}
							</button>
						);
					})}
				</div>
			)}
			{isEmpty && <p class="sub">{fn ? 'The model gave nothing for this function.' : 'Put the cursor in a function to see its blocks.'}</p>}
			<p class="sub">
				<span class="mpill">model</span> names, summaries, notes, comments and details{model.client ? ` from ${model.client}` : ''} · <span class="epill">engine</span> lines,
				data in and out
			</p>
			{owners.map((owner) => {
				const group = { blocks: of(blocks, owner), lineNotes: of(lineNotes, owner), details: of(details, owner), comments: of(comments, owner) };
				const items = <ClientItems model={model} {...group} selected={selected} onSelect={onSelect} />;
				if (owner === undefined) {
					return items;
				}
				if (group.blocks.length + group.lineNotes.length + group.details.length + group.comments.length === 0) {
					return null;
				}
				return (
					<section class="mgroup" aria-label={`Items of ${owner}`}>
						<div class="mgroup-title"><span class="mclient">{owner}</span></div>
						{items}
					</section>
				);
			})}
			{!isShown && <p class="notice">The layers of the model are hidden in the code. Click Model in the toolbar to show them.</p>}
			<p class="sub">The model can be wrong. Compare its words with the code. The lines and the data come from the engine.</p>
			<McpStatus mcp={mcp} />
		</div>
	);
}
