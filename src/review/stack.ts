import type * as Api from '../../api/dataflow-api';
import type { SideGuide, SideGuideRef } from '../side/protocol';
import type { DataFlowState, StateStore } from '../state/store';

// The stack of the guides: the guided reviews and the diff walks of the user and of the clients. The side view shows the
// top guide. A new guide goes on the top, and when the top guide closes, the guide under it shows again. Each guide has
// an id and an owner: the user for a command of DataFlow, else the client that made the guide.

// The guides in the stack, with the top guide
export const MAX_GUIDES = 5;

// The owner of a guide. A guide of an older version has no owner: a diff walk with no client is a walk of the command
export function guideOwner(guide: SideGuide): string {
	return guide.owner ?? guide.client ?? (guide.kind === 'diff' ? 'user' : 'model');
}

export const guideKindName = (guide: { kind?: 'review' | 'diff' }): 'review' | 'diff walk' => (guide.kind === 'diff' ? 'diff walk' : 'review');

export interface GuideStack {
	guide?: SideGuide; // the top guide
	guidesBelow: readonly SideGuide[]; // from the bottom of the stack to the guide under the top guide
}

export const stackOf = (state: Pick<DataFlowState, 'guide' | 'guidesBelow'>): GuideStack => ({ guide: state.guide, guidesBelow: state.guidesBelow });

// All guides of the stack, the top guide first
export function stackGuides(stack: GuideStack): SideGuide[] {
	return [...(stack.guide ? [stack.guide] : []), ...[...stack.guidesBelow].reverse()];
}

export function findGuide(stack: GuideStack, id: string): SideGuide | undefined {
	return stackGuides(stack).find((g) => g.id === id);
}

export function guideRef(guide: SideGuide): Api.GuideRef {
	return { id: guide.id, owner: guideOwner(guide), title: guide.title, kind: guideKindName(guide) };
}

export function sideGuideRef(guide: SideGuide): SideGuideRef {
	return { id: guide.id, title: guide.title, owner: guideOwner(guide), ...(guide.kind ? { kind: guide.kind } : {}) };
}

// The guides of the stack for a text, for example: g3 "Review of the limit" (claude-code, review)
export function guidesText(stack: GuideStack): string {
	return stackGuides(stack).map((g) => `${g.id} "${g.title}" (${guideOwner(g)}, ${guideKindName(g)})`).join(', ');
}

// A new guide on the top. The caller checks MAX_GUIDES
export function pushGuide(stack: GuideStack, guide: SideGuide): GuideStack {
	return { guide, guidesBelow: stack.guide ? [...stack.guidesBelow, stack.guide] : [...stack.guidesBelow] };
}

// The guide in the place of the guide with its id
export function putGuide(stack: GuideStack, guide: SideGuide): GuideStack {
	if (stack.guide?.id === guide.id) {
		return { guide, guidesBelow: stack.guidesBelow };
	}
	return { guide: stack.guide, guidesBelow: stack.guidesBelow.map((g) => (g.id === guide.id ? guide : g)) };
}

// The stack with no guide with the id. If it is the top guide, the guide under it comes to the top
export function dropGuide(stack: GuideStack, id: string): GuideStack {
	if (stack.guide?.id === id) {
		const below = [...stack.guidesBelow];
		const next = below.pop();
		return { guide: next, guidesBelow: below };
	}
	return { guide: stack.guide, guidesBelow: stack.guidesBelow.filter((g) => g.id !== id) };
}

// Brings the guide with the id to the top. The old top guide goes under it
export function raiseGuide(stack: GuideStack, id: string): GuideStack {
	const guide = stack.guidesBelow.find((g) => g.id === id);
	if (!guide || !stack.guide) {
		return stack;
	}
	return { guide, guidesBelow: [...stack.guidesBelow.filter((g) => g.id !== id), stack.guide] };
}

// The number and the id of a new guide. A plan that replaces a guide gets a new number, and it keeps the id of that guide
export function nextGuideSeq(state: Pick<DataFlowState, 'guideSeq'>): number {
	return state.guideSeq + 1;
}

// Writes the stack to the store with the cause of the change. The number of the last guide follows the stack
export function setStack(store: StateStore, stack: GuideStack, change: Api.GuideChange, by: string): void {
	const guideSeq = Math.max(store.state.guideSeq, ...stackGuides(stack).map((g) => g.seq));
	store.update({ guide: stack.guide, guidesBelow: [...stack.guidesBelow], guideSeq, guideCause: { change, by, guide: stack.guide } });
}

// Writes a changed guide of the stack to the store: the top guide or a guide under it
export function setGuide(store: StateStore, guide: SideGuide, change: Api.GuideChange, by: string): void {
	setStack(store, putGuide(stackOf(store.state), guide), change, by);
}

// The change between two top guides, for a change with no cause in the store
export function guideChangeOf(before: SideGuide | undefined, after: SideGuide): Api.GuideChange {
	if (!before) {
		return 'start';
	}
	if (before.id !== after.id) {
		return 'show';
	}
	if (before.seq !== after.seq) {
		return 'replace';
	}
	const isChanged = (key: 'status' | 'note' | 'userNote' | 'label' | 'data') =>
		before.steps.some((s, i) => JSON.stringify(s[key]) !== JSON.stringify(after.steps[i]?.[key]));
	if (isChanged('status')) {
		return 'mark';
	}
	if (isChanged('userNote')) {
		return 'userNote';
	}
	if (isChanged('note')) {
		return 'note';
	}
	if (isChanged('label') || isChanged('data')) {
		return 'label';
	}
	return before.current !== after.current ? 'step' : 'move';
}
