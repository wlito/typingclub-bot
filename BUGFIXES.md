# Bug fixes

This copy fixes the following issues without changing the configured typing
speed, lesson count, breaks, or browser concealment settings:

- Results buttons now call Playwright's `first()` locator method correctly.
- Failed navigation clicks no longer falsely report success or prevent trying
  the remaining selectors.
- Lesson failures attempt navigation and stop after 15 consecutive failures,
  rather than waiting for five minutes on the same lesson without advancing.
- Session and diagnostic browsers close in `finally` blocks on errors.
- Command-line arguments are validated before browser dependencies are loaded.
  Missing, malformed, nonpositive, and unknown options report errors; lesson
  counts must be safe integers. Help works without installed dependencies.
- Key drills resume from their current engine position, stop when the engine
  reports completion, and reset the failure counter after successful input.
- Ordinary text lessons resume from the detected cursor when verification is on.
- Game state includes text for the existing missing-current-character fallback.
- Completion detection recognizes the engine's `has_ended` flag.
- Retry confirmation rejects lesson contexts that still report completion.
- Key-drill signatures use the engine text instead of querying a null selector.
- Diagnostic output redacts input-field values.

Run the offline regression checks with `npm test`. They use Node's built-in
test runner and mocked browser objects; they require no dependencies, account,
or network access. JavaScript syntax checks were also run.

No live TypingClub session was run, so current website compatibility is unverified.
The README's claims about undetectability are not established by these fixes.
The `targetAccuracy` setting remains unused; the existing typo-rate model controls
intentional errors, and several activity types intentionally introduce no typos.
