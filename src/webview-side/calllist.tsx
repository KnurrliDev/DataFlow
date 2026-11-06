import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { FromSide, SideCallList, SideCallListSite } from '../side/protocol';
import { vscode } from './vscode';

// The list of "Show Calls": the calls of a function by file, each with its line, the function that calls and the code.
// A click on a call shows it, in the side view or in the text editor. The list stays, so the user can go from call to
// call. Escape, the close button and a click outside of the list close it. The arrow keys go from call to call.

const post = (message: FromSide) => vscode.postMessage(message);
const basename = (file: string) => file.split(/[\\/]/).pop() ?? file;

export function CallListPanel({ list, point, onClose }: {
	list: SideCallList;
	point?: { x: number; y: number }; // the place of the click of the menu in the window
	onClose: () => void;
}) {
	const [current, setCurrent] = useState(-1);
	const [pos, setPos] = useState<{ left: number; top: number } | undefined>(undefined);
	const box = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => setCurrent(-1), [list.seq]);

	// below the place of the click, or above it if the list does not fit below. With no click, at the right edge below
	// the toolbar. The list stays in the window
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
	}, [list.seq, list.sites.length, list.isSearching]);

	// the first call gets the focus, so the keyboard works at once
	useEffect(() => {
		box.current?.querySelector<HTMLElement>('.call-item')?.focus({ preventScroll: true });
	}, [list.seq]);

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

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
			return;
		}
		const items = [...(box.current?.querySelectorAll<HTMLElement>('.call-item') ?? [])];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
		next?.focus();
		e.preventDefault();
	};

	// the calls by file, in the sequence of the list: the file of the side view first
	const groups: { file: string; items: { site: SideCallListSite; index: number }[] }[] = [];
	list.sites.forEach((site, index) => {
		const last = groups[groups.length - 1];
		if (last && last.file === site.file) {
			last.items.push({ site, index });
		} else {
			groups.push({ file: site.file, items: [{ site, index }] });
		}
	});
	// the list of the definitions of a name: a click moves only the side view, as Ctrl+click does
	const isDefinitions = list.kind === 'definitions';
	const noun = isDefinitions ? 'definition' : 'call';
	const count = list.sites.length === 1 ? `1 ${noun}` : `${list.sites.length} ${noun}s`;
	const title = isDefinitions ? 'Definitions of' : 'Calls of';
	return (
		<div class="call-list" ref={box} role="dialog" aria-label={`${title} ${list.fn}`} onKeyDown={onKeyDown}
			style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: 'hidden' }}>
			<div class="call-list-head">
				<span class="call-list-title">{title} <strong class="mono">{list.fn}</strong></span>
				<span class="sub">{count}</span>
				<span class="grow" />
				<button type="button" class="call-list-close" title="Close the list (Escape)" aria-label="Close the list" onClick={() => close.current()}>×</button>
			</div>
			<div class="call-list-body">
				{groups.map((g) => (
					<div class="call-list-group" role="group" aria-label={basename(g.file)}>
						<div class="call-list-file" title={g.file}>{basename(g.file)}</div>
						{g.items.map(({ site, index }) => (
							<button type="button" class={index === current ? 'call-item current' : 'call-item'} title={`Show ${basename(site.file)}, line ${site.line}`}
								onClick={() => {
									setCurrent(index);
									post(isDefinitions ? { type: 'goToPlace', file: site.file, line: site.line, col: site.col }
										: { type: 'openPlace', file: site.file, line: site.line, col: site.col });
								}}>
								<span class="call-line">{site.line}</span>
								<span class="call-caller">{site.caller}</span>
								<span class="call-text">{site.text}</span>
							</button>
						))}
					</div>
				))}
				{list.sites.length === 0 && !list.isSearching && <p class="sub call-list-empty">No {noun}s found.</p>}
			</div>
			{(list.isSearching || list.note) && <div class="call-list-foot sub">{list.isSearching ? 'Looking for calls in other files…' : list.note}</div>}
		</div>
	);
}
