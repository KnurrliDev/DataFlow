# S6 notes

- Date: 27 October 2026
- Status: phase S6 of the side view is complete. The side view is the only view of DataFlow.
- Plan: [side-view-strategy.md](side-view-strategy.md), sections 6 and 7
- Open issues: [TODO.md](../TODO.md)

## Result

The overlays in the text editor, the DataFlow view in the sidebar and the setting `dataflow.view` are gone. A lens that turns on opens the side view, and the text editor shows no decorations of DataFlow.

| Exit criterion | Result |
| --- | --- |
| All tests pass with the side view. | Passed. The tests read the model of the side view and the state of the extension. No test reads an overlay or the sidebar view. |
| The overlay renderer and the sidebar view are gone. | Passed. `render/overlay.ts`, `render/rails.ts`, `panel/provider.ts`, `panel/protocol.d.ts` and `webview/panel.ts` are deleted. |

| Check | Result |
| --- | --- |
| Unit tests | 53 passed |
| Fixture tests of the CMake fixture | 25 passed: the P1 exit check, the tests of Flow Lens, and the tests of the side view with acceptance scenarios 1 to 3 |
| qmake fixture and review fixture | 8 passed: 1 for qmake, 3 for the model of Change Ripple and 4 for the story |
| Engine protocol tests | 17 passed. Phase S6 did not change the engine. |

## What changed for the user

- **One view:** Flow Lens, Logic Map, Hidden C++ and Change Ripple show their data only in the side view. A trace with Ctrl+Alt+F, the commands of the lenses, a review and the switches of the side view open the side view.
- **No DataFlow view in the sidebar:** the container of DataFlow in the activity bar and the command **DataFlow: Show Panel** are gone. The status bar item and the button in the title bar of a C++ editor open the side view.
- **No marks in the text editor:** the rails in the gutter, the dimmed lines, the walk of the path, the hints at the ends of the lines and the wave of Change Ripple are gone. The scope rail of the function at the cursor is gone too. The toolbar of the side view shows the function at the cursor.
- **Settings:** `dataflow.view` and `dataflow.showFunctionScope` are gone. `dataflow.animations` now applies to the side view.
- **Theme colors:** `dataflow.ripple`, `dataflow.rippleEstimated` and `dataflow.rippleWave` are gone. The side view makes the colors of the ripple from `dataflow.event`.
- **Logic Map:** the outline of all decisions in the sidebar view is gone. The trail of the path panel shows the decisions of the path, as since phase S3.
- **Change Ripple:** the list of the changes in the sidebar view is gone. The story shows each change, as since phase S5.
- **P0 spike:** the command **DataFlow: Spike: Gutter Animation** and its code are gone. It tested the icons in the gutter for the overlays.

## Contents of S6

### Extension

| File | Change |
| --- | --- |
| `extension.ts` | No overlay renderer and no sidebar view. The side view opens when a lens turns on. The handler of the setting `dataflow.view` and the scope rail are gone. The test API has the store and the side view. |
| `state/store.ts` | The data of the sidebar view are gone. The layer states have the data that the side view needs: the warnings and the why-list of Logic Map, the switches and the items of the function of Hidden C++. `review` has only the state of the review. |
| `lenses/logic.ts` | `logicWarnings` replaces the outline of the sidebar view. The lines of the path walk are gone. |
| `lenses/cost.ts` | `functionItems` gives the items of the function at the cursor. The hints of the editor and the colors of the overlay are gone. |
| `lenses/ripple.ts` | `buildReviewState` replaces the data of the sidebar view. |
| `side/logicLayer.ts`, `side/costLayer.ts`, `side/storyLayer.ts`, `side/controller.ts` | The layers take only their layer states. The controller gives its frame to the tests. |
| `statusbar.ts` | A click always opens the side view. |
| `package.json` | No container in the activity bar, no sidebar view, no command **Show Panel**, no spike command, no setting `dataflow.view` and `dataflow.showFunctionScope`, and no colors of the overlay of Change Ripple |
| `scripts/build-webviews.mjs`, `tsconfig.json`, `tsconfig.webview.json` | Only the script of the side view |
| Deleted | `render/overlay.ts`, `render/rails.ts`, `panel/provider.ts`, `panel/protocol.d.ts`, `webview/panel.ts`, `spike/gutterSpike.ts` |

### Tests and tools

- The P1 exit check and the qmake check read the function in the toolbar of the side view.
- The tests of Flow Lens read the rails and the marks of the side view.
- The tests of the model of Change Ripple read the state of the review in the store.
- The test files of P3 and P4 are deleted. The suites S3 and S4 have the same checks in the side view. S3 got the only check that it did not have: the path panel shows why the line of the cursor runs.
- The S2 test for the editor mode is deleted. The tests of the side view do not set `dataflow.view`.
- The unit tests of the rails in the gutter and of the hints of Hidden C++ are deleted. The unit tests of the data of Hidden C++, of the review and of the layers use the new states.
- The snapshot scripts of the editor mode are deleted: `snapshot.mjs`, `flow-snapshot.mjs`, `logic-snapshot.mjs`, `cost-snapshot.mjs` and `ripple-snapshot.mjs`. The scripts of the side view do not set `dataflow.view`, and `side-flow-snapshot.mjs` has no screenshot of the editor mode.

### Documents

- The README describes only the side view. Each lens has one section.
- TODO.md has no items of the overlays and of the sidebar view.
- The status lines of the two plans tell that phase S6 is complete.

## Checks on the screen

| Check | Result |
| --- | --- |
| Review fixture with a new profile and no setting of the view, dark theme | The review opens the side view with the story. The wave, the cards, the click on a card, the file view with the ripple and the diff editor are correct. |
| Activity bar | Only the five icons of VS Code. The DataFlow container is gone. |

## Numbers

| Measurement | Result |
| --- | --- |
| Changed code | 58 files changed, 482 lines added and 3,310 lines removed, with these notes. In `src/`, 291 lines added and 2,329 lines removed. |
| Size of the script of the side view | 128 KB, as after phase S5 |
| Render of the visible rows of a file of 2,402 lines | A maximum of 2.6 ms. The budget is 100 ms. |

## Changes from the strategy

- **Data types:** the strategy moves the data types of the sidebar view to `side/protocol.d.ts`. The side view needs only a part of these data, so they went into the layer states of the store. The other types are gone.
- **Tests of P3 and P4:** the strategy moves all tests to the model of the side view. The suites S3 and S4 already had the same checks in the side view, so the tests of P3 and P4 are deleted, not moved.
- **P0 spike:** the strategy does not name the spike of the gutter icons. It draws in the text editor, so phase S6 removes it.

## Limits

- Old values of `dataflow.view`, `dataflow.showFunctionScope` and `dataflow.flow.followCursor` in the settings of a user have no effect. VS Code shows them as unknown settings.
- Without the icon in the activity bar, the status bar item and the button in the title bar of the editor are the ways to open the side view with no lens.

## How to do the tests

1. Type `npm test`.
2. Type `npm run test:engine`.
3. For screenshots, use the scripts `spikes/ui/side-*-snapshot.mjs`. Each script tells its arguments in its first lines.

## Next step

Phase P6 of [implementation-strategy.md](implementation-strategy.md): the release. It has the performance budgets, the error states, the user documentation, a VSIX for each platform and a beta on real code.
