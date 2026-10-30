import type { LogicMark } from '../lenses/logic';
import type { LogicPathState } from '../state/store';
import { functionTitle } from './names';
import type { SideLogic, SideLogicMark } from './protocol';

// The data of Logic Map for the side view. This module does not use the VS Code API, so the unit tests can call it.
// The view of the path state has lines from 0, as VS Code. The side view, the steps and the warnings have lines from 1.
export function buildSideLogic(path: LogicPathState): SideLogic {
	const view = path.view;
	const mark = (m: LogicMark): SideLogicMark => ({ line: m.line + 1, start: m.start, end: m.end });
	const chosen = new Set(path.chosen);
	return {
		file: path.file,
		fn: functionTitle(path.fn, true),
		first: path.fn.range.begin.line,
		last: path.fn.range.end.line,
		steps: path.steps.map((s) => ({
			kind: s.kind, line: s.line, text: s.text, key: s.key, value: s.value, options: s.options, problem: s.problem, changes: s.changes,
			isSet: s.key === undefined ? undefined : chosen.has(s.key),
		})),
		dead: view.dead.map((line) => line + 1),
		events: view.events.map((e) => ({ ...mark(e), label: e.label })),
		problems: view.problems.map(mark),
		hints: view.hints.map((h) => ({ line: h.line + 1, text: h.text })),
		warnings: path.warnings,
		why: path.why,
		hasChoices: chosen.size > 0,
		hasCfg: path.hasCfg,
	};
}
