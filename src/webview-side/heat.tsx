import type { SideHeat, SideHeatFunction } from '../side/protocol';
import { vscode } from './vscode';

// The lens Heat: the flames of each function in the code, and the tab Heat with the reasons of the score of the
// function at the cursor and the functions of the file, the hottest first

const GROUP_NAMES = { reach: 'Reach', risk: 'Risk', history: 'History' } as const;
const GROUP_MAX = { reach: 60, risk: 25, history: 15 } as const;
const BAND_NAMES = { cool: 'cool', warm: 'warm', hot: 'hot', veryHot: 'very hot' } as const;

// The score of a function as text, for example "Heat 52 of 100: hot"
export function heatTitle(fn: SideHeatFunction): string {
	return `Heat ${fn.score} of 100: ${BAND_NAMES[fn.band]}`;
}

function FlameIcon() {
	return (
		<svg class="flame" viewBox="0 0 10 13" aria-hidden="true">
			<path d="M5 .5C5.4 2.7 8.5 4.6 8.5 8.3 8.5 10.6 6.9 12.5 5 12.5S1.5 10.6 1.5 8.3C1.5 6.6 2.4 5.3 3.4 4.5 3.4 5.9 4 6.9 4.8 7.2 4.2 5 4.4 2.6 5 .5Z" />
		</svg>
	);
}

// 1 to 5 flames. The color comes from the band of the parent
export function Flames({ count }: { count: number }) {
	return <span class="flames">{Array.from({ length: count }, () => <FlameIcon />)}</span>;
}

// The score of one function: each group with its points, and each reason
function HeatFunctionView({ fn }: { fn: SideHeatFunction }) {
	return (
		<section class={`heat-current b-${fn.band}`}>
			<div class="flow-title"><strong class="mono">{fn.qualifiedName || fn.name}</strong></div>
			<div class="heat-score-line"><Flames count={fn.flames} /><span>{heatTitle(fn)}</span></div>
			{(['reach', 'risk', 'history'] as const).map((group) => {
				const reasons = fn.reasons.filter((r) => r.group === group);
				return (
					<div class="heat-group">
						<div class="heat-group-title">{GROUP_NAMES[group]} <span class="sub">{fn[group]} of {GROUP_MAX[group]}</span></div>
						{reasons.length === 0 ? <div class="sub">No points.</div> : (
							<ul class="heat-reasons">
								{reasons.map((r) => <li><span class="heat-points">+{r.points}</span>{' '}{r.text}</li>)}
							</ul>
						)}
					</div>
				);
			})}
		</section>
	);
}

export function HeatDetails({ heat, cursor }: { heat: SideHeat | null; cursor?: number }) {
	if (!heat) {
		return (
			<div class="details-body">
				<p class="sub">Put the cursor in a C++ file. Heat shows how much a change of each function can break.</p>
			</div>
		);
	}
	const current = cursor !== undefined ? heat.functions.find((f) => f.first <= cursor && cursor <= f.last) : undefined;
	const sorted = [...heat.functions].sort((a, b) => b.score - a.score || a.first - b.first);
	return (
		<div class="details-body heat-details">
			{heat.isLoading && (
				<div class="heat-busy" role="status"><span class="spinner" aria-hidden="true" />The heat of the functions is not ready yet.</div>
			)}
			{heat.error && <p class="problem">{heat.error}</p>}
			{current && <HeatFunctionView fn={current} />}
			{sorted.length > 0 && (
				<>
					<div class="flow-title heat-list-title"><strong>Functions of the file</strong><span class="sub">the hottest first</span></div>
					<ul class="heat-list">
						{sorted.map((f) => (
							<li>
								<button type="button" class={`heat-item b-${f.band}${f === current ? ' current' : ''}`} title={`${f.qualifiedName || f.name}\n${heatTitle(f)}`}
									data-line={f.nameLine} onClick={() => vscode.postMessage({ type: 'revealLine', line: f.nameLine })}>
									<Flames count={f.flames} /><span class="heat-score">{f.score}</span><span class="mono">{f.name}</span>
								</button>
							</li>
						))}
					</ul>
				</>
			)}
			{!heat.isLoading && !heat.error && sorted.length === 0 && <p class="sub">The file has no function definitions.</p>}
			{heat.notices.map((n) => <p class="sub">{n}</p>)}
		</div>
	);
}
