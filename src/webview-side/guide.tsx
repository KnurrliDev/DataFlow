import { useEffect, useRef } from 'preact/hooks';
import { lexSpans, pairedSpans } from '../side/model';
import type { FromSide, SideDiffRow, SideGuide, SideGuideStatus, SideGuideStep, SideRow, SideSettings, SideStepDiff, SideStepRow } from '../side/protocol';
import { Flames, scoreTitle } from './heat';
import { ItemActions, Markdown } from './model';
import { commonIndent, digits, onRowClick, rowCode } from './ripple';
import { vscode } from './vscode';
import type { Wrap } from './wraps';

// The guide in the side view: a guided review or a diff walk. A bar under the toolbar shows the current step with the
// buttons Back and Next, the tab Guide of the details column shows the plan, and the code view marks the lines of the
// current step. In a guided review, the model sends the plan through the MCP server. In a diff walk, the command of
// DataFlow or the model makes the steps. The code view marks the added and the removed lines of the current step, and
// the tab Guide shows the diff of the step. The user marks each step: OK, issue or question.

const post = (message: FromSide) => vscode.postMessage(message);

const STATUS_ICON: Record<SideGuideStatus, string> = { todo: '', ok: '✓', issue: '!', question: '?' };
const STATUS_NAME: Record<Exclude<SideGuideStatus, 'todo'>, string> = { ok: 'OK', issue: 'Issue', question: 'Question' };

const lineText = (s: SideGuideStep) => (s.first === s.last ? `${s.first}` : `${s.first}-${s.last}`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// True if two paths name the same file. The paths of Windows have no case
export function sameFileName(a: string, b: string | undefined): boolean {
	const key = (f: string) => f.replace(/\\/g, '/').toLowerCase();
	return b !== undefined && key(a) === key(b);
}

// The progress, for example "2 of 5 steps reviewed: 1 issue"
function progressText(guide: SideGuide): string {
	const done = guide.steps.filter((s) => s.status !== 'todo').length;
	const issues = guide.steps.filter((s) => s.status === 'issue').length;
	const questions = guide.steps.filter((s) => s.status === 'question').length;
	const marks = [
		...(issues > 0 ? [issues === 1 ? '1 issue' : `${issues} issues`] : []),
		...(questions > 0 ? [questions === 1 ? '1 question' : `${questions} questions`] : []),
	];
	return `${done} of ${guide.steps.length} steps reviewed${marks.length > 0 ? `: ${marks.join(', ')}` : ''}`;
}

const go = (index: number) => post({ type: 'guideGo', index });

// The marks of a step. A click on the active mark removes it
function StatusButtons({ step, index, isCompact }: { step: SideGuideStep; index: number; isCompact?: boolean }) {
	return (
		<span class="rg-marks" role="group" aria-label="Mark of the step">
			{(['ok', 'issue', 'question'] as const).map((status) => (
				<button
					type="button"
					class={`lens rg-mark st-${status}`}
					aria-pressed={step.status === status}
					title={`Mark the step: ${STATUS_NAME[status]}`}
					onClick={() => post({ type: 'guideStatus', index, status: step.status === status ? 'todo' : status })}
				>
					<span class="rg-icon">{STATUS_ICON[status]}</span>
					{!isCompact && STATUS_NAME[status]}
				</button>
			))}
		</span>
	);
}

// The number of added and removed lines of a step of a diff walk
function DiffStats({ diff }: { diff: SideStepDiff }) {
	return (
		<span class="df-stats" title={`${plural(diff.plus, 'line', 'lines')} added, ${plural(diff.minus, 'line', 'lines')} removed`}>
			<span class="df-plus">+{diff.plus}</span> <span class="df-minus">−{diff.minus}</span>
		</span>
	);
}

// The bar under the toolbar: the step that the side view shows, and the buttons to go to the step before or after it
export function GuideBar({ guide, onOpen }: { guide: SideGuide; onOpen: () => void }) {
	const step = guide.steps[guide.current];
	const last = guide.steps.length - 1;
	const isWalk = guide.kind === 'diff';
	return (
		<div class="lensbar rg-bar" role="group" aria-label={isWalk ? 'Diff walk' : 'Guided review'}>
			<span class="rg-pill">{isWalk ? 'diff' : 'review'}</span>
			<button type="button" class="lens rg-nav" disabled={guide.current <= 0} onClick={() => go(guide.current - 1)} title="The step before">‹ Back</button>
			<span class="rg-pos">{guide.current + 1} / {guide.steps.length}</span>
			<button type="button" class="lens rg-nav" disabled={guide.current >= last} onClick={() => go(guide.current + 1)} title="The next step">Next ›</button>
			<button type="button" class="bar-text rg-title" title={`${step.title}\n\nOpen the plan in the tab Guide`} onClick={onOpen}>
				{step.title}
			</button>
			{step.diff && <DiffStats diff={step.diff} />}
			<StatusButtons step={step} index={guide.current} isCompact />
		</div>
	);
}

// The rows of the diff of a step with their tokens. A row of the file of the side view gets the tokens of the engine if
// its text is the same. A removed row of a pair gets the tokens of its added row in the parts that did not change. The
// other rows get the tokens of the lexer
function diffRowsOf(step: SideGuideStep, file: string | undefined, rows: readonly (SideRow | undefined)[]): SideDiffRow[] {
	const diff = step.diff!;
	const isShown = sameFileName(step.file, file);
	const engineRow = (r: SideStepRow): SideRow | undefined => {
		const row = isShown && (r.kind === 'added' || r.kind === 'context') ? rows[r.line - 1] : undefined;
		return row && row.text === r.text ? row : undefined;
	};
	let runStart = 0; // the first removed row of the run of the row
	return diff.rows.map((r, i) => {
		if (r.kind === 'fold') {
			return { ...r, spans: [] };
		}
		const own = engineRow(r);
		if (own) {
			return { ...r, spans: own.spans };
		}
		if (r.kind === 'removed') {
			const before = diff.rows[i - 1];
			if (!before || before.kind !== 'removed' || before.at !== r.at) {
				runStart = i;
			}
			// removed row k of a run and added row k after the run are a pair
			const pair = diff.rows.find((a) => a.kind === 'added' && a.line === r.at + (i - runStart));
			const pairRow = pair && engineRow(pair);
			if (pairRow) {
				return { ...r, spans: pairedSpans(r.text, pairRow) };
			}
		}
		// a file that is not a C or C++ file gets no tokens of the C++ lexer
		return { ...r, spans: step.fileKind === 'text' ? [] : lexSpans(r.text) };
	});
}

// The note of the user on a step. DataFlow keeps it when the field loses the focus, or with Ctrl+Enter. The saved note
// comes into the field, except while the user writes
function UserNote({ step, index }: { step: SideGuideStep; index: number }) {
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el && document.activeElement !== el) {
			el.value = step.userNote ?? '';
		}
	}, [step.userNote, index]);
	const save = () => {
		const text = ref.current?.value ?? '';
		if (text.trim() !== (step.userNote ?? '')) {
			post({ type: 'guideUserNote', index, note: text });
		}
	};
	return (
		<div class="rg-user-note">
			<label class="sub" for={`rg-user-note-${index}`}>Your note</label>
			<textarea id={`rg-user-note-${index}`} ref={ref} rows={2} placeholder="For example the reason of an issue. The model and the summary get it."
				onBlur={save} onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
						e.preventDefault();
						save();
					}
				}} />
		</div>
	);
}

// The diff of the current step of a diff walk. A click on a row shows its line in the file view and in the text editor
function StepDiff({ step, file, rows, settings }: { step: SideGuideStep; file?: string; rows: readonly (SideRow | undefined)[]; settings: SideSettings }) {
	const shown = diffRowsOf(step, file, rows);
	const indent = commonIndent(shown.filter((r) => r.kind !== 'fold').map((r) => r.text));
	const style = {
		'--row-height': `${settings.rowHeight}px`,
		'--gutter': digits(shown.map((r) => r.line)),
		'tabSize': String(settings.tabSize),
		'fontFeatureSettings': settings.ligatures,
		'letterSpacing': `${settings.letterSpacing}px`,
	};
	return (
		<div class="code-box rg-diff" style={style} onClick={onRowClick(step.file)} aria-label={`Diff of ${step.name}`}>
			<div class="code-rows">
				{shown.map((r) => (r.kind === 'fold' ? (
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
	);
}

// The base of a guide for the tab Guide: the client of the plan and the target branch, or the base of the diff
function sourceText(guide: SideGuide): string {
	if (guide.kind === 'diff') {
		return `${guide.client ? `Plan of ${guide.client}. ` : ''}Changes against ${guide.base ?? 'the base'}`;
	}
	return `Plan of ${guide.client ?? 'the model'}${guide.target ? `, against ${guide.target}` : ''}`;
}

// The tab Guide of the details column: the plan with all steps. The current step shows its text, the diff of a step of a
// diff walk, its checks and the note of the model
export function GuideDetails({ guide, file, rows, settings }: {
	guide: SideGuide | null; file?: string; rows: readonly (SideRow | undefined)[]; settings: SideSettings;
}) {
	// the current step scrolls into the view of the tab, for example after Next in the bar or a step of the model
	const currentRef = useRef<HTMLLIElement>(null);
	useEffect(() => currentRef.current?.scrollIntoView({ block: 'nearest' }), [guide?.current, guide?.seq]);
	if (!guide) {
		return (
			<div class="details-body">
				<p class="sub">
					No guide. Run "DataFlow: Walk Through the Changes", or ask the model for a guided review or a diff walk, for example with the
					prompts guided-review and diff-walk of DataFlow.
				</p>
			</div>
		);
	}
	const isWalk = guide.kind === 'diff';
	const last = guide.steps.length - 1;
	const done = guide.steps.filter((s) => s.status !== 'todo').length;
	return (
		<div class="details-body rg-details">
			<div class="flow-title">
				<strong>{guide.title}</strong>
				<button type="button" class="link small" onClick={() => post({ type: 'guideClose' })}>{isWalk ? 'Close walk' : 'Close review'}</button>
			</div>
			<p class="sub">
				{(!isWalk || guide.client) && <span class="mpill">model</span>}
				{sourceText(guide)}
			</p>
			{guide.below && guide.below.length > 0 && (
				<p class="sub rg-below" role="group" aria-label="Guides under this guide">
					<span>{guide.below.length === 1 ? 'Under this guide:' : `Under this guide, ${guide.below.length} guides:`}</span>
					{guide.below.map((g) => (
						<span class="rg-below-item">
							<button type="button" class="link small" title={`Show the ${g.kind === 'diff' ? 'diff walk' : 'review'} ${g.id}. This guide stays under it.`}
								onClick={() => post({ type: 'guideShow', id: g.id })}>
								{g.title}
							</button>
							<span class="rg-owner">({g.owner})</span>
						</span>
					))}
				</p>
			)}
			{guide.summary && <p>{guide.summary}</p>}
			<div class="rg-progress">
				<span class="sub">{progressText(guide)}</span>
				<span class="rg-track" aria-hidden="true"><i style={{ width: `${(100 * done) / guide.steps.length}%` }} /></span>
			</div>
			<ol class="rg-steps">
				{guide.steps.map((s, i) => {
					const isCurrent = i === guide.current;
					return (
						<li class={`rg-step st-${s.status}${isCurrent ? ' current' : ''}`} ref={isCurrent ? currentRef : undefined}>
							<button type="button" class="rg-head" aria-current={isCurrent ? 'step' : undefined} onClick={() => go(i)}>
								<span class={`rg-num st-${s.status}`}>{STATUS_ICON[s.status] || i + 1}</span>
								<span class="rg-head-text">
									<span class="rg-step-title">{s.title}</span>
									<span class="rg-meta">
										{s.label && <span class="rg-label" title={`Label of ${guide.owner ?? guide.client ?? 'the model'}`}>{s.label}</span>}
										{s.kind && <span class={`rg-kind k-${s.kind}`}>{s.kind}</span>}
										{s.heat && (
											<span class={`rg-heat b-${s.heat.band}`} title={`${s.heat.name}\n${scoreTitle(s.heat.score, s.heat.band)}`}>
												<Flames count={s.heat.flames} />{s.heat.score}
											</span>
										)}
										<span class="rg-place">{s.fileKind === 'new' ? s.name : `${s.name}:${lineText(s)}`}</span>
										{s.fileKind === 'text' && <span class="rg-file" title="The side view shows only C and C++ files. The text editor shows this step.">text editor</span>}
										{s.fileKind === 'new' && <span class="rg-file" title="The file is not there yet. The step opens it when it is there.">new file</span>}
										{s.diff && <DiffStats diff={s.diff} />}
									</span>
								</span>
							</button>
							{isCurrent && (
								<div class="rg-body">
									<Markdown text={s.text} />
									{s.diff && <StepDiff step={s} file={file} rows={rows} settings={settings} />}
									{s.checks.length > 0 && (
										<ul class="rg-checks" aria-label="Checks">
											{s.checks.map((c) => <li>{c}</li>)}
										</ul>
									)}
									{s.note && (
										<div class="rg-note">
											<span class="mpill">model</span>
											<Markdown text={s.note} />
										</div>
									)}
									<UserNote step={s} index={i} />
									<ItemActions actions={s.actions} owner={guide.client} kind="step" step={i} line={s.first} />
									<div class="rg-actions">
										<StatusButtons step={s} index={i} />
										<span class="rg-gap" />
										{s.diff && guide.baseCommit && (
											<button type="button" class="link small" onClick={() => post({ type: 'guideDiff', index: i })}
												title="Open the diff editor of VS Code at the lines of the step">
												Diff editor
											</button>
										)}
										<button type="button" class="lens" disabled={i <= 0} onClick={() => go(i - 1)}>‹ Back</button>
										<button type="button" class="lens" disabled={i >= last} onClick={() => go(i + 1)}>Next ›</button>
									</div>
								</div>
							)}
						</li>
					);
				})}
			</ol>
			<div class="rg-footer">
				<button type="button" class="lens" onClick={() => post({ type: 'guideCopy' })} title={`Put the summary of the ${isWalk ? 'walk' : 'review'} on the clipboard, in Markdown`}>
					Copy summary
				</button>
			</div>
		</div>
	);
}

//-------------------
// The marks of a diff walk in the code view

// The removed lines of a block of the current step on a line: before the line, or after the last line of the file
export interface DiffChip {
	count: number;
	texts: string[]; // the first lines of the block
	isBelow: boolean; // the block is at the end of the file, after the line
	isReplaced: boolean; // added lines of the step start at the line: the block is the old text of the added lines
}

// The marks of a diff walk in the code of a file. The current step gets the colors of the diff. The other steps of the
// file get a mark in the line numbers
export interface WalkMarks {
	lines: Map<number, string>; // the classes of the rows
	chips: Map<number, DiffChip>;
	wraps: Map<number, Wrap[]>; // the changed characters of the lines of the current step
}

export function walkMarks(guide: SideGuide | null, file: string | undefined, lineCount: number): WalkMarks | undefined {
	if (guide?.kind !== 'diff' || !file || lineCount < 1) {
		return undefined;
	}
	const lines = new Map<number, string>();
	const chips = new Map<number, DiffChip>();
	const wraps = new Map<number, Wrap[]>();
	const addClass = (line: number, cls: string) => lines.set(line, lines.has(line) ? `${lines.get(line)} ${cls}` : cls);
	guide.steps.forEach((s, i) => {
		if (!s.diff || !sameFileName(s.file, file)) {
			return;
		}
		const isCurrent = i === guide.current;
		for (const [a, b] of s.diff.added) {
			for (let line = Math.max(1, a); line <= Math.min(b, lineCount); line++) {
				addClass(line, isCurrent ? 'df-add' : 'df-add-x');
			}
		}
		for (const r of s.diff.removed) {
			const isBelow = r.at > lineCount;
			const line = Math.max(1, Math.min(r.at, lineCount));
			addClass(line, !isCurrent ? 'df-del-x' : isBelow ? 'df-del-end' : 'df-del');
			if (isCurrent) {
				const isReplaced = s.diff.added.some(([a, b]) => a <= r.at && r.at <= b);
				chips.set(line, { count: r.count, texts: r.texts, isBelow, isReplaced });
			}
		}
		if (isCurrent) {
			for (const c of s.diff.changed) {
				wraps.set(c.line, [...(wraps.get(c.line) ?? []), { start: c.start, end: c.end, cls: 'df-chg' }]);
			}
		}
	});
	return lines.size > 0 ? { lines, chips, wraps } : undefined;
}

// The text of the chip of a removed block: the removed line, or the number of lines
export function chipText(chip: DiffChip): string {
	if (chip.count === 1 && chip.texts.length === 1) {
		const text = chip.texts[0].trim();
		return `−1  ${text.length > 48 ? `${text.slice(0, 47)}…` : text}`;
	}
	return `−${chip.count} lines`;
}

// The title of the card of a removed block
export function chipTitle(chip: DiffChip): string {
	const lines = plural(chip.count, 'line', 'lines');
	return chip.isReplaced ? `Before the change: ${lines}` : chip.isBelow ? `Removed at the end of the file: ${lines}` : `Removed here: ${lines}`;
}
