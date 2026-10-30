import { COST_CATEGORIES } from '../lenses/cost';
import type { CostLayerState } from '../state/store';
import type { SideCost } from './protocol';

// The data of Hidden C++ for the side view. This module does not use the VS Code API, so the unit tests can call it.
// The marks show the items of the file. The categories have the counts of the file, and the switches of the settings.
// The items are the items of the function at the cursor, for the details column.
export function buildSideCost(layer: CostLayerState): SideCost {
	const enabled = new Set(layer.enabled);
	return {
		file: layer.file,
		marks: layer.marks,
		categories: COST_CATEGORIES.map((c) => ({
			id: c.id, label: c.label, count: layer.counts[c.id], enabled: enabled.has(c.id), heuristic: !!c.isHeuristic,
		})),
		fn: layer.fn,
		items: layer.items,
		hidden: layer.hidden,
	};
}
