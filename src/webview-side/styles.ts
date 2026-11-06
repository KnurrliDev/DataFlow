import type { SideBrackets, SideStyle } from '../side/protocol';

// The styles of the side view. The content security policy allows no inline styles, so the view uses constructable
// stylesheets. The theme colors of VS Code are CSS variables.

const BASE_CSS = `
html, body { height: 100%; }
body { margin: 0; padding: 0; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.app { display: flex; flex-direction: column; height: 100vh; }
/* the toolbar: the file and the function, the switch Model and the lenses. If the first row is full, for example in a
   narrow side view beside the panel of Claude Code, the buttons go to a second row, so the mouse can reach each of them */
.toolbar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-height: 26px; padding: 2px 10px; overflow: hidden;
  white-space: nowrap; border-bottom: 1px solid var(--vscode-editorGroup-border, transparent); color: var(--vscode-descriptionForeground); }
.toolbar .file { color: var(--vscode-foreground); }
.toolbar button.file { padding: 0; border: 0; background: none; cursor: pointer; font: inherit; }
.toolbar button.file:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.toolbar .sep { opacity: 0.7; }
.toolbar .fn { overflow: hidden; text-overflow: ellipsis; font-family: var(--vscode-editor-font-family); }
.grow { flex: 1; min-width: 0; }
.mono { font-family: var(--vscode-editor-font-family); }
.sub { color: var(--vscode-descriptionForeground); }
/* the lens buttons are items of the toolbar, so they share the rows with the other buttons */
.lenses { display: contents; }
.lens { display: inline-flex; align-items: center; gap: 6px; padding: 1px 9px; border-radius: 11px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--vscode-panel-border, transparent); background: transparent; color: var(--vscode-foreground); font: inherit; }
.lens[aria-pressed="true"] { background: var(--vscode-button-secondaryBackground); border-color: var(--vscode-focusBorder); }
.lens-dot, .dot-inline { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
/* the dot of Change Ripple is a ring, so it differs from the dot of Threads in the same color */
.lens-dot.ring { box-sizing: border-box; background: transparent; box-shadow: inset 0 0 0 2px var(--c); }
.lensbar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-height: 26px; padding: 2px 10px;
  border-bottom: 1px solid var(--vscode-editorGroup-border, transparent); }
.lensbar > button { white-space: nowrap; }
/* the bar of the lenses: a group of controls for each lens that is on, after the dot of the lens. Each group is one
   row. In a narrow side view, its texts end with an ellipsis, and the variables of Flow Lens and the categories of
   Hidden C++ scroll. The groups that fit share a row */
.lensbar.lens-groups { gap: 4px 18px; }
.lensgroup { flex: 0 1 auto; display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; overflow: hidden;
  white-space: nowrap; }
.lensgroup > * { flex: none; }
/* in a narrow side view, the problems and the events share the space after the other controls. The problems get three
   times the space of the events. A short text ends with an ellipsis, and a short list of events fades out. Only if the
   space is not sufficient, the variables of Flow Lens and the categories of Hidden C++ scroll */
.lensgroup > .finding, .lensgroup > .problem, .lensgroup > .notice, .lensgroup > .events-line {
  flex: 3 1 0; min-width: 2.5em; max-width: max-content; overflow: hidden; text-overflow: ellipsis; }
.lensgroup > .events-line { flex-grow: 1; display: block; padding-right: 12px;
  mask-image: linear-gradient(to right, #000 calc(100% - 12px), transparent); }
.lensgroup > .events-line > * { margin-right: 6px; }
.lensgroup > .vars, .lensgroup > .cats { flex: 0 1 auto; min-width: 60px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: thin; }
.lensgroup.cats-group { flex: 1 1 240px; }
.vars { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.var { padding: 0 7px; border-radius: 9px; border: 1px solid var(--vscode-panel-border, transparent); background: transparent;
  cursor: pointer; color: var(--vscode-foreground); font-size: 0.92em; }
.var[aria-pressed="true"] { border-color: var(--vscode-focusBorder); background: var(--vscode-button-secondaryBackground); }
.var-line { opacity: 0.65; }
.main { flex: 1; min-height: 0; display: flex; position: relative; }
.scroller { flex: 1; min-width: 0; overflow: auto; position: relative; outline: none;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); font-weight: var(--vscode-editor-font-weight); }
.measure, .row.probe { position: absolute; top: 0; left: 0; visibility: hidden; white-space: pre; pointer-events: none; }
.details { flex: none; width: 300px; overflow: auto; border-left: 1px solid var(--vscode-editorGroup-border, transparent); }
.details-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 8px 12px; }
.details-body p { margin: 0; }
.flow-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.flow-name { font-weight: 600; font-size: 1.1em; word-break: break-all; }
.flow-name.fn-name { word-break: normal; overflow-wrap: anywhere; }
button.link { padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; text-align: left; }
button.link:hover { color: var(--vscode-textLink-activeForeground); }
button.link.finding { color: var(--vscode-dataflow-problem); }
button.link.event { color: var(--vscode-dataflow-event); }
.events-line { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 12px 0; }
.tab { padding: 1px 9px; border-radius: 11px; cursor: pointer; white-space: nowrap; border: 1px solid var(--vscode-panel-border, transparent); background: transparent;
  color: var(--vscode-foreground); font: inherit; }
.tab[aria-selected="true"] { background: var(--vscode-button-secondaryBackground); border-color: var(--vscode-focusBorder); }
/* the option of a decision: buttons, or a list for a switch and an else-if chain. The default option has an outline in
   the color of the path, and a choice of the user is full */
.seg { flex: none; display: inline-flex; overflow: hidden; border-radius: 4px; border: 1px solid var(--vscode-panel-border, var(--vscode-descriptionForeground)); }
.seg button { padding: 0 6px; border: 0; background: transparent; cursor: pointer; color: var(--vscode-foreground); font: inherit; font-size: 0.95em; }
.seg button + button { border-left: 1px solid var(--vscode-panel-border, transparent); }
.seg button[aria-pressed="true"] { color: var(--vscode-dataflow-pathLine); box-shadow: inset 0 0 0 1px var(--vscode-dataflow-pathLine); }
.seg.set button[aria-pressed="true"] { color: var(--vscode-editor-background); background: var(--vscode-dataflow-pathLine); box-shadow: none; }
select.choice { flex: none; max-width: 100%; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border, transparent); font: inherit; font-size: 0.95em; }
select.choice.set { border-color: var(--vscode-dataflow-pathLine); }
select.choice option { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }

/* the path panel of Logic Map: the summary, the warnings, and the trail of the steps on a vertical line. A diamond is a
   decision, which is full for a choice of the user. A dot is an event, a warning, a return or the end of the function */
.path-actions { display: flex; align-items: center; gap: 8px; }
.summary { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; align-items: baseline; }
.callout { display: block; width: 100%; padding: 6px 10px; border: 0; border-left: 3px solid var(--vscode-dataflow-problem); border-radius: 0 6px 6px 0;
  cursor: pointer; text-align: left; font: inherit; color: var(--vscode-foreground); background: var(--vscode-dataflow-problemBackground); }
.trail { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); margin: 4px 0 0; padding: 0; list-style: none; }
.trail::before { content: ''; position: absolute; left: 7px; top: 12px; bottom: 12px; width: 2px; opacity: 0.45;
  background: var(--vscode-dataflow-pathLine); }
.step { position: relative; display: grid; grid-template-columns: 16px minmax(0, 1fr); column-gap: 8px; padding: 3px 6px 3px 0; border-radius: 4px; }
.step:hover { background: var(--vscode-list-hoverBackground); }
.step.current { background: var(--vscode-dataflow-path); }
.step .node { grid-column: 1; grid-row: 1 / span 2; justify-self: center; z-index: 1; box-sizing: border-box; width: 11px; height: 11px; margin-top: 4px;
  border-radius: 50%; border: 2px solid var(--c); background: var(--vscode-editor-background); }
.step.k-decision .node { --c: var(--vscode-dataflow-pathLine); width: 10px; height: 10px; margin-top: 5px; border-radius: 2px; transform: rotate(45deg); }
.step.k-decision .node.set { background: var(--vscode-dataflow-pathLine); }
.step.k-event .node { --c: var(--vscode-dataflow-event); }
.step.k-event.has-problem .node, .step.k-warning .node { --c: var(--vscode-dataflow-problem); }
.step.k-return .node, .step.k-end .node { --c: var(--vscode-dataflow-check); border-radius: 2px; }
.step.k-effect .node { --c: var(--vscode-dataflow-write); width: 9px; height: 9px; margin-top: 5px; }
.step-text { grid-column: 2; min-width: 0; padding: 0; border: 0; background: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: left; cursor: pointer; color: var(--vscode-foreground); font-size: 0.95em; }
.step-text:hover { color: var(--vscode-textLink-activeForeground); }
.step-sub { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.trail-cursor { position: absolute; left: 3px; z-index: 2; width: 10px; height: 10px; border-radius: 50%; pointer-events: none;
  background: var(--vscode-dataflow-pathLine); box-shadow: 0 0 0 3px var(--vscode-dataflow-path); transition: top 250ms ease-out; }
.why-box { margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border, transparent); }
.refs { display: grid; gap: 1px; }
.ref { display: flex; align-items: center; gap: 8px; padding: 1px 0; border: 0; background: none; cursor: pointer; text-align: left;
  color: var(--vscode-foreground); font: inherit; }
.ref:hover { color: var(--vscode-textLink-activeForeground); }
.ref .line { min-width: 3.5em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
.problem { color: var(--vscode-dataflow-problem); }
.spacer { position: relative; min-width: 100%; }
.rows { position: absolute; left: 0; top: 0; min-width: 100%; will-change: transform; }
.row { display: flex; height: var(--row-height); line-height: var(--row-height); white-space: pre; cursor: text; }
.row.cursor { background: var(--vscode-editor-lineHighlightBackground, transparent);
  box-shadow: inset 0 1px 0 var(--vscode-editor-lineHighlightBorder, transparent), inset 0 -1px 0 var(--vscode-editor-lineHighlightBorder, transparent); }
.ln { position: sticky; left: 0; z-index: 1; flex: none; box-sizing: border-box; width: calc(var(--gutter) + 26px + var(--bars-extra, 0px));
  padding: 0 16px 0 10px;
  text-align: right; user-select: none; color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editor-background); }
.row.cursor .ln { color: var(--vscode-editorLineNumber-activeForeground); }
.code { position: relative; flex: none; padding-right: 24px; }
.code::selection, .code *::selection { background: var(--vscode-editor-selectionBackground); }
/* the name under the mouse while the key of "go to definition" is down, as a link in the text editor */
.code .goto-link { text-decoration: underline; cursor: pointer; }
.guide { position: absolute; top: 0; bottom: 0; width: 1px; pointer-events: none; }

/* the colors of Flow Lens. The extension contributes them as theme colors */
.c-definition { --c: var(--vscode-dataflow-definition); }
.c-model { --c: var(--vscode-dataflow-model); }
.c-read { --c: var(--vscode-dataflow-read); }
.c-write { --c: var(--vscode-dataflow-write); }
.c-check { --c: var(--vscode-dataflow-check); }
.c-problem { --c: var(--vscode-dataflow-problem); }
.c-path { --c: var(--vscode-dataflow-pathLine); }
.c-ripple { --c: var(--vscode-dataflow-event); }
.c-muted { --c: var(--vscode-descriptionForeground); }

/* the rails at the left of the code. They stay next to the line numbers in a horizontal scroll */
.lane { position: sticky; left: calc(var(--gutter) + 26px + var(--bars-extra, 0px)); z-index: 1; flex: none; height: var(--row-height);
  background: var(--vscode-editor-background); }
.lane svg { display: block; overflow: visible; }
.rail { fill: none; stroke: var(--c); stroke-width: 1.6; stroke-linecap: round; }
.rail.dashed { stroke-dasharray: 3 3; }
.dot { fill: var(--c); }
.dot.hollow { fill: var(--vscode-editor-background); stroke: var(--c); stroke-width: 1.4; }
.pulse { fill: var(--c); opacity: 0; animation: df-pulse var(--dur) linear var(--delay) 1; }
@keyframes df-pulse { from { opacity: 1; transform: translateY(var(--y0)); } to { opacity: 1; transform: translateY(var(--y1)); } }

/* the marks of the references: a box in the color of the role. A possible write and a problem get a dashed box */
.mk { cursor: pointer; border-radius: 3px; outline: 1px solid var(--c); outline-offset: -1px; }
.mk-def { --c: var(--vscode-dataflow-definition); font-weight: bold; }
.mk-write { --c: var(--vscode-dataflow-write); font-weight: bold; }
.mk-mayWrite { --c: var(--vscode-dataflow-write); outline-style: dashed; }
.mk-check { --c: var(--vscode-dataflow-check); }
.mk-read { --c: var(--vscode-dataflow-read); }
.mk-finding { --c: var(--vscode-dataflow-problem); outline-style: dashed; background: var(--vscode-dataflow-problemBackground); }

/* the guide line from the dot on the rail to the first reference of a line. It goes along the bottom edge of the marks,
   below the text. The rails stay in front of it in a horizontal scroll */
.hook { fill: none; stroke: var(--c); stroke-width: 1; opacity: 0.7; }
.mk.lead { position: relative; border-bottom-left-radius: 0; }
.mk.lead::before { content: ''; position: absolute; right: 100%; bottom: 0; width: 100vw; height: 1px; background: var(--c);
  opacity: 0.7; pointer-events: none; }

/* the end of a row: the hints of Flow Lens and Logic Map after the code. If the hints go over the code of a long line,
   the end has only a dot, and the dot stays at the right edge of the side view */
.ends { position: sticky; right: 0; z-index: 1; flex: none; display: inline-flex; align-items: center; gap: 0 12px;
  margin-left: 1.5em; padding: 0 10px 0 6px; overflow: hidden; user-select: none; background: var(--vscode-editor-background);
  box-shadow: -10px 0 8px -6px var(--vscode-editor-background); }
.row.cursor .ends { background: linear-gradient(var(--vscode-editor-lineHighlightBackground, transparent),
  var(--vscode-editor-lineHighlightBackground, transparent)), var(--vscode-editor-background); }
.hint { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic; }
.hint.problem { color: var(--vscode-dataflow-problem); }
/* the dot of the hints of a long line, with the number of the hints if there are more than one. Its card shows the hints */
.ends.short { padding: 0 4px 0 2px; }
.hint.end-mark { display: inline-flex; align-items: center; gap: 4px; padding: 0 5px; border: 0; border-radius: 4px; font: inherit;
  font-size: 0.88em; font-style: normal; color: var(--vscode-dataflow-problem); background: transparent; cursor: pointer; }
.hint.end-mark:hover, .hint.end-mark:focus-visible { background: color-mix(in srgb, var(--vscode-dataflow-problem) 22%, transparent); }
.end-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-dataflow-problem); }
.card.ends-card { pointer-events: auto; max-width: min(420px, calc(100vw - 24px)); }
.ends-item { color: var(--vscode-dataflow-problem); overflow-wrap: anywhere; }

/* during a trace, the code of the lines without a reference of the variable. The end of a row stays opaque, so only
   its hints are dimmed */
.row .code, .row .hint { transition: opacity 150ms ease-out; }
.row.dim .code, .row.dim .hint { opacity: 0.6; }
/* a line that a condition of the preprocessor skips, for example in #if 0, as the C/C++ extension shows it */
.row.inactive .code { opacity: 0.55; }

/* Logic Map: the lines of the steps of the path get a dim version of the color of the path, with no alpha: the color
   of the path in the background of the editor. The line of the step of "Play path", and a step under the mouse in the
   code or in the trail, get the full color */
.row.path-step { background: color-mix(in srgb, var(--vscode-dataflow-pathLine) 10%, var(--vscode-editor-background)); }
.row.path-step .ln { box-shadow: inset -2px 0 0 color-mix(in srgb, var(--vscode-dataflow-pathLine) 45%, var(--vscode-editor-background)); }
.row.path-step:hover, .row.step { background: color-mix(in srgb, var(--vscode-dataflow-pathLine) 26%, var(--vscode-editor-background)); }
.row.path-step:hover .ln, .row.step .ln { color: var(--vscode-editorLineNumber-activeForeground); box-shadow: inset -3px 0 0 var(--vscode-dataflow-pathLine); }
.row.path-step .ends { background: color-mix(in srgb, var(--vscode-dataflow-pathLine) 10%, var(--vscode-editor-background)); }
.row.path-step:hover .ends, .row.step .ends { background: color-mix(in srgb, var(--vscode-dataflow-pathLine) 26%, var(--vscode-editor-background)); }

/* the boxes of Logic Map: an event on the path, and a dereference of a pointer that can be null */
.lk { border-radius: 3px; outline: 1px solid var(--c); outline-offset: -1px; }
.lk-event { --c: var(--vscode-dataflow-event); }
.lk-null { --c: var(--vscode-dataflow-problem); outline-style: dashed; background: var(--vscode-dataflow-problemBackground); }

/* Hidden C++: the colors of the categories, as in the prototype */
.cc-copy, .cc-move { --c: var(--vscode-dataflow-write); }
.cc-conversion { --c: var(--vscode-dataflow-problem); }
.cc-lifetime, .cc-destructor { --c: var(--vscode-dataflow-check); }
.cc-allocation { --c: var(--vscode-dataflow-definition); }
.cc-lookup { --c: var(--vscode-dataflow-read); }
.cc-state { --c: var(--vscode-dataflow-event); }
/* the mark of an item: a line below its code. The chip at the end of the line has the color of the category */
.ck { border-radius: 2px; box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--c) 80%, transparent); }
.ck:hover { background: color-mix(in srgb, var(--c) 18%, transparent); }
.hint.cost-chip { padding: 0 6px; border-radius: 4px; font-style: normal; font-size: 0.88em; line-height: calc(var(--row-height) - 4px);
  cursor: default; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
/* the chips of a row are after its code with their full texts. On a long line, they are outside of the visible area
   until a scroll to the right */
.tags { flex: none; display: inline-flex; align-items: center; gap: 0 8px; margin-left: 1.5em; padding-right: 24px; user-select: none; }
.swatch { flex: none; display: inline-block; width: 9px; height: 9px; border-radius: 2px; background: var(--c); }
.cats { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.cat { display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border-radius: 9px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--vscode-panel-border, transparent); background: transparent; color: var(--vscode-foreground); font: inherit; font-size: 0.92em; }
.cat[aria-pressed="false"] { opacity: 0.55; }
.cat[aria-pressed="false"] .swatch { background: transparent; box-shadow: inset 0 0 0 1.5px var(--c); }
.count { color: var(--vscode-descriptionForeground); }
.card.cost-card { display: grid; gap: 8px; pointer-events: auto; }
.card.above { transform: translateY(-100%); }
.cost-item { display: grid; gap: 2px; }
.cost-head { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; }
.cost-text { font-family: var(--vscode-editor-font-family); }
.cost-detail { font-size: 0.92em; }
button.link.small { justify-self: start; font-size: 0.9em; }
.cost-group { display: grid; gap: 8px; }
.cost-group-title { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-weight: 600; }

/* Change Ripple in the file view: the lines that the changes reach get a dim version of the color of the ripple, with
   no alpha. A possible line is lighter. A changed line has a bar in the color of writes next to its line number */
.row.rp-reached, .row.rp-reached .ends { background: color-mix(in srgb, var(--vscode-dataflow-event) 12%, var(--vscode-editor-background)); }
.row.rp-est, .row.rp-est .ends { background: color-mix(in srgb, var(--vscode-dataflow-event) 6%, var(--vscode-editor-background)); }
.row.rp-change .ln { box-shadow: inset -3px 0 0 var(--vscode-dataflow-write); }
.hint.ripple { color: var(--vscode-dataflow-event); }
.lensbar > .bar-text { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lensbar > .lens.target { max-width: 45%; min-width: 0; }
.lens.target > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* Change Ripple: the story of a review, as in the prototype. The diff and the facts are at the left, and the chain of
   cards is at the right. A narrow side view shows them one after the other */
.story { flex: 1; min-width: 0; overflow: auto; display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: 12px; padding: 12px; }
.story-grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 14px; align-items: start; }
@media (max-width: 900px) { .story-grid { grid-template-columns: minmax(0, 1fr); } }
.story-left { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.story-note { padding: 6px 10px; border-left: 3px solid var(--vscode-dataflow-event); border-radius: 0 6px 6px 0; white-space: pre-wrap;
  background: color-mix(in srgb, var(--vscode-dataflow-event) 10%, var(--vscode-editor-background)); }
.story-note.problem { border-left-color: var(--vscode-dataflow-problem); background: var(--vscode-dataflow-problemBackground); }
.sdiff { min-width: 0; overflow: hidden; border: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border)); border-radius: 8px; }
.sdiff-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 4px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border)); background: var(--vscode-editorGroupHeader-tabsBackground, transparent); }
.sdiff-tab { color: var(--vscode-foreground); }
.code-box { overflow-x: auto; scrollbar-width: thin; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  font-weight: var(--vscode-editor-font-weight); }
.code-rows { display: grid; width: max-content; min-width: 100%; }
.srow { display: flex; height: var(--row-height); line-height: var(--row-height); white-space: pre; cursor: pointer;
  background: var(--vscode-editor-background); transition: background-color 300ms; }
.srow .ln { position: sticky; left: 0; z-index: 1; flex: none; box-sizing: border-box; width: calc(var(--gutter) + 16px); padding: 0 8px 0 4px;
  text-align: right; user-select: none; color: var(--vscode-editorLineNumber-foreground); background: inherit; }
.srow:hover .ln { color: var(--vscode-editorLineNumber-activeForeground); }
.srow .code { flex: none; padding-right: 12px; }
.srow .sign { flex: none; width: 2ch; user-select: none; color: var(--vscode-descriptionForeground); }
.srow.fold { font-style: italic; color: var(--vscode-descriptionForeground); }
.srow.ctx .code { opacity: 0.55; }
/* the diff: the colors of the diff editor of VS Code over the background of the editor */
.srow.d-added { background: linear-gradient(var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.2)),
  var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.2))), var(--vscode-editor-background); }
.srow.d-removed { background: linear-gradient(var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2)),
  var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2))), var(--vscode-editor-background); }
.srow.d-added .sign { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-dataflow-check)); }
.srow.d-removed .sign { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-dataflow-problem)); }
.srow.d-added .chg-text { border-radius: 2px; background: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.3)); }
.srow.d-removed .chg-text { border-radius: 2px; background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.3)); }
.stats { display: flex; flex-wrap: wrap; gap: 6px; }
.stat { padding: 2px 10px; border-radius: 999px; font-size: 0.92em; background: color-mix(in srgb, var(--vscode-dataflow-event) 14%, var(--vscode-editor-background)); }
.story-panel { min-width: 0; padding: 12px; border: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border)); border-radius: 10px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
.panel-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
/* the chain: a line at the left, a dot for each card and an arrow for each link. The wave lights the dots, the arrows,
   the cards and the rows */
.chain { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding-left: 26px; }
.chain::before { content: ''; position: absolute; left: 9px; top: 14px; bottom: 14px; width: 2px;
  background: var(--vscode-panel-border, var(--vscode-descriptionForeground)); }
.scard { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; padding: 6px 0; border-radius: 8px;
  border: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border)); background: var(--vscode-editor-background);
  transition: border-color 300ms, box-shadow 300ms; }
.scard::before { content: ''; position: absolute; left: -23px; top: 10px; box-sizing: border-box; width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid var(--vscode-panel-border, var(--vscode-descriptionForeground)); background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  transition: background-color 300ms, border-color 300ms; }
.scard.lit { border-color: var(--vscode-dataflow-event); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-dataflow-event) 22%, transparent); }
.scard.lit::before { border-color: var(--vscode-dataflow-event); background: var(--vscode-dataflow-event); }
/* a caller level moves the card to the right, and a branch goes from the chain to its dot. The arrow of a link stays
   on the chain, and its text moves with the card */
.chain > .scard { margin-left: calc(var(--depth, 0) * 18px); }
.chain > .slink { padding-left: calc(4px + var(--depth, 0) * 18px); }
.scard.deep::after { content: ''; position: absolute; top: 14px; left: calc(-17px - var(--depth) * 18px); width: calc(var(--depth) * 18px - 6px);
  height: 2px; background: var(--vscode-panel-border, var(--vscode-descriptionForeground)); transition: background-color 300ms; }
.scard.deep.lit::after { background: var(--vscode-dataflow-event); }
.scard.estimated { border-style: dashed; }
.where { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; padding: 0 10px 2px; }
.slink { position: relative; padding: 0 4px; font-size: 0.92em; color: var(--vscode-descriptionForeground); }
.slink::before { content: ''; position: absolute; left: -21px; top: 50%; transform: translateY(-50%); border: 5px solid transparent; border-bottom: 0;
  border-top: 7px solid var(--vscode-panel-border, var(--vscode-descriptionForeground)); transition: border-color 300ms; }
.slink.lit::before { border-top-color: var(--vscode-dataflow-event); }
.slink.k-return, .slink.k-async { color: var(--vscode-dataflow-event); }
.srow.lit { background: color-mix(in srgb, var(--vscode-dataflow-event) 12%, var(--vscode-editor-background)); }
.srow.lit.est { background: color-mix(in srgb, var(--vscode-dataflow-event) 7%, var(--vscode-editor-background)); }
.srow.front { background: color-mix(in srgb, var(--vscode-dataflow-event) 32%, var(--vscode-editor-background)); }
.srow.chg .ln { box-shadow: inset -3px 0 0 var(--vscode-dataflow-write); }
.scard .chg-text { border-radius: 2px; background: color-mix(in srgb, var(--vscode-dataflow-write) 28%, transparent);
  box-shadow: inset 0 -2px 0 var(--vscode-dataflow-write); }
.srow .note { flex: none; margin-left: 1.5em; padding-right: 12px; font-family: var(--vscode-font-family); font-size: 0.92em; font-style: italic;
  color: var(--vscode-dataflow-event); }
/* a note that does not fit beside its code is on the row under the code */
.srow.note-under .note { margin-left: 0; }
.srow.note-under .note::before { content: '↳ '; font-style: normal; }
.exits { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 2px 10px 0; }
.badge { display: inline-block; padding: 0 6px; border: 0; border-radius: 4px; font: inherit; font-size: 0.88em; line-height: 18px; white-space: nowrap;
  color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
button.badge { cursor: pointer; }
button.badge:hover { background: color-mix(in srgb, var(--c) 26%, transparent); }
.badge.k-change { --c: var(--vscode-dataflow-write); }
.badge.k-caller { --c: var(--vscode-dataflow-read); }
.badge.k-estimated { --c: var(--vscode-descriptionForeground); }
.badge.k-exit { --c: var(--vscode-dataflow-check); }
/* Flow Lens for a data member: the thread and the locks of an access, its object, and the file in the side view */
.badge.k-thread { --c: var(--vscode-dataflow-event); }
.badge.k-lock { --c: var(--vscode-dataflow-check); }
.badge.k-object, .badge.k-shown { --c: var(--vscode-descriptionForeground); }
.mgroup { display: grid; gap: 1px; margin-top: 4px; }
.mfiles { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.mfile { display: inline-flex; align-items: baseline; gap: 6px; padding: 0 7px; border-radius: 9px; font-size: 0.92em;
  border: 1px dashed var(--vscode-panel-border, var(--vscode-descriptionForeground)); }
.mgroup-head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.ref.mref { flex-wrap: wrap; row-gap: 0; column-gap: 6px; }
.mref .mfn { font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
.verdict { display: grid; gap: 4px; padding: 6px 10px; border-left: 3px solid var(--c); border-radius: 0 6px 6px 0;
  background: color-mix(in srgb, var(--c) 12%, transparent); }
.verdict.race { --c: var(--vscode-dataflow-problem); }
.verdict.safe { --c: var(--vscode-dataflow-check); }
.verdict.units { --c: var(--vscode-dataflow-read); margin-top: 6px; }
.verdict strong { color: var(--c); }
.verdict .places { display: inline-flex; flex-wrap: wrap; gap: 2px 10px; }
/* the tags of a member after the code of a line: the declaration in a different file, or the accesses in a different
   file. A click opens the place */
.hint.flow-tag { padding: 0 6px; border: 1px solid color-mix(in srgb, var(--vscode-dataflow-definition) 55%, transparent); border-radius: 4px;
  font: inherit; font-size: 0.88em; font-style: normal; line-height: calc(var(--row-height) - 6px); cursor: pointer;
  color: var(--vscode-dataflow-definition); background: color-mix(in srgb, var(--vscode-dataflow-definition) 10%, transparent); }
.hint.flow-tag:hover { background: color-mix(in srgb, var(--vscode-dataflow-definition) 24%, transparent); }
.hint.flow-tag.k-file { border-style: dashed; }
/* Include Hierarchy: the hints after the code of an include line, the bar of the groups, and the include tree */
.hint.inc-hint { padding: 0 6px; border: 0; border-radius: 4px; font: inherit; font-size: 0.88em; font-style: normal;
  line-height: calc(var(--row-height) - 4px); cursor: pointer; --c: var(--vscode-descriptionForeground); color: var(--c);
  background: color-mix(in srgb, var(--c) 12%, transparent); }
.hint.inc-hint:hover { background: color-mix(in srgb, var(--c) 24%, transparent); }
.hint.inc-hint.k-large { --c: var(--vscode-dataflow-write); }
.hint.inc-hint.k-unused, .hint.inc-hint.k-missing { --c: var(--vscode-dataflow-problem); }
.hint.inc-hint.k-skipped { font-style: italic; background: transparent; }
.badge.k-muted { --c: var(--vscode-descriptionForeground); }
.badge.k-problem { --c: var(--vscode-dataflow-problem); }
.sub-title { font-weight: 600; }
.istack { display: flex; height: 10px; overflow: hidden; border-radius: 3px;
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent); }
.istack i { display: block; height: 100%; background: var(--c); }
.ikey { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 0.9em; }
.ikey span { display: inline-flex; align-items: center; gap: 4px; }
.itree { display: grid; grid-template-columns: minmax(0, 1fr); }
.irow { display: grid; grid-template-columns: minmax(0, 1fr) 48px 48px; align-items: center; gap: 6px; padding: 0 4px;
  border-radius: 3px; cursor: pointer; }
.irow:hover { background: var(--vscode-list-hoverBackground); }
.irow[aria-selected="true"] { background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground)); }
.irow.s-skipped .f { opacity: 0.6; }
.iname { display: flex; align-items: center; gap: 4px; min-width: 0; white-space: nowrap; }
.iname .f { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
.iname .iline { color: var(--vscode-descriptionForeground); font-size: 0.88em; }
.tw { flex: none; width: 14px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; font: inherit; }
.ibar { height: 6px; overflow: hidden; border-radius: 3px; background: color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent); }
.ibar i { display: block; height: 100%; background: var(--c); }
.icost { text-align: right; font-family: var(--vscode-editor-font-family); font-size: 0.88em; color: var(--vscode-descriptionForeground); }
.why-path { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; overflow-wrap: anywhere; }
.why-path .arrow { color: var(--vscode-descriptionForeground); }
/* Call Hierarchy: the hints of the calls after the code, the graph over the code, and the lists of the details column.
   The kind of a call gives its color */
.call-hint, .call-what, .cg-sub { --c: var(--vscode-descriptionForeground); }
.call-hint.k-async, .call-hint.k-event, .call-what.k-async, .call-what.k-event, .cg-sub.k-async, .cg-sub.k-event { --c: var(--vscode-dataflow-event); }
.call-hint.k-write, .call-what.k-write, .cg-sub.k-write { --c: var(--vscode-dataflow-write); }
.call-hint.k-check, .call-what.k-check, .cg-sub.k-check { --c: var(--vscode-dataflow-check); }
.call-hint.k-warn, .call-what.k-warn, .cg-sub.k-warn { --c: var(--vscode-dataflow-problem); }
.cg-sub.k-focus { --c: var(--vscode-foreground); }
.hint.call-hint { padding: 0 6px; border: 0; border-radius: 4px; font: inherit; font-size: 0.88em; font-style: normal;
  line-height: calc(var(--row-height) - 4px); cursor: pointer; color: var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); }
.hint.call-hint:hover { background: color-mix(in srgb, var(--c) 24%, transparent); }
.callgraph { flex: none; display: grid; gap: 4px; padding: 4px 10px 6px; border-bottom: 1px solid var(--vscode-editorGroup-border, transparent); }
.callgraph-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.callgraph-bar .grow { flex: 1; }
.callgraph-svg { max-height: 300px; overflow: auto; }
.callgraph svg { display: block; font-family: var(--vscode-font-family); font-size: 12px; }
.cg-edge { fill: none; stroke-width: 1.5; stroke: var(--vscode-descriptionForeground); }
.cg-edge.k-async, .cg-edge.k-event { stroke: var(--vscode-dataflow-event); stroke-dasharray: 5 3; }
.cg-edge.k-write { stroke: var(--vscode-dataflow-write); }
.cg-edge.k-check { stroke: var(--vscode-dataflow-check); }
.cg-edge.k-warn { stroke: var(--vscode-dataflow-problem); }
/* an override that a virtual call can run */
.cg-edge.virtual { stroke-dasharray: 2 3; }
.cg-edge.k-other { stroke-dasharray: 3 3; }
.cg-node { cursor: pointer; outline: none; }
.cg-node rect { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background)); stroke: var(--vscode-descriptionForeground);
  stroke-width: 1.2; }
.cg-node.w-main rect { stroke: var(--vscode-foreground); }
.cg-node.w-project rect, .cg-node.w-library rect, .cg-node.w-other rect { stroke-dasharray: 4 3; }
.cg-node.focus rect { fill: var(--vscode-editor-selectionBackground); stroke: var(--vscode-focusBorder); stroke-width: 2.2; stroke-dasharray: none; }
.cg-node:focus-visible rect { stroke: var(--vscode-focusBorder); stroke-width: 2.2; }
.cg-label { fill: var(--vscode-foreground); }
.cg-node.w-library .cg-label { fill: var(--vscode-descriptionForeground); }
.cg-sub { fill: var(--c); font-size: 11px; }
.call { display: grid; gap: 2px; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.call-who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.call-what { font-size: 0.9em; color: var(--c); }
.call-sites { display: flex; flex-wrap: wrap; gap: 4px; }
/* the list of "Show Calls": over the code near the place of the click. Each call has its line, the function that calls
   and the code. The list stays while the user goes from call to call */
.call-list { position: fixed; z-index: 20; display: flex; flex-direction: column; box-sizing: border-box; width: min(600px, calc(100vw - 16px));
  max-height: min(60vh, 460px); border: 1px solid var(--vscode-editorHoverWidget-border); border-radius: 6px;
  color: var(--vscode-editorHoverWidget-foreground); background: var(--vscode-editorHoverWidget-background);
  box-shadow: 0 4px 16px var(--vscode-widget-shadow, transparent); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.call-list-head { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 10px; border-bottom: 1px solid var(--vscode-editorHoverWidget-border); }
.call-list-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.call-list-close { flex: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: none; color: inherit; font: inherit;
  font-size: 16px; line-height: 1; cursor: pointer; }
.call-list-close:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.call-list-body { min-height: 0; overflow: auto; padding: 2px 0 4px; }
.call-list-file { padding: 4px 10px 1px; font-size: 0.85em; font-weight: 600; color: var(--vscode-descriptionForeground); }
.call-item { display: grid; grid-template-columns: 3.5em minmax(5em, max-content) minmax(0, 1fr); align-items: baseline; gap: 10px; width: 100%;
  padding: 1px 10px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.call-item:hover { background: var(--vscode-list-hoverBackground); }
.call-item:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.call-item.current { background: var(--vscode-list-inactiveSelectionBackground); }
.call-line { text-align: right; font-family: var(--vscode-editor-font-family); font-size: 0.9em; color: var(--vscode-editorLineNumber-foreground); }
.call-caller { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16em; }
.call-text { overflow: hidden; text-overflow: ellipsis; white-space: pre; font-family: var(--vscode-editor-font-family); font-size: 0.92em;
  color: var(--vscode-descriptionForeground); }
.call-list-empty, .call-list-foot { margin: 0; padding: 4px 10px 6px; }
.call-list-foot { border-top: 1px solid var(--vscode-editorHoverWidget-border); }
.call-sites .badge { cursor: pointer; }
.no-motion .scard, .no-motion .scard::before, .no-motion .scard::after, .no-motion .srow, .no-motion .slink::before { transition: none; }

/* the hover card and the curves from the definitions to a use */
.card { position: absolute; z-index: 5; max-width: 420px; padding: 4px 8px; border-radius: 4px; pointer-events: none; white-space: normal;
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5;
  color: var(--vscode-editorHoverWidget-foreground); background: var(--vscode-editorHoverWidget-background);
  border: 1px solid var(--vscode-editorHoverWidget-border); box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent); }
.card-title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.curves { position: absolute; left: 0; z-index: 4; pointer-events: none; overflow: visible; }
.curve path { fill: none; stroke: var(--c); stroke-width: 1.5; stroke-dasharray: 1; stroke-dashoffset: 1; animation: df-draw 320ms ease-out forwards; }
.curve circle { fill: var(--c); }
@keyframes df-draw { to { stroke-dashoffset: 0; } }
/* the card of a line number: why the line runs. The mouse can go into the card */
.card.why-card { pointer-events: auto; }
.why-list { margin: 2px 0 4px; padding-left: 22px; overflow-wrap: anywhere; }
.no-motion .curve path { animation: none; stroke-dashoffset: 0; }
.no-motion .row .code, .no-motion .row .hint, .no-motion .trail-cursor { transition: none; }
@media (prefers-reduced-motion: reduce) {
  .pulse { display: none; }
  .curve path { animation: none; stroke-dashoffset: 0; }
  .row .code, .row .hint, .trail-cursor, .scard, .scard::before, .scard::after, .srow, .slink::before { transition: none; }
}
/* in a narrow side view, the details column is closed at the start. When the user opens it, it shows over the code */
.details.overlay { position: absolute; top: 0; right: 0; bottom: 0; z-index: 6; max-width: calc(100% - 40px);
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border-left: 1px solid var(--vscode-editorWidget-border, var(--vscode-focusBorder));
  box-shadow: 0 0 8px var(--vscode-widget-shadow, transparent); }
.empty { padding: 16px; color: var(--vscode-descriptionForeground); }
.empty p { margin: 0 0 8px; }
.status { flex: none; display: flex; align-items: center; gap: 12px; min-height: 22px; padding: 0 10px; overflow: hidden; white-space: nowrap;
  border-top: 1px solid var(--vscode-editorGroup-border, transparent); color: var(--vscode-descriptionForeground); font-size: 0.92em; }
.status .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.status .error { color: var(--vscode-errorForeground); }
.status button { padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; }
.status button:hover { color: var(--vscode-textLink-activeForeground); }
button:focus-visible, .scroller:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

/* Threads and races: a tint on the code of a worker thread, boxes on the accesses of the selected item, tags on the
   starts and the joins, and the details column with the shared data and the lanes of the two threads */
.c-caller { --c: var(--vscode-dataflow-read); }
.c-worker { --c: var(--vscode-dataflow-event); }
.row.lane-worker, .row.lane-worker .ends { background: color-mix(in srgb, var(--vscode-dataflow-event) 8%, var(--vscode-editor-background)); }
.row.lane-both, .row.lane-both .ends { background: color-mix(in srgb, var(--vscode-dataflow-event) 4%, var(--vscode-editor-background)); }
.row.lane-worker .ln { box-shadow: inset -2px 0 0 color-mix(in srgb, var(--vscode-dataflow-event) 60%, transparent); }
.row.lane-both .ln { box-shadow: inset -2px 0 0 color-mix(in srgb, var(--vscode-dataflow-event) 30%, transparent); }
.thw { border-radius: 3px; outline: 1px solid var(--c); outline-offset: -1px; }
.thw-caller { --c: var(--vscode-dataflow-read); }
.thw-worker { --c: var(--vscode-dataflow-event); }
.thw-write, .thw-def { font-weight: bold; }
.thw-mayWrite { outline-style: dashed; }
.thw-race { --c: var(--vscode-dataflow-problem); outline: 1.5px dashed var(--c); background: var(--vscode-dataflow-problemBackground); }
.thw-check { --c: var(--vscode-dataflow-write); outline: 1.5px dashed var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); }
.hint.thread-hint { --c: var(--vscode-dataflow-event); padding: 0 6px; border: 0; border-radius: 4px; font: inherit; font-size: 0.88em;
  font-style: normal; line-height: calc(var(--row-height) - 4px); cursor: pointer; color: var(--c);
  background: color-mix(in srgb, var(--c) 12%, transparent); }
.hint.thread-hint:hover { background: color-mix(in srgb, var(--c) 24%, transparent); }
.hint.thread-hint.k-join { --c: var(--vscode-dataflow-check); }
.hint.thread-hint.k-race { --c: var(--vscode-dataflow-problem); }
.hint.thread-hint.k-check { --c: var(--vscode-dataflow-write); }
.threads .tlist, .threads .titems { display: grid; gap: 4px; }
.tstart { display: grid; gap: 0; }
.titem { display: grid; gap: 1px; padding: 4px 8px; border: 1px solid var(--vscode-panel-border, transparent); border-radius: 6px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.titem:hover { background: var(--vscode-list-hoverBackground); }
.titem[aria-selected="true"] { border-color: var(--vscode-focusBorder); background: var(--vscode-list-inactiveSelectionBackground); }
.titem .sub, .lnote { overflow-wrap: anywhere; }
.trow { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.trow .mono { overflow-wrap: anywhere; }
.vpill { flex: none; padding: 1px 7px; border-radius: 999px; font-size: 0.85em; font-weight: 600; white-space: nowrap; color: var(--c);
  background: color-mix(in srgb, var(--c) 15%, transparent); }
.v-race { --c: var(--vscode-dataflow-problem); }
.v-check { --c: var(--vscode-dataflow-write); }
.v-safe { --c: var(--vscode-dataflow-check); }
.tpanel { display: grid; gap: 8px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border, transparent); }
.lanes { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px 8px; }
.lhead { padding-bottom: 3px; border-bottom: 2px solid var(--c); color: var(--c); font-size: 0.9em; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lstep { display: grid; gap: 2px; min-width: 0; padding: 4px 6px; border: 1px solid var(--vscode-panel-border, transparent); border-radius: 6px;
  background: var(--vscode-editor-background); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.lstep:hover { border-color: var(--vscode-focusBorder); }
.lstep.ok { border-color: color-mix(in srgb, var(--vscode-dataflow-check) 70%, transparent); }
.lstep.race { border: 1.5px dashed var(--vscode-dataflow-problem); background: var(--vscode-dataflow-problemBackground); }
.lstep.check { border: 1.5px dashed var(--vscode-dataflow-write);
  background: color-mix(in srgb, var(--vscode-dataflow-write) 10%, var(--vscode-editor-background)); }
.lmeta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
.lno { font-family: var(--vscode-editor-font-family); color: var(--vscode-foreground); }
.lmeta .role { font-weight: 600; }
.r-write, .r-mayWrite, .r-def { color: var(--vscode-dataflow-write); }
.r-read { color: var(--vscode-dataflow-read); }
.r-check { color: var(--vscode-dataflow-check); }
.lcode { display: block; overflow: hidden; text-overflow: ellipsis; white-space: pre; font-family: var(--vscode-editor-font-family);
  font-size: 0.92em; }
.lnote { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
.lsync { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 0; border: 0; background: none; cursor: pointer;
  color: var(--vscode-dataflow-check); font: inherit; font-size: 0.88em; text-align: left; }
.lsync::before, .lsync::after { content: ''; flex: 1 1 12px; min-width: 12px; border-top: 1.5px dashed currentColor; }
.lpair { grid-column: 1 / -1; margin: 0; color: var(--c); font-size: 0.88em; font-weight: 600; }
.tsum { margin: 0; }
.fixdiff { margin: 0; padding: 4px 8px; overflow-x: auto; border-radius: 4px; background: var(--vscode-editor-background);
  font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
.fixdiff .del { color: var(--vscode-dataflow-problem); }
.fixdiff .add { color: var(--vscode-dataflow-check); }

/* The layers of a language model: a bar beside the line numbers of each block (one more bar for each level of child
   blocks), the title of a block, the notes and the comments at the end of the lines, a color on each highlighted range,
   and the details column. The text of the model has a badge, and a comment has a star. The step between two bars is
   BAR_STEP of CodeView.tsx. */
.mbar { position: absolute; top: 0; bottom: 0; width: 3px; background: var(--vscode-dataflow-model); pointer-events: none; }
.mbar.first { top: 2px; border-top-left-radius: 2px; border-top-right-radius: 2px; }
.mbar.last { bottom: 2px; border-bottom-left-radius: 2px; border-bottom-right-radius: 2px; }
.mbar.lv-0 { left: 1px; }
.mbar.lv-1 { left: 6px; background: color-mix(in srgb, var(--vscode-dataflow-model) 55%, transparent); }
.mbar.lv-2 { left: 11px; background: color-mix(in srgb, var(--vscode-dataflow-model) 45%, transparent); }
.mbar.lv-3 { left: 16px; background: color-mix(in srgb, var(--vscode-dataflow-model) 38%, transparent); }
.mbar.lv-4 { left: 21px; background: color-mix(in srgb, var(--vscode-dataflow-model) 32%, transparent); }
/* the colors that a model can select for a comment: the chart colors of the theme */
.mc-blue { --mc: var(--vscode-charts-blue); }
.mc-green { --mc: var(--vscode-charts-green); }
.mc-purple { --mc: var(--vscode-charts-purple); }
.mc-yellow { --mc: var(--vscode-charts-yellow); }
.mc-orange { --mc: var(--vscode-charts-orange); }
.mc-red { --mc: var(--vscode-charts-red); }
.mc-gray { --mc: var(--vscode-descriptionForeground); }
/* a detail of a model: a symbol at the end of the first line of its code. The mouse on the symbol opens the card of the
   detail, and the code of the detail gets a background while the card shows. The width is DETAIL_MARK_PX of CodeView */
.hint.detail-mark { flex: none; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; width: 16px;
  height: 16px; padding: 0; border: 1px solid color-mix(in srgb, var(--vscode-dataflow-model) 70%, transparent); border-radius: 50%;
  font-family: Georgia, 'Times New Roman', serif; font-size: 11px; font-style: italic; font-weight: 700; line-height: 1;
  color: var(--vscode-dataflow-model); background: color-mix(in srgb, var(--vscode-dataflow-model) 10%, transparent); cursor: help; }
.hint.detail-mark:hover, .hint.detail-mark:focus-visible { background: color-mix(in srgb, var(--vscode-dataflow-model) 30%, transparent); }
.mdetail { border-radius: 2px; background: color-mix(in srgb, var(--vscode-dataflow-model) 18%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-dataflow-model) 45%, transparent); }
.card.detail-card { pointer-events: auto; max-width: min(440px, calc(100vw - 24px)); max-height: min(60vh, 460px); overflow: auto; padding: 6px 10px; }
.detail-card .card-title { margin-bottom: 4px; }
.detail-title { overflow-wrap: anywhere; }
.md { overflow-wrap: anywhere; }
.md p { margin: 0 0 6px; }
.md > :last-child { margin-bottom: 0; }
.md .md-h { font-weight: 600; }
.md ul, .md ol { margin: 0 0 6px; padding-left: 20px; }
.md li { margin: 1px 0; }
.md code { padding: 0 3px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.92em;
  background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.15)); }
.md pre { margin: 0 0 6px; padding: 4px 8px; border-radius: 4px; overflow-x: auto; background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.15)); }
.md pre code { padding: 0; background: none; white-space: pre; overflow-wrap: normal; }
.row.note-problem, .row.note-problem .ends { background: var(--vscode-dataflow-problemBackground); }
.row.note-warning, .row.note-warning .ends { background: color-mix(in srgb, var(--vscode-dataflow-write) 12%, var(--vscode-editor-background)); }
.row.note-info, .row.note-info .ends { background: color-mix(in srgb, var(--vscode-dataflow-model) 9%, var(--vscode-editor-background)); }
.mpill, .epill { display: inline-block; margin-right: 5px; padding: 0 5px; border-radius: 999px; font-size: 0.75em; font-weight: 600;
  font-style: normal; letter-spacing: 0.04em; text-transform: uppercase; line-height: 1.5; vertical-align: 1px; }
.mpill { color: var(--vscode-dataflow-model); background: color-mix(in srgb, var(--vscode-dataflow-model) 16%, transparent); }
.epill { color: var(--vscode-dataflow-pathLine); background: color-mix(in srgb, var(--vscode-dataflow-pathLine) 16%, transparent); }
.hint.model-tag { --c: var(--vscode-dataflow-model); padding: 0 6px; border: 0; border-radius: 4px; font: inherit; font-size: 0.88em;
  font-style: normal; line-height: calc(var(--row-height) - 4px); cursor: pointer; color: var(--c);
  background: color-mix(in srgb, var(--c) 10%, transparent); }
.hint.model-tag:hover { background: color-mix(in srgb, var(--c) 22%, transparent); }
.hint.model-tag.k-block { font-weight: 600; }
.hint.model-tag.k-problem { --c: var(--vscode-dataflow-problem); }
.hint.model-tag.k-warning { --c: var(--vscode-dataflow-write); }
.hint.model-tag.k-comment { --c: var(--mc, var(--vscode-dataflow-modelComment)); font-style: italic; }
.hint.model-tag.k-comment::before, .mbar-comment::before { content: "✦"; margin-right: 4px; font-style: normal;
  color: var(--vscode-dataflow-model); }
.modelbar .mcrumb .mnum { display: inline-block; margin-right: 4px; }
.modelbar .mcrumb .mtitle { font-weight: 600; }
.modelbar .mcrumb .sep { margin: 0 6px; opacity: 0.7; }
.mbar-note { flex: 0 1 auto; min-width: 0; max-width: 45%; padding: 0 6px; border-radius: 4px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--vscode-dataflow-model); background: color-mix(in srgb, var(--vscode-dataflow-model) 12%, transparent); }
.mbar-note.k-problem { color: var(--vscode-dataflow-problem); background: var(--vscode-dataflow-problemBackground); }
.mbar-note.k-warning { color: var(--vscode-dataflow-write); background: color-mix(in srgb, var(--vscode-dataflow-write) 12%, transparent); }
.mbar-detail { flex: 0 1 auto; min-width: 0; max-width: 40%; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--vscode-dataflow-model); text-decoration: underline dotted; text-underline-offset: 3px; cursor: help; }
.mbar-comment { flex: 0 1 auto; min-width: 0; max-width: 45%; padding: 0 6px; border-radius: 4px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-style: italic; color: var(--mc, var(--vscode-dataflow-modelComment));
  background: color-mix(in srgb, var(--mc, var(--vscode-dataflow-modelComment)) 12%, transparent); }
.model .mblocks, .model .mnotes { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
/* the functions with blocks in the tab Model. The function at the cursor is bold */
.mfns { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.mfn.current { font-weight: 600; }
.mblock { display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; padding: 4px 8px; border: 1px solid var(--vscode-panel-border, transparent);
  border-left: 3px solid var(--vscode-dataflow-model); border-radius: 6px; }
.mblock.lvl-1 { margin-left: 12px; border-left-color: color-mix(in srgb, var(--vscode-dataflow-model) 55%, transparent); }
.mblock.lvl-2 { margin-left: 24px; border-left-color: color-mix(in srgb, var(--vscode-dataflow-model) 45%, transparent); }
.mblock.lvl-3 { margin-left: 36px; border-left-color: color-mix(in srgb, var(--vscode-dataflow-model) 38%, transparent); }
.mblock.lvl-4 { margin-left: 48px; border-left-color: color-mix(in srgb, var(--vscode-dataflow-model) 32%, transparent); }
.mblock.sel { border-color: var(--vscode-focusBorder); border-left-color: var(--vscode-dataflow-model); background: var(--vscode-list-inactiveSelectionBackground); }
.mblock.k-problem { border-left-color: var(--vscode-dataflow-problem); }
.mblock.k-warning { border-left-color: var(--vscode-dataflow-write); }
.mhead { display: flex; align-items: baseline; gap: 6px; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left;
  cursor: pointer; min-width: 0; }
.mhead:hover .mtitle { color: var(--vscode-textLink-activeForeground); }
.mnum { flex: none; min-width: 1.6em; padding: 0 4px; border-radius: 999px; text-align: center; font-size: 0.85em; font-weight: 600;
  color: var(--vscode-editor-background); background: var(--vscode-dataflow-model); }
.mblock:not(.lvl-0) .mnum { color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-dataflow-model) 30%, transparent); }
.mtitle { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.mlines { flex: none; font-family: var(--vscode-editor-font-family); font-size: 0.9em; color: var(--vscode-descriptionForeground); }
.msum { margin: 0; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
.mdata { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; }
.io { max-width: 100%; padding: 0 5px; border: 1px solid var(--vscode-panel-border, transparent); border-radius: 4px; background: transparent;
  color: inherit; font-family: var(--vscode-editor-font-family); font-size: 0.85em; line-height: 1.5; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; box-sizing: border-box; }
.io.in { border-color: color-mix(in srgb, var(--vscode-dataflow-read) 50%, transparent); color: var(--vscode-dataflow-read); }
.io.out { border-color: color-mix(in srgb, var(--vscode-dataflow-write) 50%, transparent); color: var(--vscode-dataflow-write); }
.io.arrow { border: 0; padding: 0 1px; color: var(--vscode-descriptionForeground); }
.io.more { font-style: italic; }
button.io { cursor: pointer; }
button.io:hover { background: var(--vscode-list-hoverBackground); }
.io.k-thread, .io.k-event { border-color: color-mix(in srgb, var(--vscode-dataflow-event) 50%, transparent); color: var(--vscode-dataflow-event); }
.io.k-exit { border-color: color-mix(in srgb, var(--vscode-dataflow-definition) 50%, transparent); color: var(--vscode-dataflow-definition); }
.mnote { display: flex; align-items: baseline; gap: 6px; margin: 0; padding: 2px 6px; border: 0; border-radius: 4px; color: inherit; font: inherit;
  text-align: left; background: color-mix(in srgb, var(--vscode-dataflow-model) 9%, transparent); overflow-wrap: anywhere; }
button.mnote { cursor: pointer; }
.mnote.k-problem { background: var(--vscode-dataflow-problemBackground); }
.mnote.k-warning { background: color-mix(in srgb, var(--vscode-dataflow-write) 12%, transparent); }
.mcomment { display: flex; align-items: baseline; gap: 6px; margin: 0; padding: 2px 6px; border: 0; border-radius: 4px; color: inherit; font: inherit;
  text-align: left; cursor: pointer; overflow-wrap: anywhere; background: color-mix(in srgb, var(--mc, var(--vscode-dataflow-modelComment)) 9%, transparent); }
.mcomment .mctext { font-style: italic; color: var(--mc, var(--vscode-dataflow-modelComment)); }
.mdetail-item { padding: 2px 6px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-dataflow-model) 7%, transparent); }
.mdetail-item summary { cursor: pointer; }
.mdetail-item summary .mtitle { text-decoration: underline dotted color-mix(in srgb, var(--vscode-dataflow-model) 85%, transparent);
  text-underline-offset: 3px; }
.mdetail-item .md { margin: 4px 0 2px; }
.mcomment .mctext::before { content: "✦"; margin-right: 4px; font-style: normal; color: var(--vscode-dataflow-model); }
.mcp-status { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; padding-top: 6px;
  border-top: 1px solid var(--vscode-panel-border, transparent); }
.mcp-status .sub { overflow-wrap: anywhere; }

/* the guided review: the bar, the lines of the current step, and the plan in the tab Guide. The color is the theme color
   dataflow.reviewGuide, by default the blue of the chart colors */
.rg-pill { display: inline-block; margin-right: 5px; padding: 0 5px; border-radius: 999px; font-size: 0.75em; font-weight: 600;
  font-style: normal; letter-spacing: 0.04em; text-transform: uppercase; line-height: 1.5; vertical-align: 1px;
  color: var(--vscode-dataflow-reviewGuide); background: color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 16%, transparent); }
.rg-bar { gap: 4px 8px; background: color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 6%, transparent); }
.rg-bar .rg-pos { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.rg-bar .lens[disabled], .rg-actions .lens[disabled] { opacity: 0.45; cursor: default; }
.rg-bar .rg-title { padding: 0; border: 0; background: none; color: var(--vscode-foreground); font: inherit; font-weight: 600;
  text-align: left; cursor: pointer; }
.rg-bar .rg-title:hover { color: var(--vscode-textLink-activeForeground); }
.rg-marks { display: inline-flex; gap: 4px; }
.rg-mark { padding: 1px 7px; }
.rg-mark .rg-icon { font-weight: 700; }
.rg-mark.st-ok[aria-pressed="true"] { border-color: var(--vscode-charts-green); color: var(--vscode-charts-green); }
.rg-mark.st-issue[aria-pressed="true"] { border-color: var(--vscode-dataflow-problem); color: var(--vscode-dataflow-problem); }
.rg-mark.st-question[aria-pressed="true"] { border-color: var(--vscode-charts-yellow); color: var(--vscode-charts-yellow); }
.row.rg-line, .row.rg-line .ends { background: color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 11%, var(--vscode-editor-background)); }
.row.rg-line .ln { box-shadow: inset -3px 0 0 var(--vscode-dataflow-reviewGuide); color: var(--vscode-editorLineNumber-activeForeground); }
.row.rg-first, .row.rg-only { box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 55%, transparent); }
.row.rg-last, .row.rg-only { box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 55%, transparent); }
.row.rg-only { box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 55%, transparent),
  inset 0 -1px 0 color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 55%, transparent); }
.hint.rg-tag { padding: 0 6px; border-radius: 4px; font-size: 0.88em; font-style: normal; line-height: calc(var(--row-height) - 4px);
  color: var(--vscode-dataflow-reviewGuide); background: color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 12%, transparent); }
.rg-details .rg-progress { display: grid; gap: 4px; }
.rg-track { display: block; height: 4px; border-radius: 2px; overflow: hidden;
  background: color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 18%, transparent); }
.rg-track i { display: block; height: 100%; background: var(--vscode-dataflow-reviewGuide); transition: width 0.3s; }
.rg-steps { display: grid; gap: 4px; margin: 2px 0 0; padding: 0; list-style: none; }
.rg-step { border: 1px solid var(--vscode-panel-border, transparent); border-left: 3px solid
  color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 35%, transparent); border-radius: 4px; }
.rg-step.current { border-color: var(--vscode-focusBorder); border-left-color: var(--vscode-dataflow-reviewGuide);
  background: var(--vscode-list-inactiveSelectionBackground); }
.rg-step.st-ok { border-left-color: var(--vscode-charts-green); }
.rg-step.st-issue { border-left-color: var(--vscode-dataflow-problem); }
.rg-step.st-question { border-left-color: var(--vscode-charts-yellow); }
.rg-head { display: flex; align-items: baseline; gap: 6px; width: 100%; padding: 4px 8px; border: 0; background: none; color: inherit;
  font: inherit; text-align: left; cursor: pointer; }
.rg-head:hover .rg-step-title { color: var(--vscode-textLink-activeForeground); }
.rg-num { flex: none; min-width: 1.6em; padding: 0 4px; border-radius: 999px; text-align: center; font-size: 0.85em; font-weight: 700;
  color: var(--vscode-dataflow-reviewGuide); background: color-mix(in srgb, var(--vscode-dataflow-reviewGuide) 16%, transparent); }
.rg-num.st-ok { color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 16%, transparent); }
.rg-num.st-issue { color: var(--vscode-dataflow-problem); background: color-mix(in srgb, var(--vscode-dataflow-problem) 16%, transparent); }
.rg-num.st-question { color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 16%, transparent); }
.rg-head-text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.rg-step-title { font-weight: 600; overflow-wrap: anywhere; }
.rg-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; }
.rg-kind { flex: none; padding: 0 5px; border-radius: 4px; font-size: 0.8em; color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
.rg-kind.k-risk { color: var(--vscode-dataflow-problem); }
.rg-kind.k-change { color: var(--vscode-dataflow-reviewGuide); }
.rg-place { flex: none; font-family: var(--vscode-editor-font-family); font-size: 0.85em; color: var(--vscode-descriptionForeground); }
.rg-body { display: grid; gap: 6px; padding: 0 8px 8px 32px; }
.rg-checks { margin: 0; padding-left: 18px; }
.rg-checks li::marker { content: "☐  "; color: var(--vscode-dataflow-reviewGuide); }
.rg-note { padding: 4px 6px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-dataflow-model) 7%, transparent); }
.rg-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.rg-gap { flex: 1; }
.rg-footer { display: flex; gap: 8px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border, transparent); }
`;

// The number of levels with their own rule for the indent guides, as in the text editor
const GUIDE_LEVELS = 30;

let tokenStyles: SideStyle[] = [];
let brackets: SideBrackets | undefined;
let bracketColors = true;

// A color is safe in a stylesheet only if it is a hex color, an rgb color or a CSS variable of VS Code
function safeColor(color: string | undefined): string | undefined {
	return color && (/^#[0-9a-fA-F]{3,8}$/.test(color) || /^rgba?\([\d\s.,%/]+\)$/.test(color) || /^var\(--vscode-[\w-]+\)$/.test(color))
		? color : undefined;
}

// The value of a theme color of VS Code, or undefined if the color is not set or is transparent
function themeColor(name: string): string | undefined {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	if (!safeColor(value) || value.startsWith('var(')) {
		return undefined;
	}
	const hex = /^#(?:[0-9a-f]{3}([0-9a-f])|[0-9a-f]{6}([0-9a-f]{2}))$/i.exec(value);
	if (hex && /^0+$/.test(hex[1] ?? hex[2])) {
		return undefined;
	}
	const rgba = /^rgba\(.*[,/]\s*0(\.0*)?\s*\)$/i.exec(value);
	return rgba ? undefined : value;
}

function declarations(s: SideStyle | undefined): string[] {
	if (!s) {
		return [];
	}
	const decl: string[] = [];
	const color = safeColor(s.color);
	if (color) {
		decl.push(`color: ${color}`);
	}
	if (s.bold !== undefined) {
		decl.push(`font-weight: ${s.bold ? 'bold' : 'inherit'}`);
	}
	if (s.italic !== undefined) {
		decl.push(`font-style: ${s.italic ? 'italic' : 'normal'}`);
	}
	if (s.underline !== undefined || s.strikethrough !== undefined) {
		const lines = [s.underline ? 'underline' : '', s.strikethrough ? 'line-through' : ''].filter(Boolean);
		decl.push(`text-decoration: ${lines.length > 0 ? lines.join(' ') : 'none'}`);
	}
	return decl;
}

function rule(index: number, decl: string[]): string {
	return decl.length > 0 ? `.t${index} { ${decl.join('; ')}; }` : '';
}

// The colors of the bracket pairs, as in the text editor: the levels of nesting go through the bracket colors of the
// theme that are not transparent
function bracketCss(): string[] {
	if (!brackets) {
		return [];
	}
	const punctuation = declarations(tokenStyles[brackets.punctuation]);
	const colors = bracketColors
		? [1, 2, 3, 4, 5, 6].map((i) => themeColor(`--vscode-editorBracketHighlight-foreground${i}`)).filter((c): c is string => !!c)
		: [];
	const out: string[] = [];
	for (let level = 0; level < brackets.levels; level++) {
		out.push(rule(brackets.first + level, colors.length > 0 ? [`color: ${colors[level % colors.length]}`] : punctuation));
	}
	// VS Code changes only the first dot of the color id to a dash in the name of the variable
	const unexpected = bracketColors ? themeColor('--vscode-editorBracketHighlight-unexpectedBracket.foreground') : undefined;
	out.push(rule(brackets.first + brackets.levels, unexpected ? [`color: ${unexpected}`] : punctuation));
	return out;
}

// The colors of the indent guides, as in the text editor: the levels go through the pairs of guide colors of the
// theme that are not transparent
function guideCss(): string[] {
	const pairs = [1, 2, 3, 4, 5, 6]
		.map((i) => [themeColor(`--vscode-editorIndentGuide-background${i}`), themeColor(`--vscode-editorIndentGuide-activeBackground${i}`)])
		.filter(([color, active]) => color && active);
	if (pairs.length === 0) {
		return [];
	}
	const out: string[] = [];
	for (let level = 0; level < GUIDE_LEVELS; level++) {
		const [color, active] = pairs[level % pairs.length];
		out.push(`.guide.lvl-${level} { background: ${color}; }`, `.guide.lvl-${level}.active { background: ${active}; }`);
	}
	return out;
}

const base = new CSSStyleSheet();
base.replaceSync(BASE_CSS);
const tokens = new CSSStyleSheet();
document.adoptedStyleSheets = [base, tokens];

function update(): void {
	tokens.replaceSync([...tokenStyles.map((s, i) => rule(i, declarations(s))), ...bracketCss(), ...guideCss()]
		.filter(Boolean).join('\n'));
}

export function setTokenStyles(styles: SideStyle[], bracketStyles: SideBrackets): void {
	tokenStyles = styles;
	brackets = bracketStyles;
	update();
}

export function setBracketColors(isOn: boolean): void {
	if (isOn !== bracketColors) {
		bracketColors = isOn;
		update();
	}
}

// VS Code changes the CSS variables of the webview when the color theme changes
let frame = 0;
new MutationObserver(() => {
	cancelAnimationFrame(frame);
	frame = requestAnimationFrame(update);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
