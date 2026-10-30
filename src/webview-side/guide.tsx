import { useEffect, useRef } from 'preact/hooks';
import type { FromSide, SideGuide, SideGuideStatus, SideGuideStep } from '../side/protocol';
import { Markdown } from './model';
import { vscode } from './vscode';

// The guided review in the side view: a bar under the toolbar with the current step and the buttons Back and Next, the
// tab Guide of the details column with the plan of the model, and the mark of the lines of the current step in the code.
// The model sends the plan through the MCP server of DataFlow. The user marks each step: OK, issue or question.

const post = (message: FromSide) => vscode.postMessage(message);

const STATUS_ICON: Record<SideGuideStatus, string> = { todo: '', ok: '✓', issue: '!', question: '?' };
const STATUS_NAME: Record<Exclude<SideGuideStatus, 'todo'>, string> = { ok: 'OK', issue: 'Issue', question: 'Question' };

const lineText = (s: SideGuideStep) => (s.first === s.last ? `${s.first}` : `${s.first}-${s.last}`);

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

// The bar under the toolbar: the step that the side view shows, and the buttons to go to the step before or after it
export function GuideBar({ guide, onOpen }: { guide: SideGuide; onOpen: () => void }) {
	const step = guide.steps[guide.current];
	const last = guide.steps.length - 1;
	return (
		<div class="lensbar rg-bar" role="group" aria-label="Guided review">
			<span class="rg-pill">review</span>
			<button type="button" class="lens rg-nav" disabled={guide.current <= 0} onClick={() => go(guide.current - 1)} title="The step before">‹ Back</button>
			<span class="rg-pos">{guide.current + 1} / {guide.steps.length}</span>
			<button type="button" class="lens rg-nav" disabled={guide.current >= last} onClick={() => go(guide.current + 1)} title="The next step">Next ›</button>
			<button type="button" class="bar-text rg-title" title={`${step.title}\n\nOpen the plan in the tab Guide`} onClick={onOpen}>
				{step.title}
			</button>
			<StatusButtons step={step} index={guide.current} isCompact />
		</div>
	);
}

// The tab Guide of the details column: the plan with all steps. The current step shows its text, its checks and the
// note of the model
export function GuideDetails({ guide }: { guide: SideGuide | null }) {
	// the current step scrolls into the view of the tab, for example after Next in the bar or a step of the model
	const currentRef = useRef<HTMLLIElement>(null);
	useEffect(() => currentRef.current?.scrollIntoView({ block: 'nearest' }), [guide?.current, guide?.seq]);
	if (!guide) {
		return (
			<div class="details-body">
				<p class="sub">No guided review. Ask the model for a review of the changes, for example with the prompt review-changes of DataFlow.</p>
			</div>
		);
	}
	const last = guide.steps.length - 1;
	const done = guide.steps.filter((s) => s.status !== 'todo').length;
	return (
		<div class="details-body rg-details">
			<div class="flow-title">
				<strong>{guide.title}</strong>
				<button type="button" class="link small" onClick={() => post({ type: 'guideClose' })}>Close review</button>
			</div>
			<p class="sub">
				<span class="mpill">model</span>
				Plan of {guide.client ?? 'the model'}{guide.target ? `, against ${guide.target}` : ''}
			</p>
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
										{s.kind && <span class={`rg-kind k-${s.kind}`}>{s.kind}</span>}
										<span class="rg-place">{s.name}:{lineText(s)}</span>
									</span>
								</span>
							</button>
							{isCurrent && (
								<div class="rg-body">
									<Markdown text={s.text} />
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
									<div class="rg-actions">
										<StatusButtons step={s} index={i} />
										<span class="rg-gap" />
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
				<button type="button" class="lens" onClick={() => post({ type: 'guideCopy' })} title="Put the summary of the review on the clipboard, in Markdown">
					Copy summary
				</button>
			</div>
		</div>
	);
}
