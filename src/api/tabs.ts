import type * as Api from '../../api/dataflow-api';
import { resolveActions } from '../lenses/blocks';
import type { SideExtensionTab, SideTabRow } from '../side/protocol';

// The tab of an extension in the details column: the checks of its id, its title and its content. This module does not
// use the VS Code API, so the unit tests can call it directly.

// The rows of a tab, and the lengths of its texts
export const MAX_TAB_ROWS = 200;
const MAX_TAB_TITLE = 30;
const MAX_SECTION_TITLE = 80;
const MAX_ROW_TEXT = 200;
const MAX_ROW_DETAIL = 2000;
const MAX_ROW_BADGE = 20;
const MAX_ROW_ID = 64;
const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// The id and the title of a new tab. A problem throws an error
export function resolveTabOptions(options: unknown): { id: string; title: string } {
	const o = options as Partial<Api.ExtensionTabOptions> | null | undefined;
	if (!o || typeof o !== 'object') {
		throw new Error('Give the options of the tab: { id, title }.');
	}
	if (typeof o.id !== 'string' || !TAB_ID.test(o.id)) {
		throw new Error('"id" of the tab must have 1 to 64 letters, digits, - or _.');
	}
	if (typeof o.title !== 'string' || !o.title.trim()) {
		throw new Error('Give the "title" of the tab.');
	}
	return { id: o.id, title: clip(o.title.trim(), MAX_TAB_TITLE) };
}

// The sections of the content of a tab. resolveFile gives the absolute path of the file of a place. All problems go into
// one error, and the tab keeps its content
export function resolveTabContent(content: unknown, resolveFile: (file: string) => string): SideExtensionTab['sections'] {
	const c = content as Partial<Api.TabContent> | null | undefined;
	if (!c || typeof c !== 'object' || !Array.isArray(c.sections)) {
		throw new Error('The content of a tab must be an object with "sections": a list of sections with "title" and "rows".');
	}
	const count = c.sections.reduce((n, s) => n + (s && typeof s === 'object' && Array.isArray(s.rows) ? s.rows.length : 0), 0);
	if (count > MAX_TAB_ROWS) {
		throw new Error(`A tab has a maximum of ${MAX_TAB_ROWS} rows. The content has ${count} rows.`);
	}
	const problems: string[] = [];
	const ids = new Set<string>();
	const sections = c.sections.map((s, i) => {
		const name = `Section ${i + 1}`;
		if (!s || typeof s !== 'object' || typeof s.title !== 'string' || !Array.isArray(s.rows)) {
			problems.push(`${name}: a section must have "title" and "rows".`);
			return { title: '', rows: [] };
		}
		const rows: SideTabRow[] = [];
		s.rows.forEach((r, j) => {
			const row = resolveRow(r, `${name}, row ${j + 1}`, ids, problems, resolveFile);
			if (row) {
				rows.push(row);
			}
		});
		return { title: clip(s.title.trim(), MAX_SECTION_TITLE), rows };
	});
	if (problems.length > 0) {
		throw new Error(problems.slice(0, 10).join(' '));
	}
	return sections;
}

// A row with its text, and with its id, its detail, its badge, its place and its buttons if it has them. The ids of the
// rows of a tab are different. A row with buttons needs an id, so a click tells the row
function resolveRow(input: unknown, name: string, ids: Set<string>, problems: string[], resolveFile: (file: string) => string): SideTabRow | undefined {
	const r = input as Partial<Api.TabRow> | null | undefined;
	if (!r || typeof r !== 'object' || typeof r.text !== 'string' || !r.text.trim()) {
		problems.push(`${name}: a row must have "text".`);
		return undefined;
	}
	const out: SideTabRow = { text: clip(r.text.trim(), MAX_ROW_TEXT) };
	if (r.id !== undefined) {
		if (typeof r.id !== 'string' || !r.id.trim() || r.id.length > MAX_ROW_ID) {
			problems.push(`${name}: "id" must be a text of 1 to ${MAX_ROW_ID} characters.`);
		} else if (ids.has(r.id)) {
			problems.push(`${name}: the id ${r.id} is on a different row of the tab.`);
		} else {
			ids.add(r.id);
			out.id = r.id;
		}
	}
	for (const [key, max] of [['detail', MAX_ROW_DETAIL], ['badge', MAX_ROW_BADGE]] as const) {
		const value = r[key];
		if (value === undefined) {
			continue;
		}
		if (typeof value !== 'string') {
			problems.push(`${name}: "${key}" must be a text.`);
		} else if (value.trim()) {
			out[key] = clip(key === 'badge' ? value.trim() : value, max);
		}
	}
	if (r.place !== undefined) {
		const p = r.place as Partial<Api.TabRow['place'] & object> | null;
		if (!p || typeof p !== 'object' || typeof p.file !== 'string' || !p.file.trim() || !Number.isInteger(p.line) || p.line! < 1) {
			problems.push(`${name}: "place" must have "file" and "line", a line from 1.`);
		} else {
			out.place = { file: resolveFile(p.file.trim()), line: p.line! };
		}
	}
	const actions = resolveActions(r.actions, name, problems);
	if (actions) {
		if (!out.id) {
			problems.push(`${name}: a row with "actions" needs an "id".`);
		}
		out.actions = actions;
	}
	return out;
}
