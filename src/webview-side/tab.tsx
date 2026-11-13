import type { SideExtensionTab } from '../side/protocol';
import { ItemActions, Markdown } from './model';
import { vscode } from './vscode';

const basename = (file: string) => file.split(/[\\/]/).pop() ?? file;

// The tab of an extension: its sections with their rows. A click on the text of a row with a place shows the line of the
// file, as the lists of DataFlow do. The buttons of a row go to the extension
export function ExtensionTabDetails({ tab }: { tab: SideExtensionTab }) {
	return (
		<div class="details-body ext-tab" data-client={tab.client}>
			{tab.sections.length === 0 && <p class="sub">The extension {tab.client} has no content in this tab yet.</p>}
			{tab.sections.map((s) => (
				<section class="tab-section">
					<div class="flow-title tab-section-title"><strong>{s.title}</strong></div>
					{s.rows.length === 0 ? <p class="sub">No items.</p> : (
						<ul class="tab-rows">
							{s.rows.map((r) => (
								<li class="tab-row" data-id={r.id}>
									<div class="tab-row-head">
										{r.place ? (
											<button type="button" class="tab-text tab-place" title={`Show line ${r.place.line} of ${basename(r.place.file)}`}
												onClick={() => vscode.postMessage({ type: 'openPlace', file: r.place!.file, line: r.place!.line })}>
												{r.text}
											</button>
										) : <span class="tab-text">{r.text}</span>}
										{r.badge && <span class="badge k-muted tab-badge">{r.badge}</span>}
									</div>
									{r.detail && <div class="tab-detail"><Markdown text={r.detail} /></div>}
									<ItemActions actions={r.actions} owner={tab.client} kind="tab" item={r.id} file={r.place?.file} line={r.place?.line} />
								</li>
							))}
						</ul>
					)}
				</section>
			))}
		</div>
	);
}
