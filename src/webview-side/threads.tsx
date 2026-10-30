import type { SideThreadAccess, SideThreadItem, SideThreads, SideThreadStep } from '../side/protocol';
import { vscode } from './vscode';
import type { Wrap } from './wraps';

// Threads and races in the side view: the tint of the code that runs on a worker thread, the tags on the starts and the
// joins, the boxes of the accesses of the selected item, and the details column with the shared data and the lanes of
// the two threads.

const openPlace = (file: string, line: number, col = 0) => vscode.postMessage({ type: 'openPlace', file, line, col });

export type ThreadHint = { text: string; kind: 'start' | 'join' | 'race' | 'check'; title: string };

export interface ThreadDecorations {
	lanes: Map<number, 'worker' | 'both'>; // the lines of the code on a worker thread. both: the caller thread runs it too
	hints: Map<number, ThreadHint[]>;
	wraps: Map<number, Wrap[]>;
}

// The selected item, or the first item: a race comes first
export function selectedItem(threads: SideThreads | null, key: string | undefined): SideThreadItem | undefined {
	return threads?.items.find((i) => i.key === key) ?? threads?.items[0];
}

export function threadDecorations(threads: SideThreads | null, item: SideThreadItem | undefined): ThreadDecorations {
	const lanes = new Map<number, 'worker' | 'both'>();
	const hints = new Map<number, ThreadHint[]>();
	const wraps = new Map<number, Wrap[]>();
	if (!threads) {
		return { lanes, hints, wraps };
	}
	for (const lane of threads.lanes) {
		for (let line = lane.first; line <= lane.last; line++) {
			if (lanes.get(line) !== 'worker') {
				lanes.set(line, lane.isCaller ? 'both' : 'worker');
			}
		}
	}
	const addHint = (line: number, hint: ThreadHint) => hints.set(line, [...(hints.get(line) ?? []), hint]);
	for (const t of threads.tags) {
		addHint(t.line, { text: t.text, kind: t.kind, title: t.title });
	}
	for (const m of item?.marks ?? []) {
		const cls = `thw thw-${m.lane} thw-${m.role}${m.pair ? ` thw-${m.pair}` : ''}`;
		wraps.set(m.line, [...(wraps.get(m.line) ?? []), { start: m.start, end: m.end, cls }]);
		if (m.hint && m.pair) {
			addHint(m.line, { text: m.hint, kind: m.pair, title: item!.summary });
		}
	}
	return { lanes, hints, wraps };
}

const ROLE_TEXT: Record<string, string> = { def: 'sets', write: 'write', mayWrite: 'can change', check: 'check', read: 'read' };

function Pill({ item }: { item: Pick<SideThreadItem, 'verdict' | 'pill'> }) {
	return <span class={`vpill v-${item.verdict}`}>{item.pill}</span>;
}

// A step of a lane: the line, the role, the function, the code of the line and the note
function Card({ a, extra, text }: { a: SideThreadAccess; extra?: string; text: (file: string, line: number) => string | undefined }) {
	const code = text(a.file, a.line)?.trim();
	return (
		<button type="button" class={`lstep${a.isOrdered ? ' ok' : ''}${extra ? ` ${extra}` : ''}`} title={`Open line ${a.line}`}
			onClick={() => openPlace(a.file, a.line, a.col)}>
			<span class="lmeta">
				<span class="lno">{a.line}</span>
				<span class={`role r-${a.role}`}>{ROLE_TEXT[a.role] ?? a.role}</span>
				<span>{a.fn}</span>
			</span>
			{code && <code class="lcode">{code}</code>}
			{a.note && <span class="lnote">{a.note}</span>}
		</button>
	);
}

function Lanes({ item, threads, text }: { item: SideThreadItem; threads: SideThreads; text: (file: string, line: number) => string | undefined }) {
	const worker = item.thread >= 0 ? threads.threads[item.thread] : undefined;
	const cell = (s: SideThreadStep, i: number) => {
		if (s.kind === 'sync') {
			return (
				<button type="button" key={i} class={`lsync ${s.dir}`} onClick={() => openPlace(s.file, s.line)}>
					{s.dir === 'start' ? `${s.text} →` : `← ${s.text}`}
				</button>
			);
		}
		if (s.kind === 'pair') {
			return [
				<Card a={s.caller} extra={s.verdict} text={text} />,
				<Card a={s.worker} extra={s.verdict} text={text} />,
				<p class={`lpair v-${s.verdict}`}>{s.text}</p>,
			];
		}
		return s.lane === 'caller' ? [<Card a={s} text={text} />, <span />] : [<span />, <Card a={s} text={text} />];
	};
	return (
		<div class="lanes" role="list" aria-label={`The two threads of ${item.label}`}>
			<div class="lhead c-caller">Caller thread</div>
			<div class="lhead c-worker" title={worker ? `${worker.via} on line ${worker.line}` : undefined}>
				{worker ? `Worker · ${worker.label}` : 'Worker thread'}
			</div>
			{item.steps.flatMap(cell)}
		</div>
	);
}

export interface ThreadDetailsProps {
	threads: SideThreads | null;
	selected?: string;
	onSelect: (key: string) => void;
	text: (file: string, line: number) => string | undefined; // the text of a line of the file of the side view
}

// The details column of Threads and races: the threads, the list of the shared data with a verdict, and the lanes of the
// selected item
export function ThreadDetails({ threads, selected, onSelect, text }: ThreadDetailsProps) {
	if (!threads) {
		return (
			<div class="details-body">
				<p class="sub">
					Threads and races shows the code that runs on a different thread, the data that two threads share, and the lock or
					the order that protects each access.
				</p>
			</div>
		);
	}
	if (threads.threads.length === 0) {
		return (
			<div class="details-body">
				<p class="sub">
					No code of this file starts a thread. The analysis finds std::thread, std::jthread, QThread, and the functions of the
					setting dataflow.ripple.asyncFunctions.
				</p>
			</div>
		);
	}
	const item = selectedItem(threads, selected);
	const c = threads.counts;
	const counts = [c.race && `${c.race} ${c.race === 1 ? 'race' : 'races'}`, c.check && `${c.check} to check`, c.safe && `${c.safe} safe`]
		.filter(Boolean).join(', ');
	return (
		<div class="details-body threads">
			<div class="flow-title">
				<strong>Threads and races</strong>
				<span class="sub">{threads.threads.length === 1 ? '1 thread start' : `${threads.threads.length} thread starts`}</span>
			</div>
			<div class="tlist">
				{threads.threads.map((t) => (
					<div class="tstart">
						<button type="button" class="link mono" onClick={() => openPlace(t.file, t.line)}>{t.label}</button>
						<span class="sub">
							{t.via}, line {t.line}{t.isRepeated ? ', more than one at a time' : ''}
							{t.joins.length > 0 ? ` · ${t.joins.map((j) => `${j.kind}() on line ${j.line}`).join(', ')}` : ' · no join'}
						</span>
					</div>
				))}
			</div>
			<div class="sub">{threads.items.length === 1 ? '1 shared item' : `${threads.items.length} shared items`}{counts ? `: ${counts}` : ''}</div>
			{threads.isTruncated && <p class="sub notice">The analysis stopped at a limit. Some code of the file is not a part of it.</p>}
			<div class="titems" role="listbox" aria-label="Shared data">
				{threads.items.map((i) => (
					<button type="button" role="option" class="titem" aria-selected={i.key === item?.key} onClick={() => onSelect(i.key)}>
						<span class="trow"><span class="mono">{i.label}</span><Pill item={i} /></span>
						<span class="sub">Caller: {i.caller} · Worker: {i.worker}</span>
						<span class="sub">Protection: {i.protection}</span>
					</button>
				))}
			</div>
			{item && (
				<div class="tpanel">
					<div class="trow">
						<strong class="mono">{item.label}</strong>
						<Pill item={item} />
						{item.decl && (
							<button type="button" class="link small" onClick={() => openPlace(item.decl!.file, item.decl!.line)}>declaration</button>
						)}
					</div>
					{item.steps.length > 0 && <Lanes item={item} threads={threads} text={text} />}
					<p class="tsum">{item.summary}</p>
					{item.fix && (
						<div class="verdict safe">
							<strong>Possible fix on line {item.fix.line}</strong>
							<p class="sub">{item.fix.text}</p>
							<pre class="fixdiff"><span class="del">- {item.fix.before}</span>{'\n'}<span class="add">+ {item.fix.after}</span></pre>
						</div>
					)}
					<p class="sub">
						The analysis uses the thread starts, the lock guards, the joins and the checks of the handles. It cannot see a state
						that keeps two threads apart, a manual lock() and unlock(), or a lock in a called function.
					</p>
				</div>
			)}
		</div>
	);
}
