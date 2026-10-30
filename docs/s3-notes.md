# S3 notes

- Date: 27 October 2026
- Status: phase S3 of the side view is complete. Acceptance scenario 2 passes in the side view.
- Plan: [side-view-strategy.md](side-view-strategy.md), section 7
- Open issues: [TODO.md](../TODO.md)

## Result

With `dataflow.view` set to `side`, Logic Map shows its data in the side view. The text editor shows no dimmed lines, no boxes and no hints of Logic Map. The switch of Logic Map and the command **DataFlow: Why Does This Line Run** open the side view.

After phase S2, the user compared the side view with the rails in the gutter and decided to continue with phase S3.

Logic Map in the side view is the Logic Map of the prototype in the design study. It shows one path through the function. Each decision has an option: the choice of the user, or a default option. The default option is the option that runs the most lines, so the default path goes past the early returns and into the bodies of the decisions. A path panel tells the path as a trail of steps, with the events, the returned values and the warnings. **Play path** goes through the steps and shows each step in the code.

The first version of phase S3 had "any" for each decision, as the sidebar view. Then nothing was dimmed, and the user had to select many values before the side view showed a path. The user tried this version on TBT, found it not useful, and asked for the Logic Map of the prototype.

| Exit criterion | Result |
| --- | --- |
| Acceptance scenario 2 passes in the side view. | Passed. In `process()` of the fixture, the choices `HOMEPOWER_METER_READING`, new readings found and timeout give the events `_measured` and `_timeout` and the warning for two events on one path. The choices `HOMEPOWER_CHARGE_PLANNING`, converged and `POWER_AUTO` give the warning for the null pointer on line 109. The default path of `process()` is the path of the second part, so the side view shows this warning at once. The fixture test sets the choices with the actions of the side view and checks the model. The snapshot script sets them in the trail and checks the screen. |

| Check | Result |
| --- | --- |
| Unit tests | 53 passed. 16 are for the side view and 2 are new for the default path and the steps of the path. |
| Fixture tests of P1 to P4 and of the side view | 28 passed, 15 of them for the side view. The tests of P3 in the editor mode also pass with the default path. |
| qmake fixture and review fixture | 4 passed |
| Engine protocol tests | 17 passed. The test of `dataflow/logic` also checks the return statements. |

## What the side view shows

- **One path:** each decision has an option. A decision with no choice of the user gets the option that runs the most lines. With equal lines, the first option wins, for example "yes" or "enter". **Reset** removes the choices of the user, so all decisions get their default options again.
- **Dimmed lines:** the code of the lines that the path cannot reach has 35 % opacity. During a trace of Flow Lens, the lines without the variable have 60 % opacity.
- **Boxes and hints:** an event on the path gets a box. A dereference of a pointer that can be null gets a red dashed box with a red background, and a hint at the end of its line. A second event on the path gets a hint, for example "second event on this path, after _measured (line 143)".
- **End of a long line:** the hints stay at the right edge of the side view, over the code. They use a maximum of 35 % of the width of the side view. A hint that is too long ends with an ellipsis, and its title has the full text. This also applies to the hints of Flow Lens.
- **Path panel:** the tab of Logic Map in the details column. It has the title "Path through process()", the number of lines that cannot run, **Play path** and **Reset**. Then it shows the summary of the path: the events in their sequence, and the returned values. A warning shows as a red callout with its full text.
- **Trail:** one row for each step of the path, on a vertical line. A diamond is a decision, with its condition, its line and its options. A full diamond and a full option show a choice of the user. An outlined option is the default option. A switch or an else-if chain with more than 3 options gets a list. A dot is an event, a red dot is a warning or an event with a problem, and a square is a return or the end of the function. A click on a step shows its line in the text editor. When the mouse is on a step, the code view marks its line.
- **Play path:** goes through the steps, one step each 650 ms, as in the prototype. A dot moves down the trail to the current step. The code view marks the line of the step, and it scrolls the line into view. The text editor follows the scroll. **Stop** ends the play. A new path ends it too.
- **Why does this line run:** when the mouse stays on the line number of a line of the function, a card shows the decisions and the values that the line needs. The button **Use these choices** sets these values. The path panel shows the same for the line of the cursor.
- **Logic bar:** under the toolbar. It has the number of lines that cannot run, the events of the path, the warnings as red buttons, **Play path** and **Reset**. With more than 4 events, the bar shows the number of events. It shows a maximum of 2 warnings. A click on an event or a warning shows its line.
- **Details column:** a tab for each lens that is on. When a lens turns on, the column shows its tab.
- **No control flow graph:** if Clang makes no graph for the function, the bar shows a notice, and the path panel shows no trail.
- **Motion:** the change to the dimmed lines and the dot of the trail have no animation if `dataflow.animations` is `off` or `workbench.reduceMotion` is `on`. The webview also obeys `prefers-reduced-motion`. Without animations, the side view has no button **Play path**. A click on a step of the trail still shows its line.

## Contents of S3

### Engine

| File | Change |
| --- | --- |
| `logic.hpp` | The result of `dataflow/logic` has `returns`: each `return` and `co_return` statement with its block, the position of the keyword and the text of the returned value |

### Extension

| File | Change |
| --- | --- |
| `logic/paths.ts` | `pathChoices`: the option of each decision, from the choices of the user and the default options. `pathSteps`: the steps of the path in the sequence of the source. |
| `side/logicLayer.ts` | New. Makes the layer of Logic Map for the webview from the path state and the outline. |
| `side/protocol.d.ts` | The message `logic`, the answer `why`, the message `details`, the types of the layer and of the steps, and the actions of Logic Map: set a choice, reset, ask why a line runs, and use the choices of a line. The frame gets the lens that turned on last. |
| `side/controller.ts` | Sends the layer when the outline or the path changes. Sends the actions of Logic Map to the extension. Sends the answers to the question why a line runs. Opens the details column, also in a side view that opens now. |
| `state/store.ts` | `LogicPathState`: the view of the path, the steps, the choices of the user, the function and `hasCfg`. `lastLens`: the lens that turned on last. |
| `engine/client.ts`, `lenses/logic.ts` | The returns of the engine. Each warning gets a short text for the Logic bar. |
| `extension.ts` | The path of Logic Map uses the default options. In the side mode, no overlays of Logic Map in the editor. The actions of the side view, why a line of the function runs, and **Why Does This Line Run** opens the side view. The line of the cursor comes from the editor of the last change of the cursor, also when the focus is in the side view. |
| `package.json` | The theme color `dataflow.pathLine` for the trail, the diamonds and the options of the path |

### Webview

| File | Change |
| --- | --- |
| `webview-side/logic.tsx` | New. The boxes, the hints, the Logic bar, the path panel with the summary and the trail, **Play path**, and the card "Why does this line run" |
| `webview-side/CodeView.tsx` | The layer of Logic Map in the rows: the dimmed lines, the boxes that contain the token spans, the end of the row, the line of the current step, the scroll to a step, and the card of a line number |
| `webview-side/flow.tsx` | The rails of a row are a part of the lane of the row. |
| `webview-side/main.tsx` | The switch of Logic Map, the Logic bar, the tabs of the details column, and the state of **Play path** |
| `webview-side/styles.ts` | The styles of the layer, the end of a long line, the path panel and the tabs |

### Tests and tools

- `src/test/unit/paths.test.ts`: the default path of a function with an else-if chain and an early return, and the steps of the path
- `src/test/unit/side.test.ts`: the layer with the steps of the path, the choices of the user and the default options
- `src/test/fixtures/side.test.ts`: the default path of `process()`, the two parts of scenario 2 in the side view with no overlay in the editor, the answer for a line number and its choices, and the switch of the lens
- `test/engine/protocol.test.mjs`: the return statements of `process()`
- `spikes/ui/side-logic-snapshot.mjs`: screenshots of the default path, of the two parts of scenario 2, of the frames of **Play path**, of the card of a line number, and of Flow Lens and Logic Map together. The script closes the Explorer, so the side view has space for the path panel. With a workspace, a file and a line, the script turns on Logic Map in the function of the line and makes one screenshot.

## Checks on the screen

| Check | Result |
| --- | --- |
| Fixture, dark and light theme | The default path, the dimmed lines, the boxes, the hints, the summary, the callout, the trail, **Play path** and the card are correct. |
| Play path on the fixture | The current step and the marked line move together: lines 89, 94, 100, 141, 143 and 146. After the last step, the marks go away. |
| Flow Lens and Logic Map together | The lane has the rail of `cur_tariff_plan`. The box of the dereference on line 109 contains the mark of Flow Lens. |
| TBT `execute_task` in `execute.hpp` | The default path goes through 9 decisions to `return BUSY` on line 540. 262 lines cannot run. For the line of the cursor in the coroutine branch, the path panel shows the 2 choices that the line needs. |
| TBT `compute_size_static` in `compiler.hpp` | Clang makes no control flow graph. The bar shows the notice. |

## Numbers

| Measurement | Result |
| --- | --- |
| Size of the script of the side view | 93 KB. It was 67 KB after phase S2. |
| Render of the visible rows of a file of 2,400 lines | A maximum of 4.1 ms in four test runs. The budget is 100 ms. |

## Changes from the strategy

- **One path:** the strategy and P3 have the option "any" for each decision. The side view shows one path, as the prototype. Each decision has an option, and the default option runs the most lines. The sidebar view in the editor mode also shows the default options now.
- **Path timeline:** the strategy put the path timeline in a column at the right of the code. The side view shows it as a trail in the path panel, as the prototype. The first version of phase S3 had a path line at the left of the code and a chip at the end of each decision line. The trail replaces them.
- **Walk:** the strategy has a smooth walk of the lines. The side view has **Play path**, as the prototype: one step after the other, with the line of each step in the code. **Play path** does not start by itself after a new choice, because it scrolls the side view and the text editor.
- **Decision outline:** the strategy put the outline of all decisions in the details column. The trail shows only the decisions on the path. A decision that the path does not get to cannot change the path.
- **Returns:** the strategy did not have them. The engine now gives the return statements, so the summary and the trail show the returned value.
- **End of a long line:** in a narrow side view, the hints of long lines were outside of the visible area. So the end of a row stays at the right edge. The overlays had the same problem: the hints stopped at the edge of the window.
- **Details column:** the strategy did not say how the details of two lenses share the column. The column has a tab for each lens that is on.
- **No control flow graph:** the strategy did not have this case for Logic Map. Flow Lens shows a notice since phase S2. Logic Map now shows a notice too.
- **Theme color:** the new theme color `dataflow.pathLine` has the hue of the background `dataflow.path`. The side view uses `dataflow.path` for the line of the current step.

## Limits

[TODO.md](../TODO.md) has the open issues. The most important for Logic Map in the side view:

- The default path is a heuristic. The path with the most lines is not always the normal path of the function.
- The summary has no side effects, and the trail has no actions. The prototype had them as text that a person wrote.
- The card "Why does this line run" needs a mouse. The path panel shows why the line of the cursor runs, and its button works with the keyboard.
- On a long line, the end of the row covers the code at the right edge. A scroll to the right shows the code.
- No automatic test reads the DOM of the webview. The snapshot script checks the layer.
- With Flow Lens and Logic Map on, the side view has two bars of controls under the toolbar.

## How to do the tests

1. Type `npm test`. The configuration `cmake` contains the tests of the side view.
2. Type `npm run test:engine`.
3. For screenshots, type `node spikes/ui/side-logic-snapshot.mjs <folder> dark`. The theme can be `dark`, `light`, `hc` or `hclight`. You can also give a workspace folder, a file and a line, for example `C:/Projects/TBT C:/Projects/TBT/include/TBT/execute.hpp 598`.

## Next step

Phase S4 moves Hidden C++ into the side view. The exit criterion is acceptance scenario 3 in the side view.
