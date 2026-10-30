# S1 notes

- Date: 27 October 2026
- Status: phase S1 of the side view is complete. The three exit criteria passed.
- Plan: [side-view-strategy.md](side-view-strategy.md), section 7
- Open issues: [TODO.md](../TODO.md)

## Result

The command **DataFlow: Open Side View** opens the side view beside the C++ editor. The side view shows the full file with the syntax colors of the active color theme, the indent guides and the colors of the bracket pairs. The text editor and the side view scroll together in both directions. A click on a line of the side view moves the cursor of the text editor. After a reload of the window, the side view comes back with its file.

| Exit criterion | Result |
| --- | --- |
| The code of the fixture and of TBT looks like the text editor in a dark, a light and a high contrast theme. | Passed. Screenshots of the fixture in Dark Modern, Light Modern, Dark High Contrast and Light High Contrast. Screenshots of TBT `compiler.hpp` in Dark Modern, and of TBT `execute.hpp` in Light Modern and in Dark High Contrast. |
| The two views scroll together with no jumps. | Passed. After a scroll of the text editor and after a scroll of the side view, the two views have the same first line, also with sticky scroll. |
| The side view renders the visible rows of a file of 2,000 lines in less than 100 ms. | Passed. In two test runs, 2.8 ms and 3.8 ms for the rows of a file of 2,402 lines with the text of the editor. 1.1 ms for the rows with the tokens of the engine. |

| Check | Result |
| --- | --- |
| Unit tests | 47 passed, 12 of them for the side view |
| Fixture tests of P1 to P4 and of the side view | 19 passed, 6 of them for the side view |
| qmake fixture and review fixture | 4 passed |
| Engine protocol tests | 16 passed, 2 of them for `dataflow/tokens` |

The test build of VS Code has no C++ extension, so its text editor shows only the colors of the grammar. The side view shows the semantic colors of the theme, for example the variable color for each variable. With the C/C++ extension, the text editor also shows semantic colors.

## What the side view shows

- **Text:** the side view first shows the text of the editor with no colors. When the tokens of the engine come, it shows the text that the engine parsed, with colors.
- **Colors:** the engine gives the kind of each token. The extension finds the color of each kind in the color theme, with the rules of VS Code. First, it tries the semantic token colors of the theme. Then it tries the defaults of VS Code for semantic tokens. Then it tries the TextMate scopes of the C++ grammar. A theme with no semantic highlighting gets only the colors of the grammar, as in the text editor.
- **Indent guides:** the rules of the text editor, also the active guide of the block of the cursor. The colors come from the theme colors `editorIndentGuide.background1` to `background6`.
- **Bracket pairs:** each level of nesting gets the next bracket color of the theme that is not transparent, as in the text editor. A closing bracket that does not close the last open bracket gets the color for unexpected brackets.
- **Line of the cursor:** the background and the border of the line highlight of the theme.
- **Toolbar:** the file and the function at the cursor.
- **Status line:** the state of the engine, the parse time, the number of parse errors and the compile databases. Three buttons: select the compile database, show the log, and restart the engine.

## Contents of S1

### Engine

| File | Change |
| --- | --- |
| `tokens.hpp` | New. The raw lexer of Clang gives the tokens and the preprocessor lines. An AST visitor gives the kind of each name. A dependent name in a template gets its kind from its use. A name in the body of a macro of the same file gets the kind of the expanded code. A bracket gets its level of nesting. |
| `tu_cache.hpp` | Each cache entry keeps the tokens of its last parse. |
| `server.hpp` | The request `dataflow/tokens`. The new function `post_entry_request` gives the cache entry to a request. `post_file_request` uses it. |

### Extension

| File | Function |
| --- | --- |
| `side/controller.ts` | The webview panel, the restore after a reload, the rows of the file, the scroll sync, the cursor sync and the status |
| `side/model.ts` | The style index of each token, and the conversion of the UTF-8 columns of the engine to UTF-16 columns |
| `side/themeRules.ts` | The rules of VS Code for the colors of a token: scope selectors, semantic selectors, defaults and user settings |
| `side/theme.ts` | Finds the active theme, reads its files and the user settings, and watches for changes |
| `side/guides.ts` | The indent guides and the active guide, with the rules of the text editor |
| `side/sync.ts` | The guard against echoes of the scroll sync, and the line height and the ligatures of the text editor |
| `side/protocol.d.ts` | The messages between the extension and the webview |
| `webview-side/` | The Preact code view with virtual rows, the toolbar and the status line |
| `statusbar.ts` | With `dataflow.view` set to `side`, a click opens the side view. |
| `package.json` | The command **DataFlow: Open Side View**, a button in the title bar of a C++ editor, the setting `dataflow.view` and the activation event of the restore |

With `dataflow.view` set to `side`, the side view also opens when a lens turns on, when a trace starts and when a review starts. The default is `editor`. The overlays in the text editor stay until the lenses move into the side view in the phases S2 to S5.

### Tests and tools

- `src/test/unit/side.test.ts`: the rows, the theme rules, the scroll guard, the editor settings and the indent guides
- `src/test/fixtures/side.test.ts`: the rows and their kinds, the theme colors, the scroll sync in both directions with no echo, the click on a line, and the time of a render for a generated file of 2,402 lines. The file is in the build folder of the fixture, and git ignores it.
- `test/engine/protocol.test.mjs`: the kinds of the fixture, the cache, a range of lines, a block comment, dependent names, an instantiated template and the levels of brackets
- `spikes/ui/side-snapshot.mjs`: screenshots in four themes, the first lines of the two views after each scroll, and the restore after a reload of the window

## Numbers

| Measurement | Result |
| --- | --- |
| Tokens of the fixture: 210 lines, 1,473 tokens | 2.9 ms in the engine. 0.4 ms for all lines from the cache. 29 KB of JSON. |
| Tokens of TBT `tests.cpp`: 1,199 lines, 8,987 tokens | 28.7 ms in the engine. 3.1 ms from the cache. 164 KB of JSON. |
| Tokens of TBT `compiler.hpp`: 695 lines, 5,433 tokens | 22.0 ms in the engine. 1.3 ms from the cache. 112 KB of JSON. |
| Names with no kind in TBT `compiler.hpp` | 394 of 2,588 before the rules for dependent names and macro bodies. 5 after them. |
| Names with no kind in TBT `execute.hpp` and `tests.cpp` | 46 and 39 before the rules. 5 and 5 after them. |
| Render of the visible rows, file of 2,402 lines | 2.8 ms to 3.8 ms with the text of the editor, then 1.1 ms with the tokens |

## Changes from the strategy

- **Token format:** each token is 4 numbers, with a legend for the names of the kinds and of the modifier bits. Objects with names gave 3 to 4 times more JSON.
- **Kinds and modifiers:** the names are the semantic token types and modifiers of VS Code. So the theme rules of VS Code apply with no conversion. The strategy had local, static and global variables, and the modifiers `const` and `member`. The color themes do not use these names.
- **Indent guides and bracket colors:** the strategy did not have them. Without them, the side view did not look like the text editor.
- **Template instantiations:** the AST unit also gives the instantiations of function templates as top-level declarations. A `consteval` instantiation comes before the namespace that contains the template. An `operator[]` in the instantiation then gave the wrong kind to a variable. The token request skips all instantiations. This is also the cause of the open issue about functions that `dataflow/functions` lists more than one time.
- **Sticky scroll:** when the text editor shows a line at the top, it keeps some lines above the line: the maximum number of sticky lines, or `editor.cursorSurroundingLines`. The side view asks for the line under these lines. So the first line of the text editor is the first line of the side view.
- **Theme ids:** VS Code changes the old ids of the default themes, for example `Default Dark Modern` to `Dark Modern`. DataFlow does the same before it searches for the theme.
- **Styles:** the content security policy of the webview allows no inline styles. The webview makes its styles with constructable stylesheets. The colors of the guides and of the brackets come from the CSS variables of VS Code in the webview. VS Code changes only the first dot of a color id to a dash in the name of the variable, for example `--vscode-editorBracketHighlight-unexpectedBracket.foreground`.

## Limits

[TODO.md](../TODO.md) has the open issues of the side view. The most important:

- A block in an inactive `#if` branch has the colors of active code.
- With sticky scroll, the side view shows the lines under the sticky lines of the text editor at its top.
- During an edit, the side view shows the old text until the next parse.

## How to do the tests

1. Type `npm test`. The configuration `cmake` contains the tests of the side view.
2. Type `npm run test:engine`.
3. For screenshots, type `node spikes/ui/side-snapshot.mjs <folder> dark`. The theme can be `dark`, `light`, `hc` or `hclight`. You can also give a workspace folder, a file and a line, for example of the TBT repository.

## Next phase

S2: the layer of Flow Lens in the side view and its hover cards. After S2, the user compares the side view with the rails in the gutter and decides to continue or to stop.
