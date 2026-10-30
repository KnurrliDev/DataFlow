import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { FromSide, SideCard, SideCardRow, SideRipple, SideRow, SideSettings, SideStory, SideStoryChange } from '../side/protocol';
import { codeParts } from './code';
import { vscode } from './vscode';

// Change Ripple in the side view: the story of each change, as the prototype of the design study. The diff of the change
// comes first, then the facts, then the chain of cards with one card for each function or lambda of the ripple. The
// wave lights the rows and the cards in the sequence of the ripple.

const post = (message: FromSide) => vscode.postMessage(message);

// The wave lights its first step after WAVE_START_MS, and each next step after WAVE_STEP_MS, as in the prototype. A long
// ripple has more steps of the ripple in each step of the wave, to a maximum of WAVE_MAX_STEPS steps.
export const WAVE_START_MS = 250;
export const WAVE_STEP_MS = 420;
const WAVE_MAX_STEPS = 20;
// A card of a caller level is more to the right, for a maximum of MAX_INDENT levels
const MAX_INDENT = 4;

// The ripple in the file view: the classes of the lines and the hints at the ends of the lines
export function rippleDecorations(ripple: SideRipple | null): { lines: Map<number, string>; hints: Map<number, string[]> } {
	const lines = new Map<number, string>();
	const hints = new Map<number, string[]>();
	for (const l of ripple?.lines ?? []) {
		lines.set(l.line, `rp ${l.isEstimated ? 'rp-est' : 'rp-reached'}${l.isChange ? ' rp-change' : ''}`);
	}
	for (const h of ripple?.hints ?? []) {
		hints.set(h.line, [...(hints.get(h.line) ?? []), h.text]);
	}
	return { lines, hints };
}

// The length of the indent that all rows with text have, so that the rows do not start with a large empty part
function commonIndent(texts: string[]): number {
	let indent: string | undefined;
	for (const text of texts) {
		if (text.trim() === '') {
			continue;
		}
		const lead = /^[ \t]*/.exec(text)![0];
		let n = 0;
		while (indent !== undefined && n < Math.min(indent.length, lead.length) && indent[n] === lead[n]) {
			n++;
		}
		indent = indent === undefined ? lead : indent.slice(0, n);
	}
	return indent?.length ?? 0;
}

// A row without its first n characters
function cut(row: SideRow, n: number): SideRow {
	if (n === 0) {
		return row;
	}
	const spans: number[] = [];
	for (let i = 0; i + 2 < row.spans.length; i += 3) {
		const start = Math.max(0, row.spans[i] - n);
		const end = row.spans[i + 1] - n;
		if (end > start) {
			spans.push(start, end, row.spans[i + 2]);
		}
	}
	return { line: row.line, text: row.text.slice(n), spans };
}

// The text of a row with its tokens, and a box on its changed characters
function rowCode(row: SideRow, indent: number, changed: [number, number] | undefined) {
	const box = changed && changed[1] - indent > 0 ? [{ start: Math.max(0, changed[0] - indent), end: changed[1] - indent, cls: 'chg-text' }] : undefined;
	return codeParts(cut(row, indent), undefined, box);
}

const digits = (lines: number[]) => `${Math.max(2, ...lines.map((l) => String(l).length))}ch`;

// A click on a row opens its line in the file view and in the text editor. A selection of text does not.
function onRowClick(file: string) {
	return (e: MouseEvent) => {
		const selection = window.getSelection();
		const row = (e.target as HTMLElement).closest('[data-line]') as HTMLElement | null;
		if ((selection && !selection.isCollapsed) || !row) {
			return;
		}
		post({ type: 'openPlace', file, line: Number(row.dataset.line) });
	};
}

const TARGET_TITLE = 'The target branch is the branch that the active branch merges into. Change Ripple shows the changes since the '
	+ 'merge base of the two branches, and the changes that are not committed. Click to select a different branch.';

// The controls of Change Ripple under the toolbar. The text gets shorter in a narrow side view, so the buttons stay on
// one line. The story shows the name of its change, so the story mode has no text. The button Target shows the target
// branch.
export function RippleBar({ story, isStory, index, onIndex }: { story: SideStory | null; isStory: boolean; index: number; onIndex: (i: number) => void }) {
	const change = story?.changes[index];
	const text = !story ? 'Review the changes of the active branch against its target branch.'
		: story.isRunning ? 'Reviewing the changes…'
		: !isStory && story.changes.length === 1 && change ? `${change.label} ${change.name}:${change.line}` : '';
	const target = story?.target;
	return (
		<div class="lensbar" role="group" aria-label="Change Ripple">
			{story && story.changes.length > 0 && (isStory
				? <button type="button" class="lens" onClick={() => post({ type: 'showFileView' })} title="Show the file of the editor">File view</button>
				: <button type="button" class="lens" onClick={() => post({ type: 'showStory' })} title="Show the story of the review">Story</button>)}
			{story && story.changes.length > 1 && (
				<select class="choice" aria-label="Change" value={String(index)} onChange={(e) => onIndex(Number((e.target as HTMLSelectElement).value))}>
					{story.changes.map((c, i) => <option value={String(i)}>{`${i + 1} of ${story.changes.length}: ${c.label} ${c.name}:${c.line}`}</option>)}
				</select>
			)}
			<span class="sub bar-text" title={text}>{text}</span>
			<button type="button" class="lens target" onClick={() => post({ type: 'command', command: 'dataflow.ripple.selectTarget' })}
				title={story?.base ? `${story.base}\n${TARGET_TITLE}` : TARGET_TITLE}>
				<span>{target ? `Target: ${target}` : 'Target'}</span>
			</button>
			{!story?.isRunning && (
				<button type="button" class="lens" onClick={() => post({ type: 'reviewChanges' })}>{story ? 'Review again' : 'Review changes'}</button>
			)}
			{story && <button type="button" class="lens" onClick={() => post({ type: 'clearReview' })}>Clear</button>}
		</div>
	);
}

// The diff of the changed lines, with the lines of context of the hunks
function DiffView({ change }: { change: SideStoryChange }) {
	const rows = change.diff.filter((r) => r.kind !== 'fold');
	const indent = commonIndent(rows.map((r) => r.text));
	const added = rows.filter((r) => r.kind === 'added').length;
	const removed = rows.filter((r) => r.kind === 'removed').length;
	return (
		<section class="sdiff" aria-label={`Diff of ${change.name}`}>
			<div class="sdiff-bar">
				<span class="sdiff-tab mono">{change.name}</span>
				<span class="sub">{`diff: ${added} added, ${removed} removed`}</span>
				<span class="grow" />
				<button type="button" class="link" onClick={() => post({ type: 'openDiff', file: change.file })}>Open the diff editor</button>
			</div>
			<div class="code-box" style={{ '--gutter': digits(rows.map((r) => r.line)) }} onClick={onRowClick(change.file)}>
				<div class="code-rows">
					{change.diff.map((r) => (r.kind === 'fold' ? (
						<div class="srow fold" data-line={r.at}><span class="ln" /><span class="sign" /><span class="code">{`⋯ ${r.count} lines`}</span></div>
					) : (
						<div class={`srow d-${r.kind}`} data-line={r.at}>
							<span class="ln">{r.line}</span>
							<span class="sign">{r.kind === 'added' ? '+' : r.kind === 'removed' ? '−' : ''}</span>
							<span class="code">{rowCode(r, indent, r.changed)}</span>
						</div>
					)))}
				</div>
			</div>
		</section>
	);
}

// The classes of a row of a card. A row is lit after the wave got to it, and the front of the wave is brighter.
function cardRowClass(r: SideCardRow, step: (wave: number) => number, front: number): string {
	const classes = ['srow'];
	if (r.wave < 0) {
		classes.push('ctx');
	} else {
		if (step(r.wave) <= front) {
			classes.push('lit');
		}
		if (step(r.wave) === front) {
			classes.push('front');
		}
		if (r.isEstimated) {
			classes.push('est');
		}
	}
	if (r.isChange) {
		classes.push('chg');
	}
	return classes.join(' ');
}

// The lines of the rows whose note does not fit beside the code in the visible width of the box. These rows show the
// note under the code. A change of the size of the box measures again in the next frame, after the rows moved
function useNotesUnder(box: { current: HTMLDivElement | null }, card: SideCard): Set<number> {
	const [under, setUnder] = useState<Set<number>>(() => new Set());
	useLayoutEffect(() => {
		const el = box.current;
		if (!el || !card.rows.some((r) => r.note)) {
			setUnder((old) => (old.size === 0 ? old : new Set()));
			return;
		}
		const measure = () => {
			// a hidden story has no width
			if (el.clientWidth === 0) {
				return;
			}
			const left = el.getBoundingClientRect().left + el.clientLeft - el.scrollLeft;
			const next = new Set<number>();
			for (const row of el.querySelectorAll<HTMLElement>('.srow[data-note]')) {
				const code = row.querySelector<HTMLElement>('.code');
				const note = row.querySelector<HTMLElement>('.note') ?? row.nextElementSibling?.querySelector<HTMLElement>('.note');
				if (!code || !note) {
					continue;
				}
				// the note has a margin of 1.5em at its left beside the code
				const gap = 1.5 * parseFloat(getComputedStyle(note).fontSize);
				if (code.getBoundingClientRect().right - left + gap + note.getBoundingClientRect().width > el.clientWidth) {
					next.add(Number(row.dataset.line));
				}
			}
			setUnder((old) => (old.size === next.size && [...next].every((l) => old.has(l)) ? old : next));
		};
		measure();
		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measure);
		});
		observer.observe(el);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [card]);
	return under;
}

function StoryCard({ card, step, front }: { card: SideCard; step: (wave: number) => number; front: number }) {
	const rows = card.rows.filter((r) => r.fold === undefined);
	const indent = commonIndent(rows.map((r) => r.text));
	const first = card.rows.find((r) => r.wave >= 0)?.line ?? card.line;
	const isLit = step(card.wave) <= front;
	const box = useRef<HTMLDivElement>(null);
	const under = useNotesUnder(box, card);
	return (
		<article class={`scard${isLit ? ' lit' : ''}${card.isEstimated ? ' estimated' : ''}${card.depth > 0 ? ' deep' : ''}`} aria-label={card.label}
			style={{ '--depth': String(Math.min(card.depth, MAX_INDENT)) }}>
			<div class="where">
				<button type="button" class="link mono" onClick={() => post({ type: 'openPlace', file: card.file, line: first })}>{card.label}</button>
				<span class="sub">{card.name}:{card.line}</span>
				{card.isChange && <span class="badge k-change">changed</span>}
				{card.depth > 0 && <span class="badge k-caller">{card.depth === 1 ? 'caller' : `caller, level ${card.depth}`}</span>}
				{card.isEstimated && (
					<span class="badge k-estimated" title="The ripple gets here through a field or an async call. These lines can change, but it is not certain.">
						estimated
					</span>
				)}
			</div>
			<div class="code-box" ref={box} style={{ '--gutter': digits(rows.map((r) => r.line)) }} onClick={onRowClick(card.file)}>
				<div class="code-rows">
					{card.rows.map((r) => {
						if (r.fold !== undefined) {
							return <div class="srow fold" data-line={r.line}><span class="ln" /><span class="code">{`⋯ ${r.fold} lines`}</span></div>;
						}
						const cls = cardRowClass(r, step, front);
						const isUnder = !!r.note && under.has(r.line);
						return (
							<Fragment>
								<div class={cls} data-line={r.line} data-note={r.note ? '' : undefined} title={r.why}>
									<span class="ln">{r.line}</span>
									<span class="code">{rowCode(r, indent, r.changed)}</span>
									{r.note && !isUnder && <span class="note">{r.note}</span>}
								</div>
								{isUnder && (
									<div class={`${cls} note-under`} data-line={r.line} title={r.why}>
										<span class="ln" />
										<span class="note">{r.note}</span>
									</div>
								)}
							</Fragment>
						);
					})}
				</div>
			</div>
			{card.exits.length > 0 && (
				<div class="exits">
					<span class="sub">Leaves the card:</span>
					{card.exits.map((e) => (
						<button type="button" class="badge k-exit" title={`Line ${e.line}`} onClick={() => post({ type: 'openPlace', file: card.file, line: e.line })}>
							{e.text}
						</button>
					))}
				</div>
			)}
		</article>
	);
}

// The story of the review. The wave starts again for a new review, for a different change and for "Replay ripple".
export function StoryView({ story, index, settings, animate }: { story: SideStory | null; index: number; settings: SideSettings; animate: boolean }) {
	const change = story?.changes[index];
	const [replay, setReplay] = useState(0);
	// the step of the wave at its front. Infinity after the wave
	const [front, setFront] = useState(Infinity);
	const scale = change ? Math.max(1, Math.ceil(change.waves / WAVE_MAX_STEPS)) : 1;
	const steps = change ? Math.ceil(change.waves / scale) : 0;
	const step = (wave: number) => Math.floor(wave / scale);
	useEffect(() => {
		if (!change || !animate) {
			setFront(Infinity);
			return;
		}
		setFront(-1);
		const timers = Array.from({ length: steps }, (_, s) => window.setTimeout(() => setFront(s), WAVE_START_MS + s * WAVE_STEP_MS));
		timers.push(window.setTimeout(() => setFront(Infinity), WAVE_START_MS + steps * WAVE_STEP_MS + WAVE_STEP_MS));
		return () => timers.forEach((t) => clearTimeout(t));
	}, [story?.seq, index, replay, animate, !!change]);

	const style = {
		'--row-height': `${settings.rowHeight}px`,
		'tabSize': String(settings.tabSize),
		'fontFeatureSettings': settings.ligatures,
		'letterSpacing': `${settings.letterSpacing}px`,
	};
	return (
		<div class="story" style={style}>
			{!story && <div class="empty">Click Review changes. The story shows where each change of the branch goes.</div>}
			{story?.isRunning && <div class="empty">Reviewing the changes…</div>}
			{story?.message && <div class="story-note problem">{story.message}</div>}
			{story?.notice && <div class="story-note">{story.notice}</div>}
			{change && (
				<div class="story-grid">
					<div class="story-left">
						<DiffView change={change} />
						<div class="stats">{change.stats.map((s) => <span class="stat">{s}</span>)}</div>
					</div>
					<section class="story-panel" aria-label="Where the change goes">
						<div class="panel-title">
							<span>Where the change goes</span>
							<button type="button" class="lens" onClick={() => setReplay((r) => r + 1)}>Replay ripple</button>
						</div>
						<div class="chain">
							{change.cards.map((card) => (
								<Fragment>
									{card.link && (
										<div class={`slink k-${card.link.kind}${step(card.wave) <= front ? ' lit' : ''}`}
											style={{ '--depth': String(Math.min(card.depth, MAX_INDENT)) }}>{card.link.text}</div>
									)}
									<StoryCard card={card} step={step} front={front} />
								</Fragment>
							))}
						</div>
					</section>
				</div>
			)}
			{story && story.other.length > 0 && (
				<div class="sub">{story.other.map((o) => <div>{`${o.name}: ${o.text}`}</div>)}</div>
			)}
		</div>
	);
}
