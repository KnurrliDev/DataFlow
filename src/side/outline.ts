import type { SideOutlineData, SideOutlineMember } from './protocol';

// The panel of "Outline": the groups of the members, the padding after a data member, and the search for the header of
// a type. This module does not use the VS Code API, so the unit tests and the webview can use it.

export interface OutlineGroup {
	key: string; // the key of the state of the group: open or closed
	title: string; // for example "Data members"
	members: SideOutlineMember[];
	isOpen: boolean; // the group is open at the start
}

// The groups of the members of each kind, in this sequence. The members keep the sequence of the source in a group
const KIND_GROUPS: { title: string; kinds: SideOutlineMember['kind'][] }[] = [
	{ title: 'Data members', kinds: ['field'] },
	{ title: 'Functions', kinds: ['constructor', 'destructor', 'method', 'operator', 'conversion'] },
	{ title: 'Types', kinds: ['type'] },
	{ title: 'Enumerators', kinds: ['enumerator'] },
	{ title: 'Properties', kinds: ['property'] },
	{ title: 'Friends', kinds: ['friend'] },
	{ title: 'Using declarations', kinds: ['using'] },
];

// A name of a library type that starts with "_" is a name of the implementation of the library, for example of the
// standard library
const isInternal = (o: SideOutlineData, m: SideOutlineMember) => o.isLibrary && m.name.startsWith('_');

// The groups of the panel: the members of each kind, the members that each macro makes, and the members of each base.
// The groups of the macros and of the bases are closed at the start. hidden: the internal members of a library type
export function outlineGroups(o: SideOutlineData): { groups: OutlineGroup[]; hidden: number } {
	const groups: OutlineGroup[] = [];
	let hidden = 0;
	const own = o.members.filter((m) => {
		const isShown = !isInternal(o, m);
		hidden += isShown ? 0 : 1;
		return isShown;
	});
	for (const g of KIND_GROUPS) {
		const members = own.filter((m) => !m.macro && g.kinds.includes(m.kind));
		if (members.length > 0) {
			groups.push({ key: `kind:${g.title}`, title: g.title, members, isOpen: true });
		}
	}
	const macros = [...new Set(own.filter((m) => m.macro).map((m) => m.macro!))];
	for (const macro of macros) {
		groups.push({ key: `macro:${macro}`, title: `Made by ${macro}`, members: own.filter((m) => m.macro === macro), isOpen: false });
	}
	for (const base of o.inherited) {
		const members = base.members.filter((m) => {
			const isShown = !isInternal(o, m);
			hidden += isShown ? 0 : 1;
			return isShown;
		});
		groups.push({ key: `base:${base.base}`, title: `Inherited from ${base.base}`, members, isOpen: false });
	}
	return { groups, hidden };
}

// The bytes of padding right after a data member, or 0
export function paddingAfter(o: SideOutlineData, m: SideOutlineMember): number {
	if (m.offset === undefined || m.size === undefined || !o.layout) {
		return 0;
	}
	const end = m.offset + m.size;
	return o.layout.holes.find((h) => h.offset === end)?.size ?? 0;
}

// The line of the definition of a class, a struct, a union or an enum in a text, from 0, or -1. A qualified name gives
// its last part. A definition has a body: a forward declaration does not count. Words in capital letters between the
// keyword and the name are export macros, for example ENGINE_API
export function typeDefinitionLine(text: string, name: string): number {
	const simple = name.split('::').pop() ?? name;
	const escaped = simple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`\\b(?:class|struct|union|enum(?:\\s+(?:class|struct))?)\\s+(?:[A-Z_][A-Z0-9_]*\\s+)*(${escaped})\\b[^;{()]*\\{`, 'd');
	const at = pattern.exec(text)?.indices?.[1]?.[0];
	return at === undefined ? -1 : text.slice(0, at).split('\n').length - 1;
}
