# S2 notes

- Date: 27 October 2026
- Status: phase S2 of the side view is complete. Acceptance scenario 1 passes in the side view. The user decided to continue with phase S3.
- Plan: [side-view-strategy.md](side-view-strategy.md), section 7
- Open issues: [TODO.md](../TODO.md)

## Result

With `dataflow.view` set to `side`, Flow Lens shows its data in the side view. The text editor shows no marks, no rails and no function scope of DataFlow. A trace from the editor and the switch of Flow Lens open the side view.

| Exit criterion | Result |
| --- | --- |
| Acceptance scenario 1 passes in the side view. | Passed. A trace of `bestFit` in `initial_power()` marks line 46 as an unchecked optional access. The rail of the definition on line 41 goes to line 46, and its last part is red and dashed. The fixture test checks the model. The snapshot script checks the screen. |
| The user compares the side view with the rails in the gutter and decides to continue or to stop. | The user decided to continue with phase S3 on 27 October 2026. The screenshot `dark-flow-compare.png` of the snapshot script shows the two views of the same trace. |

| Check | Result |
| --- | --- |
| Unit tests | 49 passed, 14 of them for the side view |
| Fixture tests of P1 to P4 and of the side view | 23 passed, 10 of them for the side view |
| qmake fixture and review fixture | 4 passed |
| Engine protocol tests | 17 passed. A new test checks the rule for the variables of macros. The flow test also checks `hasCfg`. |

## What the side view shows

- **Rails:** one rail for each definition and each write that reaches a use. The rails are at the left of the code, after the line numbers. A rail has round corners at its ends, and a dot on each line with a reference. The definition gets a large dot. A possible write gets a ring. The part of a rail to a use with a problem is red and dashed.
- **Columns:** rails that do not share a line share a column. The number of columns has no limit.
- **Pulse:** when a trace starts, a dot moves down each rail. It takes a maximum of 650 ms for each rail, and a maximum of 80 ms for each line.
- **Marks:** each reference gets a box in the color of its role. A definition and a write also get bold text. A possible write gets a dashed box. A reference with a problem gets a red dashed box and a red background.
- **Guide lines:** a line goes from the dot on the rail to the first reference of the line. It goes down from the dot to the bottom edge of the boxes, then along this edge below the text. If the reference is to the right of the visible area, the line goes to the right edge of the side view.
- **Dimmed lines:** during a trace, the code of the lines without a reference of the variable has 60 % opacity. The rails keep the full opacity.
- **Hints:** a line with a problem gets a hint at the end, for example "bestFit: optional not checked here".
- **Hover card:** when the mouse is on a mark, a card shows the variable, the role and the line. For a use, it shows the lines of the definitions that reach the use. For a definition, it shows the lines of the uses that it reaches. It also shows the problem.
- **Curves:** with the hover card, a curve connects the mark with each definition or use in the card.
- **Flow bar:** under the toolbar. It has the variables of the function, the problems as red buttons, **Follow the cursor** and **Clear**. If two variables have the same name, the button also shows the line of the declaration, for example `result:16`. A click on a problem shows its line.
- **Details column:** the variable, its type and storage, the counts of the roles, the problems, the list of the references and the variables. A click on a reference shows its line. The **Details** button opens and closes the column.
- **Compact mode:** in a side view that is narrower than 640 pixels, the details column is closed at the start. When the user opens it, it shows over the code. Escape closes it.
- **Clicks:** when Flow Lens is on, a click on a mark or on a variable traces the variable, and moves the cursor of the text editor to it. A click on other text moves the cursor only.
- **No control flow graph:** if Clang makes no graph for the function, the side view shows the marks and a notice, but no rails.
- **Motion:** the pulse, the curves and the change to the dimmed lines have no animation if `dataflow.animations` is `off` or `workbench.reduceMotion` is `on`. The webview also obeys `prefers-reduced-motion`.

## Contents of S2

### Engine

| File | Change |
| --- | --- |
| `flow.hpp` | The result has `hasCfg`. It is false if `CFG::buildCFG` gives no graph. The new function `Detail::drop_macro_vars` removes the variables that have no reference in the text of the main file. It runs before the role analysis. |

### Extension

| File | Function |
| --- | --- |
| `lenses/flow.ts` | The flow view gets the edges as indexes of the marks, and `hasCfg`. |
| `engine/client.ts` | `FlowModel` gets `hasCfg`. |
| `state/store.ts` | `TraceState` gets `pulse`, a counter. A new value starts the pulse in the side view. |
| `side/flowLayer.ts` | New. Makes the layer of Flow Lens for the webview: the marks with the lines that they come from and go to, the rails with their columns, the problems and the variables. |
| `side/protocol.d.ts` | The message `flow`, the types of the layer, and the actions of the side view: trace, trace a variable, clear, follow, switch a lens, select a line, and show a line |
| `side/controller.ts` | Sends the layer when the trace changes. Sends the actions of the side view to the extension. Sends the style indices of the variables and the parameters, because a click on them traces them. Only the newest load of the theme styles sends its styles. |
| `extension.ts` | In the side mode, no overlays of Flow Lens and no function scope in the editor. The actions of the side view, the pulse counter, and a change of `dataflow.view` while the extension runs. |
| `webview-side/flow.tsx` | New. The rails, the pulse, the marks, the guide lines, the hints, the hover card, the curves, the variable buttons and the details column |
| `webview-side/CodeView.tsx` | The layer in the rows, the dimmed lines, the hover, the click trace, and the positions of the marks for the curves. A hidden row gives the bottom edge of a mark for the guide lines. |
| `webview-side/main.tsx` | The switch of Flow Lens, the Flow bar, the **Details** button and the compact mode |
| `webview-side/styles.ts` | The styles of the layer, the rules for motion, and the details column over the code |

### Tests and tools

- `src/test/unit/side.test.ts`: the lines that each mark comes from and goes to, the problem part of a rail, and the columns of rails that share lines
- `src/test/fixtures/side.test.ts`: scenario 1 in the side view with no overlay in the editor, the click trace of `startPlans`, the switch of the lens, and the change back to the editor mode
- `test/engine/protocol.test.mjs`: the rule for the variables of macros, with a header of macros in a temporary folder, and `hasCfg`
- `spikes/ui/side-flow-snapshot.mjs`: screenshots of the trace, the pulse, the hover card, the click trace and the details column. The last screenshot shows the rails in the gutter and the side view with the same trace. With a workspace, a file and a position, the script makes one screenshot of that trace.

## Numbers

| Measurement | Result |
| --- | --- |
| Flow of the first Catch2 test case of TBT `tests.cpp` | Before S2: about 130 references, and the variables of the Catch2 macros in the variable list. 1359 ms for the first analysis, then 485 ms. After S2: 16 variables and 79 references. 1148 ms for the first analysis, then 273 ms. |
| Size of the script of the side view | 67 KB |

## Changes from the strategy

- **Columns of the rails:** the strategy said that the side view needs no assignment of slots. The side view uses the assignment of the overlay, with no limit. Rails that do not share a line share a column, so the rails use less width.
- **Problems in the Flow bar:** the strategy hides the details column in a narrow side view. So the Flow bar also shows the problems. The details column shows over the code when the user opens it.
- **Variables of macros:** the strategy did not have this change. The variables of the Catch2 macros filled the Flow bar of the TBT test cases. This was an open issue since P2.
- **No control flow graph:** the strategy did not have this case. For TBT `compute_size_static`, Clang makes no graph. Before S2, the result had no edges and gave no reason. Now the result has `hasCfg`, and the side view shows a notice.
- **Line of a variable:** in a Catch2 test case, each section can declare a variable with the same name. The buttons of these variables show the line of the declaration.
- **Requests of the user after a test on TBT:** each reference gets a full box, not only the definition. The lines without the variable are dimmed. A guide line goes from the rail to the reference, because the eye must find the reference on a long line.

## Fix of S1

With a new profile, VS Code starts with a dark default theme, then it changes to the theme of the settings. Each change started a load of the theme styles. The two loads ran at the same time, and the older load could end last. Then the side view showed the token colors of `Dark 2026` in Light Modern. In 4 of 8 starts with a new profile, the older load ended last. Now only the newest load sends its styles. After this fix, 2 starts had the overlap, and the side view had the colors of Light Modern.

## Limits

[TODO.md](../TODO.md) has the open issues. The most important for Flow Lens in the side view:

- A function template with a range-based `for` loop on a dependent range has no rails, because Clang makes no control flow graph for it.
- The hover card needs a mouse. The details column has the same data, and its buttons work with the keyboard.
- No automatic test reads the DOM of the webview. The snapshot script checks the layer.
- The toolbar shows the internal names of Catch2 test cases, for example `CATCH2_INTERNAL_TEST_0`.

## How to do the tests

1. Type `npm test`. The configuration `cmake` contains the tests of the side view.
2. Type `npm run test:engine`.
3. For screenshots, type `node spikes/ui/side-flow-snapshot.mjs <folder> dark`. The theme can be `dark`, `light`, `hc` or `hclight`. You can also give a workspace folder, a file and a position, for example `C:/Projects/TBT C:/Projects/TBT/tests/src/tests.cpp 16:16`.

## Next step

The user compared the side view with the rails in the gutter and decided to continue. Phase S3 moves Logic Map into the side view. [s3-notes.md](s3-notes.md) gives the result.
