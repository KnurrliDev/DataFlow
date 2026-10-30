# S4 notes

- Date: 27 October 2026
- Status: phase S4 of the side view is complete. Acceptance scenario 3 passes in the side view.
- Plan: [side-view-strategy.md](side-view-strategy.md), section 7
- Open issues: [TODO.md](../TODO.md)

## Result

With `dataflow.view` set to `side`, Hidden C++ shows its data in the side view, as the Hidden C++ of the prototype in the design study. The text editor shows no hints of Hidden C++. The switch of Hidden C++ and the command **DataFlow: Toggle Hidden C++** open the side view.

| Exit criterion | Result |
| --- | --- |
| Acceptance scenario 3 passes in the side view. | Passed. In `stable_readings()` of the fixture, the side view marks the static map `last_read`, the copy of `GridStatus` in the argument `state`, the 7 lookups of `tapTopic` with "contains 1, [] 6", and the variable `tags` that hides the `tags` of line 181. The fixture test checks the model, and also the text under each mark. The snapshot script checks the screen. |

| Check | Result |
| --- | --- |
| Unit tests | 55 passed. 2 are new for the marks and the layer of Hidden C++. |
| Fixture tests of P1 to P4 and of the side view | 33 passed, 20 of them for the side view. 4 are new for Hidden C++, and 1 is new for Logic Map: it follows the cursor. The test of follow mode of P2 now has no setting. |
| qmake fixture and review fixture | 4 passed |
| Engine protocol tests | 17 passed. Phase S4 did not change the engine. |

## What the side view shows

- **Marks:** each item gets a line under its code, in the color of its category. For example, the copy of `GridStatus` marks the argument `state`, and the static map marks the name `last_read`. A mark can contain a different mark, for example the copy of `point` in the call of `push_back`. A mark of Flow Lens can be in a mark of Hidden C++.
- **Chips:** a line gets one chip for each category after its code, in the color of the category, as the hints of the editor mode. A chip has the full texts of its items, for example "copy: GridStatus (48 B) · copy: PowerData (128 B)". Equal texts show one time with a count. On a long line, the chips are outside of the visible area until a scroll to the right. The chips do not cover the code.
- **Hover card:** when the mouse is on a mark or on a chip, a card shows the items with their category, their line, their short text and their long text. Each item has the button **Not useful**. The mouse can go into the card.
- **Connector:** the card of a repeated lookup shows a curve from each lookup of the group to the next lookup. The other lookups get the chip "same lookup again (2 of 7)". The card of a group shows above its first lookup, so it does not cover the connector.
- **Hidden C++ bar:** under the toolbar. It has a switch for each category, with its color and the number of items in the file. The number includes the items of a category that is off. A switch writes the setting `dataflow.cost.categories`, as the switches of the sidebar view. If the user marked patterns as not useful, the bar has the button "1 hidden pattern: show them again".
- **Details column:** the tab of Hidden C++ shows the items of the function at the cursor in groups for the categories. Each item has its line, its short text, its long text and **Not useful**. A click on the line shows the line in the text editor.
- **Colors:** the categories have the colors of the prototype. Copies and moves are orange, conversions are red, temporaries, lifetimes and destructors are green, allocations are yellow, repeated lookups are blue, and hidden state is purple. The hints of the editor mode have the same colors now.

## Changes to Flow Lens and Logic Map

The user asked for these changes after a test of Logic Map on TBT:

- **Flow Lens always follows the cursor.** When the cursor stops on a variable for 300 ms, Flow Lens traces it. A position with no variable keeps the trace. The setting `dataflow.flow.followCursor`, the command **DataFlow: Toggle Follow Cursor**, and the buttons **Follow the cursor** of the side view and of the sidebar view are gone.
- **Logic Map follows the cursor.** If the cursor goes to a line that the path cannot reach, Logic Map sets the choices that make the line run, as **Use these choices**. The other choices stay. Logic Map follows each line of the cursor one time. So a choice in the trail stays until the cursor goes to a different line, or until the user clicks a line again. This also applies to the editor mode.
- **The side view marks the steps, and it does not dim the lines.** The lines that the path cannot reach keep their colors. The line of each step of the path gets a light background in the color of the path. The background is the color of the path in the background of the editor, with no alpha. The line of the step of **Play path**, and a step under the mouse in the code or in the trail, get a stronger background. The overlays of the editor mode still dim the lines.

## Contents of S4

### Extension

| File | Change |
| --- | --- |
| `lenses/cost.ts` | `buildCostMarks`: the items with their ranges in UTF-16 columns and the ranges of the other lookups of a group. `costCounts`: the items of each category in the file. The colors of the prototype. |
| `side/costLayer.ts` | New. Makes the layer of Hidden C++ for the webview from the marks, the counts and the panel data. |
| `side/protocol.d.ts` | The message `cost`, the types of the layer, and the actions of Hidden C++: a category switch, not useful, and show the hidden patterns |
| `side/controller.ts` | Sends the layer when the items or the panel data change. Sends the actions of Hidden C++ to the extension. |
| `state/store.ts` | `CostLayerState`: the marks and the counts of the file |
| `extension.ts` | In the side mode, no hints of Hidden C++ in the editor. The actions of the side view. |

### Webview

| File | Change |
| --- | --- |
| `webview-side/cost.tsx` | New. The marks, the chips with their full texts and short texts, the bar, the hover card, the connector of the lookups, and the details of Hidden C++ |
| `webview-side/wraps.ts` | New. The boxes of the lenses in a row, and the sequence that lets a box contain a different box |
| `webview-side/CodeView.tsx` | Boxes in boxes. The chips at the end of the row, with the short texts if the row has not enough space. The hover card and the connector. |
| `webview-side/main.tsx` | The switch of Hidden C++, the bar and the tab of the details column |
| `webview-side/styles.ts` | The colors of the categories, the marks, the chips, the bar, the card and the details |

### Tests and tools

- `src/test/unit/cost.test.ts`: the marks with UTF-16 columns, the other lookups of a group, the counts of the file, and the layer of the side view
- `src/test/fixtures/side.test.ts`: scenario 3 in the side view with no hints in the editor, "Not useful" and "Show them again", a category switch, and the switch of the lens
- `spikes/ui/side-cost-snapshot.mjs`: screenshots of the marks and the chips, of the card of the lookups with the connector, of the card of a chip, of a category switch, of "Not useful", and of Flow Lens and Hidden C++ together. With a workspace, a file and a line, the script turns on Hidden C++ with the cursor on the line and makes one screenshot.
- `spikes/ui/side-logic-snapshot.mjs` and `spikes/ui/side-cost-snapshot.mjs` close the Explorer only if it is open. The profile of the scripts keeps the state of the Explorer, so a toggle opened it again in the next run.

## Checks on the screen

| Check | Result |
| --- | --- |
| Fixture, dark and light theme | The marks, the chips, the bar, the card, the connector and the details are correct. A scroll to the right shows the full chips of the long lines. |
| The card of the lookups | The card shows above line 195. The connector goes from line 195 to line 201. |
| A category switch and "Not useful" | The switch of the copies removes the marks and the chips of the copies. The count of the copies stays. "Not useful" for `GridStatus` removes 1 copy, and "Show them again" shows it again. |
| Flow Lens and Hidden C++ together | A click on `tap_topics` traces it. 2 marks of Flow Lens are in the marks of `reserve` and `push_back`. |
| TBT `tests.cpp` | 144 items in the file. The first test case shows the destructor of `result` after the closing brace of its section. |

## Numbers

| Measurement | Result |
| --- | --- |
| Size of the script of the side view | 107 KB. It was 93 KB after phase S3. |
| Render of the visible rows of a file of 2,400 lines | A maximum of 4.4 ms in four test runs. The budget is 100 ms. |

## Changes from the strategy

- **Marks:** the strategy has only chips at the end of the lines. As in the prototype, each item also gets a mark on its code. A line with 4 copies shows which argument each copy is.
- **Chips after the code:** the first version of phase S4 put the chips at the right edge of the side view, over the code, as the hints of Flow Lens and Logic Map. In a narrow side view, the chips covered most of the code of their lines. Then the chips got short texts, for example "copy ×4". The user asked for the full texts of the editor mode, so the chips are after the code now.
- **Category switches:** the strategy put them in the toolbar. They are in a bar under the toolbar, as the controls of Flow Lens and Logic Map.
- **Colors:** the categories have the colors of the prototype, also in the editor mode.

## Limits

[TODO.md](../TODO.md) has the open issues. The most important for Hidden C++ in the side view:

- The hover card needs a mouse. The details column has the same data, and its buttons work with the keyboard.
- On a long line, the chips are outside of the visible area until a scroll to the right, as in the editor mode. The marks show the items, and the hover card has the texts.
- With all lenses on, the side view has three bars of controls under the toolbar.
- The details column shows the internal names of Catch2 test cases, for example `CATCH2_INTERNAL_TEST_0`.

## How to do the tests

1. Type `npm test`. The configuration `cmake` contains the tests of the side view.
2. Type `npm run test:engine`.
3. For screenshots, type `node spikes/ui/side-cost-snapshot.mjs <folder> dark`. The theme can be `dark`, `light`, `hc` or `hclight`. You can also give a workspace folder, a file and a line, for example `C:/Projects/TBT C:/Projects/TBT/tests/src/tests.cpp 16`.

## Next step

Phase S5 moves Change Ripple into the side view, as a story of each change. The exit criterion is acceptance scenario 4 in the side view.
