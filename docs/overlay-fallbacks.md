# Fallback options for the editor overlays

- Date: 26 October 2026
- Status: research. No option has a prototype. Section 8 gives the facts from the code of VS Code 1.143.1.
- Plan: [implementation-strategy.md](implementation-strategy.md), decisions D1 and D7, sections 6.3 and 12
- Open issues: [TODO.md](../TODO.md)

## 1. Purpose

This document gives other ways to show the data of the lenses, if the overlays in the VS Code editor are not good enough. For each option, it gives the result, the risk and the size. Section 6 gives a recommendation.

## 2. The parts that are at risk

P0 spike (a) showed that the effects work in VS Code, see [p0-spike-results.md](p0-spike-results.md). The risk is now different. The effects can be difficult to read on real code, or they can show less than the prototypes. The prototypes are in the design study DataFlow Visual Prototypes, which is not a part of the repository.

| Part | Method now | Risk |
| --- | --- | --- |
| Token marks: boxes, and lines below names | Decorations with borders | Low. This is the normal method of the decoration API. |
| Dimmed lines | Whole-line decorations with `opacity` | Low. A part of a line needs a range decoration, see [TODO.md](../TODO.md). |
| Hints at the end of a line | `after` decorations with `contentText` | Low |
| Marks in the overview ruler | `overviewRulerColor` in the decorations | Low |
| Rails | One SVG gutter icon for each line, about 19 × 19 px at the default font size. Each icon has the scope rail and 3 slots for Flow Lens. | High. A rail cannot go into the text. An SVG icon cannot read theme colors. If a variable needs more than 3 slots, the other rails do not show. |
| Pulse | SMIL animation in the gutter icons, 650 ms for each rail | Medium. The pulse moves only in the glyph margin. |
| Path walk, and the wave of Change Ripple | Steps of `setDecorations`. The path walk takes 120 ms for each step. The strategy sets a maximum of 10 steps each second. | High. The movement is not smooth. |
| Curves, arrows and glow in the text area | None. The stable API has no method for them. | Not possible with the stable API |

## 3. Where the risk is in the code

Only 2 files draw in the editor: [src/render/overlay.ts](../src/render/overlay.ts) and [src/render/rails.ts](../src/render/rails.ts). Together, they have about 530 lines. Only `src/extension.ts` imports the renderer in `overlay.ts`. These parts of DataFlow do not use the 2 files:

- the engine and its JSON-RPC protocol
- the DataFlow panel
- the lens logic in `src/lenses/flow.ts`, `src/lenses/logic.ts`, `src/lenses/cost.ts` and `src/logic/paths.ts`. These modules do not import `vscode`.

Each option in section 4 replaces the renderer or adds a renderer. No option changes the engine.

## 4. Options

Each option has a letter. Section 5 compares the options.

### 4.1 Option A: CSS through decorations

VS Code does not escape the value of the decoration property `textDecoration`. It puts the value into its Cascading Style Sheets (CSS) rule with no change. The attachments `before` and `after` have the same property. So an attachment with a value such as `none; position: absolute; ...` can have any position, any size and any CSS effect.

The extension [Power Mode](https://github.com/hoovercj/vscode-power-mode) uses this method for its effects, in `src/cursor-exploder/cursor-exploder.ts`.

- **Result:** rails and curves in the text area, for example in the indent space at the left of the code. Glow with `box-shadow` or `filter: drop-shadow()`. Theme colors in CSS borders and backgrounds, for example `var(--vscode-dataflow-read)`. An SVG image still cannot read theme colors.
- **Risk:** this behavior is not in the API reference of VS Code. If a new release of VS Code escapes the value, the effects stop with no error message.
- **Risk:** VS Code draws only the visible lines. Folded regions, word wrap, CodeLens and inlay hints change the positions of the lines. So draw one part of a rail on each line, as the gutter icons do now. One large SVG for many lines does not stay in the correct position, and it goes away when its first line is not visible.
- **Mitigation:** keep the current renderer as a setting. After each update of VS Code, do a screenshot test with the Chrome DevTools Protocol scripts in `spikes/`.
- **Size:** small.

### 4.2 Option B: editor insets

The proposed API `editorInsets` puts a webview between 2 lines of the text editor. The function is `vscode.window.createWebviewTextEditorInset`. The webview can show a small graph or a short animation, for example below the first line of a function.

- VS Code 1.143.1 has this API.
- The Marketplace does not accept an extension that uses a proposed API.
- The extension must have `"enabledApiProposals": ["editorInsets"]` in `package.json`.
- A stable build of VS Code lets the extension use the API only with the command line switch `--enable-proposed-api local-dev.dataflow`. The key `enable-proposed-api` in `argv.json` does the same for one installation.
- On a stable build, the Extension Development Host does not turn on proposed APIs. Add the switch to the arguments in `.vscode/launch.json`.
- The API is not new, but it is still a proposal. Microsoft can change it or remove it in a new release.

- **Result:** HTML, SVG and canvas between the lines of the code.
- **Risk:** Microsoft can change or remove the API. DataFlow can use this option only as a VSIX file that the user installs, not from the Marketplace.
- **Size:** medium.

### 4.3 Option C: calm overlays

This option keeps the parts with low risk: the token marks, the dimmed lines, the hints and the marks in the overview ruler. It replaces the movement with numbered steps, and with commands that go to the next step or to the step before. CodeQL and CodeChecker show the steps of a path in the same way. The research in the design study recommends calm views, with movement only to show a sequence.

- **Result:** fewer effects than the prototypes. All parts use the stable API.
- **Risk:** none.
- **Size:** small.

### 4.4 Option D: a side view next to the editor

A `WebviewPanel` in an editor group next to the code shows the current function. The Markdown preview of VS Code uses the same method. The side view shows the code as read-only text, with full control of SVG, canvas and CSS. So it can show curves, a smooth path walk, the wave of Change Ripple and, in a later version, Flow Graph.

The side view and the text editor show the same position:

- The text editor sends the cursor position and the visible lines to the side view.
- A click in the side view moves the text editor to the line, with `revealRange`.

The design study has a renderer for each prototype, for example `editor.js`, `p-flowlens.js`, `p-logic.js` and `p-ripple.js`. The design study wrote the data in these files by hand. The side view can give the model of the engine to these renderers.

Syntax colors need a solution:

- A webview gets the colors of the workbench as CSS variables. The DataFlow panel uses them, for example `var(--vscode-dataflow-problem)`.
- A webview does not get the token colors of the color theme. Shiki can read the JSON file of the active color theme and the TextMate grammars. Then the colors are almost the same as in the editor. The semantic colors of clangd or cpptools do not show.
- Monaco, the editor component of VS Code, can also run in the webview. It gives the behavior of an editor, but it is larger, and it also needs the theme and the grammar.

A `CustomTextEditorProvider` is a different form of this option. Decision D1 rejected a custom editor as the main view, because it replaces the text editor. As a second editor next to the text editor, it is possible. It gets each change of the document from VS Code.

- **Result:** all effects of the prototypes. The text editor keeps clangd or cpptools, the edits and the decorations.
- **Risk:** low. The option uses only the stable API. The user sees 2 views of the same code, and the side view needs space on the screen.
- **Size:** medium to large.

### 4.5 Option E: a Qt viewer

A separate Qt program shows the code and the overlays. It can use QML, Qt Quick Shapes and shaders, so it has full control of the effects. A small extension in VS Code sends the file and the cursor position through a local socket. A plugin for a different editor can send the same data.

The Qt viewer must use the engine through JSON-RPC, as the extension does. It cannot contain the engine:

- The LLVM libraries use the static runtime `/MT`.
- The Qt packages from the Qt installer use the dynamic runtime `/MD`.
- The MSVC linker stops with error LNK2038 if one program mixes the 2 runtimes.

The Qt viewer also needs these parts:

- its own code view, with scroll bars, fonts, text selection, folded regions and large files
- the lens logic in C++ or in the engine. Now the lens logic is in TypeScript.

- **Result:** all effects. A second screen can show the Qt viewer during a review. The Qt viewer works next to each editor, for example Visual Studio or Qt Creator.
- **Risk:** the project becomes much larger.
- **Size:** large.

### 4.6 Option F: an HTML review page

A command or a continuous integration (CI) job runs the engine on a diff. Then it writes one HTML file that contains the code, the data and the effects.

- Reviewers without DataFlow can open the page.
- The page can use the code of the prototypes.
- This option is good for Change Ripple, because reviews can occur on GitHub and not in VS Code.
- The design study asked where the team does reviews: in VS Code or in a web tool. This question has no answer yet.

- **Result:** all effects, with no limits of an editor. The page shows a result, but the user cannot change the code in it.
- **Risk:** low.
- **Size:** medium.

### 4.7 Option G: a different IDE

Some integrated development environments (IDE) have an API that can draw any shape in the editor:

| IDE | Method | Language | Note |
| --- | --- | --- | --- |
| Visual Studio | Adornment layers of the editor in the Visual Studio software development kit (VSSDK), with Windows Presentation Foundation (WPF) | C# | Any shape and animation in the text view. The position comes from the text layout. |
| CLion | Custom renderers of the IntelliJ Platform, with Graphics2D | Kotlin | The renderers draw in the editor and in the gutter. |
| Qt Creator | A plugin draws on the viewport of the editor. The editor class `TextEditorWidget` is a subclass of `QPlainTextEdit`. | C++ | Each release of Qt Creator needs a new build of the plugin. Good for qmake projects. |

- The engine works with no change, through JSON-RPC.
- The renderer, the lens logic and the panel are new code for each IDE.
- Neovim, Zed and Sublime Text do not have better methods to draw than VS Code.

- **Result:** many effects in a real editor.
- **Risk:** each IDE needs its own code, and each change of DataFlow needs work in each IDE.
- **Size:** large for each IDE.

## 5. Summary of the options

| Option | Text editor of VS Code | Effects | Status of the API | Size |
| --- | --- | --- | --- | --- |
| A: CSS through decorations | Yes | Many | Not in the API reference | Small |
| B: Editor insets | Yes | Many, in the inset | Proposal | Medium |
| C: Calm overlays | Yes | Few | Stable | Small |
| D: Side view | Yes, with a second view | All | Stable | Medium to large |
| E: Qt viewer | No, a separate window | All | No VS Code API | Large |
| F: HTML review page | No | All | No VS Code API | Medium |
| G: Different IDE | No, the editor of the IDE | Many | Stable in the IDE | Large for each IDE |

## 6. Recommendation

1. Find the effect that fails, and how it fails. For example, the rails are too narrow, or the path walk is not smooth.
2. Do a spike of option A first. Its size is small, and the screenshot scripts in `spikes/` can find a failure after an update of VS Code.
3. Keep the current renderer as a setting.
4. If DataFlow must use only the behavior in the API reference, use option D. It uses only the stable API.
5. For P5, decide where Change Ripple shows its main view: in a side view, or in an HTML review page. The wave in the editor is the weakest effect, and reviews can occur on GitHub.
6. If VS Code stays the main host of DataFlow, do not use option G. It makes the project much larger, and the effects are only a small part of the value.

## 7. Open questions

| Question | Effect on the choice |
| --- | --- |
| Which effect is not good enough, and why? | The answer selects option A, C or D. |
| Does the team do reviews in VS Code or in a web tool? | The answer selects option D or F for Change Ripple. |
| Must DataFlow go on the Marketplace? | If yes, option B is not possible, and option A is a larger risk. |

## 8. Facts from the code of VS Code 1.143.1

The facts come from the test build in `.vscode-test/vscode-win32-x64-archive-1.143.1/`. The paths start at `resources/app/out/` in the folder of the build.

| Fact | File | Effect on the options |
| --- | --- | --- |
| `collectCSSText` puts each value into a format string, for example `text-decoration:{0};` for `textDecoration`. It does not escape the value. | `vs/workbench/workbench.desktop.main.js` | Option A works in this version. |
| The CSS of the attachments `before` and `after` also contains `textDecoration`. | `vs/workbench/workbench.desktop.main.js` | An attachment can have any position and size. |
| Each theme color is a CSS variable. For example, the color `dataflow.read` is `--vscode-dataflow-read`. | `vs/workbench/workbench.desktop.main.js` | The CSS of option A can use the theme colors of DataFlow. |
| `createWebviewTextEditorInset` needs the proposal `editorInsets`. | `vs/workbench/api/node/extensionHostProcess.js` | Option B is available in this version. |
| On a build with the quality `stable`, the Extension Development Host does not turn on proposed APIs. The switch `--enable-proposed-api` turns them on. | `vs/workbench/workbench.desktop.main.js` | Option B needs the switch in the debug configuration. |
| `argv.json` accepts the key `enable-proposed-api`. | `mainImpl.js` | A user can turn on option B for one installation. |
