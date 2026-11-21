// All tunables in one place.
//
// THE GOLDEN RULE: match these to the account's real history. The single
// biggest detection signal is stats that don't look like the account owner.
// A bot doing 55 wpm at 96% when the kid types 50 wpm at 94% is invisible.
// The same bot doing 120 wpm at 100% is a confession.

export const config = {
  // --- identity (match the account's history!) ---
  // NOTE (Oct 5): Erik's current TEST values, baked in per his request so
  // he doesn't re-apply them after every update. He'll set targetWpm back
  // to the account-matched 55 after testing.
  targetWpm: 72, // mean words per minute, per session (test value; was 55)
  wpmSessionJitter: 6, // sessions drift a little, like humans do
  targetAccuracy: 96, // percent; achieved via the typo model below

  // --- human timing model ---
  typoRate: 0.03, // ~3% of chars start as a typo, then get corrected
  minKeyIntervalMs: 45, // hard floor (the site itself bugs out below ~60ms)
  timingSigma: 0.45, // lognormal spread of inter-key intervals

  // Verify each keystroke against the site's cursor before moving on.
  // The real cursor (span.cursor, found by probe) is now used, so this is
  // back ON. If it ever misbehaves, the bot stops loudly instead of
  // doubling keys — flip it off to run open-loop.
  cursorVerify: true,

  // --- session behavior ---
  // ERIK'S TEST VALUES (Oct 5) — baked in per his request.
  lessonsPerSession: [100, 101], // random count each run
  breakBetweenLessonsSec: [1, 3],
  longBreakAfterLessons: 6, // every N lessons…
  longBreakSec: [1, 3], // …take a real break

  // --- browser ---
  startUrl: "https://www.typingclub.com/", // <-- set to the first lesson URL
  userDataDir: "./profile", // persistent profile: login once, stays logged in
  headless: false, // headed: safest for focus/visibility checks
  viewport: { width: 1512, height: 860 },
  locale: "en-US",
  timezoneId: "America/New_York",

  // --- DOM hooks (school edition, from probe Oct 2026) ---
  selectors: {
    tokenUnit: ".token span.token_unit", // lesson text, in coreclassictyping iframe
    cursorSelector: "span.cursor", // the real cursor (span.cursor.normal_cursor)
    current: "#arena .sel", // legacy fallback
    loginForm: 'form[action*="login"], input[type="password"]',
    nextButton: [".btn-next", "a.next", "button.next", ".nav-next"],
  },
};
