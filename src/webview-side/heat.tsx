import type { SideCallGraph, SideHeat, SideHeatFunction } from '../side/protocol';
import { vscode } from './vscode';

// The lens Heat: the flames of each function in the code, and the tab Heat with the reasons of the score of the
// function at the cursor, the functions of the file, the hottest first, and the scan of the call graph

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
			{fn.isSiloed && <p class="sub heat-siloed">The reach is less than 10, thus the risk and the history count half.</p>}
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

// The scan of the call graph: the progress with the button Stop, or a stopped or failed scan with a button that starts
// it again
function CallGraphScan({ graph }: { graph: SideCallGraph }) {
	if (graph.state === 'scanning') {
		const percent = graph.total > 0 ? Math.round((100 * graph.done) / graph.total) : 0;
		return (
			<div class="heat-scan" role="status">
				<div class="heat-scan-line">
					<span class="spinner" aria-hidden="true" />
					<span class="heat-scan-text">{graph.total > 0 ? `Scan of the call graph: ${graph.done} of ${graph.total} source files` : 'The scan of the call graph starts.'}</span>
					<button type="button" class="link" onClick={() => vscode.postMessage({ type: 'heatStop' })}>Stop</button>
				</div>
				<span class="heat-track" aria-hidden="true"><i style={{ width: `${percent}%` }} /></span>
			</div>
		);
	}
	if (graph.state === 'stopped' || graph.state === 'failed') {
		return (
			<div class="heat-scan">
				<div class="heat-scan-line">
					<span class="heat-scan-text">{graph.state === 'failed'
						? `The scan of the call graph failed: ${graph.error ?? 'no reason'}`
						: graph.total > 0 ? `The scan of the call graph stopped at ${graph.done} of ${graph.total} source files.` : 'The scan of the call graph stopped.'}</span>
					<button type="button" class="link" onClick={() => vscode.postMessage({ type: 'heatScan' })}>{graph.state === 'stopped' ? 'Continue' : 'Scan again'}</button>
				</div>
			</div>
		);
	}
	return null;
}

// The data of the last complete scan: the size of the call graph and the frame functions with their reasons
function CallGraphFrames({ graph }: { graph: SideCallGraph }) {
	if (graph.units === undefined) {
		return null;
	}
	return (
		<details class="heat-graph">
			<summary>Call graph: {graph.functions} functions in {graph.units} source files</summary>
			{(graph.failed ?? 0) > 0 && <p class="sub">The scan could not parse {graph.failed} source files. The output channel DataFlow shows them.</p>}
			<div class="heat-group-title">Frame functions</div>
			{graph.frames.length === 0 ? <p class="sub">The call graph has no frame functions. The setting dataflow.heat.frameFunctions can add them.</p> : (
				<ul class="heat-frames">
					{graph.frames.map((f) => (
						<li>
							<button type="button" class="link mono" title={`${f.file}:${f.line}`} onClick={() => vscode.postMessage({ type: 'openPlace', file: f.file, line: f.line })}>{f.name}</button>
							<span class="sub">{f.reason}</span>
						</li>
					))}
				</ul>
			)}
		</details>
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
			{heat.graph && <CallGraphScan graph={heat.graph} />}
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
			{heat.graph && <CallGraphFrames graph={heat.graph} />}
		</div>
	);
}
