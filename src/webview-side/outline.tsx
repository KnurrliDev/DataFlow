import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { outlineGroups, paddingAfter } from '../side/outline';
import type { FromSide, SideOutline, SideOutlineMember, SideOutlinePlace, SideSettings } from '../side/protocol';
import { vscode } from './vscode';

// The panel of "Outline": the head of the type with its bases and its layout, a filter, and the members in groups. A
// click on a member moves the side view to it, as Ctrl+click does. Ctrl+click on a function goes to its definition. The
// panel stays, so the user can go from member to member. Escape, the close button and a click outside close it

const post = (message: FromSide) => vscode.postMessage(message);
const basename = (file: string) => file.split(/[\\/]/).pop() ?? file;
const ACCESS: Record<string, string> = { public: '+', protected: '#', private: '-' };
const FUNCTION_KINDS = new Set<SideOutlineMember['kind']>(['constructor', 'destructor', 'method', 'operator', 'conversion']);

// The text of a member on its row, as the source writes it
function memberLabel(m: SideOutlineMember): string {
	switch (m.kind) {
		case 'field': {
			// the type, then the name, then the initializer or the bit width
			const cut = m.text.search(/ [=:] /);
			return cut < 0 ? `${m.text} ${m.name}` : `${m.text.slice(0, cut)} ${m.name}${m.text.slice(cut)}`;
		}
		case 'type':
			return m.text.startsWith('= ') ? `using ${m.name} ${m.text}` : `${m.text} ${m.name}`;
		case 'enumerator':
			return `${m.name} = ${m.text}`;
		default:
			return m.text || m.name;
	}
}

export function OutlinePanel({ outline, point, gotoKey, onClose }: {
	outline: SideOutline;
	point?: { x: number; y: number }; // the place of the click of the menu in the window
	gotoKey: SideSettings['gotoKey'];
	onClose: () => void;
}) {
	const [filter, setFilter] = useState('');
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const [pos, setPos] = useState<{ left: number; top: number } | undefined>(undefined);
	const box = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const { groups, hidden } = useMemo(() => outlineGroups(outline), [outline]);
	useEffect(() => {
		setFilter('');
		setOpen({});
	}, [outline.seq]);

	// below the place of the click, or above it if the panel does not fit below. With no click, at the right edge below
	// the toolbar. The panel stays in the window
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) {
			return;
		}
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		if (!point) {
			setPos({ left: Math.max(8, window.innerWidth - width - 12), top: 40 });
			return;
		}
		const left = Math.max(8, Math.min(point.x - 16, window.innerWidth - width - 8));
		const below = point.y + 14;
		setPos({ left, top: below + height <= window.innerHeight - 8 ? below : Math.max(8, point.y - height - 6) });
	}, [outline.seq]);

	// the filter gets the focus, so the user can type at once
	useEffect(() => {
		box.current?.querySelector<HTMLInputElement>('.ol-filter')?.focus({ preventScroll: true });
	}, [outline.seq]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				close.current();
			}
		};
		const onDown = (e: MouseEvent) => {
			if (box.current && !box.current.contains(e.target as Node)) {
				close.current();
			}
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('mousedown', onDown, true);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('mousedown', onDown, true);
		};
	}, []);

	// the arrow keys go from row to row, also from the filter
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
			return;
		}
		const items = [...(box.current?.querySelectorAll<HTMLElement>('.ol-filter, .ol-group-head, .ol-item') ?? [])];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
		next?.focus();
		e.preventDefault();
	};

	const isGotoKey = (e: MouseEvent) => (gotoKey === 'alt' ? e.altKey : gotoKey === 'meta' ? e.metaKey : e.ctrlKey);
	const go = (place: SideOutlinePlace, toDefinition = false) =>
		post({ type: 'outlineGo', file: place.file, line: place.line, col: place.col, ...(toDefinition ? { toDefinition } : {}) });
	// a click goes to the declaration. Ctrl+click on a function goes to its definition
	const onMember = (m: SideOutlineMember, e: MouseEvent) => {
		if (isGotoKey(e) && FUNCTION_KINDS.has(m.kind)) {
			if (m.definition) {
				go(m.definition);
			} else {
				go(m, true);
			}
			return;
		}
		go(m);
	};

	const text = filter.trim().toLowerCase();
	const isMatch = (m: SideOutlineMember) => !text || m.name.toLowerCase().includes(text) || m.text.toLowerCase().includes(text);
	const layout = outline.layout;
	const title = `${outline.kind} ${outline.name}`;
	return (
		<div class="outline-panel" ref={box} role="dialog" aria-label={`Outline of ${outline.name}`} onKeyDown={onKeyDown}
			style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: 'hidden' }}>
			<div class="ol-head">
				<div class="ol-title-row">
					<span class="ol-title" title={outline.qualifiedName}>
						{outline.template && <span class="ol-template mono">{outline.template} </span>}
						<span class="mono">{title}</span>
						{outline.underlying && <span class="mono"> : {outline.underlying}</span>}
						{outline.bases.length > 0 && <span class="mono"> : </span>}
						{outline.bases.map((b, i) => (
							<span class="mono">
								{i > 0 && ', '}
								{b.access}{b.isVirtual ? ' virtual' : ''}{' '}
								{b.place ? <button type="button" class="link mono" title={`Show ${b.name}`} onClick={() => go(b.place!)}>{b.name}</button> : b.name}
							</span>
						))}
					</span>
					{outline.isFinal && <span class="badge ol-mark">final</span>}
					{outline.isAbstract && <span class="badge ol-mark">abstract</span>}
					<span class="grow" />
					<button type="button" class="call-list-close" title="Close the outline (Escape)" aria-label="Close the outline" onClick={() => close.current()}>×</button>
				</div>
				{layout && (
					<div class="ol-layout sub">
						<span>{layout.size} bytes · align {layout.align}{layout.padding > 0 ? ` · ${layout.padding} bytes padding` : ''}{layout.hasVPtr ? ' · vptr' : ''}</span>
						{layout.size > 0 && (
							<div class="ol-bar" role="img" aria-label={`${layout.padding} of ${layout.size} bytes are padding`}>
								{layout.holes.map((h) => (
									<span class="ol-hole" title={`${h.size} bytes of padding at offset ${h.offset}`}
										style={{ left: `${(h.offset / layout.size) * 100}%`, width: `max(2px, ${(h.size / layout.size) * 100}%)` }} />
								))}
							</div>
						)}
					</div>
				)}
				<input class="ol-filter" type="text" placeholder="Filter the members" aria-label="Filter the members" value={filter}
					onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
			</div>
			<div class="ol-body">
				{groups.map((g) => {
					const members = g.members.filter(isMatch);
					if (text && members.length === 0) {
						return null;
					}
					const isOpen = !!text || (open[g.key] ?? g.isOpen);
					return (
						<div class="ol-group" role="group" aria-label={g.title}>
							<button type="button" class="ol-group-head" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [g.key]: !isOpen }))}>
								<span class="ol-twisty">{isOpen ? '▾' : '▸'}</span>
								<span>{g.title}</span>
								<span class="sub">{text ? `${members.length} of ${g.members.length}` : g.members.length}</span>
							</button>
							{isOpen && members.map((m) => <MemberRow outline={outline} member={m} onMember={onMember} onDefinition={go} />)}
						</div>
					);
				})}
				{groups.length === 0 && <p class="sub ol-foot">The type has no members.</p>}
			</div>
			{(hidden > 0 || outline.isTruncated) && (
				<div class="ol-foot sub">
					{hidden > 0 && <span>{hidden} internal names of the library are hidden. </span>}
					{outline.isTruncated && <span>The bases have more members than the outline shows.</span>}
				</div>
			)}
		</div>
	);
}

function MemberRow({ outline, member: m, onMember, onDefinition }: {
	outline: SideOutline;
	member: SideOutlineMember;
	onMember: (m: SideOutlineMember, e: MouseEvent) => void;
	onDefinition: (place: SideOutlinePlace) => void;
}) {
	const padding = paddingAfter(outline, m);
	const where = `${basename(m.file)}:${m.line}`;
	return (
		<button type="button" class="ol-item" title={`${memberLabel(m)}\n${where}`} onClick={(e) => onMember(m, e)}>
			<span class="ol-access mono" title={m.access}>{ACCESS[m.access] ?? ' '}</span>
			<span class="ol-label mono">{memberLabel(m)}</span>
			<span class="ol-tags">
				{m.section && <span class="badge ol-section">{m.section === 'signals' ? 'signal' : 'slot'}</span>}
				{m.marks?.filter((mark) => mark !== 'template' || m.kind !== 'type').map((mark) => <span class="badge ol-mark">{mark}</span>)}
				{m.annotation && <span class="badge ol-annotation" title={m.annotation}>{m.annotation}</span>}
				{m.offset !== undefined && <span class="ol-offset mono">@{m.offset} {m.size} B</span>}
				{padding > 0 && <span class="badge ol-padding" title={`${padding} bytes of padding after ${m.name}`}>+{padding} pad</span>}
				{m.definition && (
					<span role="link" tabIndex={-1} class="ol-def" title={`Show the definition in ${basename(m.definition.file)}, line ${m.definition.line}`}
						onClick={(e) => {
							e.stopPropagation();
							onDefinition(m.definition!);
						}}>
						{basename(m.definition.file)}:{m.definition.line}
					</span>
				)}
			</span>
		</button>
	);
}
