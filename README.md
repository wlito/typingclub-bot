# TypingClub Bot (stealth Playwright)

Fully automates TypingClub lessons from inside chromium and reads the lesson text straight from the DOM
and types it back through trusted CDP input with human-like timing.

## Setup (on your Arch box)

```bash
cd ~/workspace/typingclub_bot
npm install
npx playwright install chromium   # one-time browser download
```

Then edit `src/config.js`:

1. **`startUrl`** — paste the URL of the first lesson to automate.
2. **`targetWpm` / `targetAccuracy`** — set these to the account's *real*
   history. This is the single most important anti-detection setting.
3. Tune session length/breaks if you like.

## First run

```bash
npm start
```

A Chromium window opens using `./profile` (persistent — cookies survive).
If you're not logged in / not on a lesson, log in and open the first lesson
manually; the bot waits up to 5 minutes, then takes over. After that it runs
the session on its own: types each lesson, pauses on the results screen,
takes human-like breaks, clicks through to the next lesson.

```bash
node src/index.js --wpm 52 --lessons 6   # overrides
```

## How it works

- **Prose / keys lessons** (classic typing iframe): reads the lesson text from
  the DOM, types it with trusted CDP input and human timing. The real cursor
  (`span.cursor`, found by probe) is tracked by screen position — every
  keystroke is verified against it, so the bot never types blind or double.
- **Hold-key activities** (e.g. one-hand lessons): reads the engine's
  `window.core.anchor_key` (falling back to the "hold the X key" instruction)
  and holds that key *while typing the lesson text*, which is what the
  engine's anchor mechanic actually requires.
- **Game activities** (balloon valley, bubble burster, whack-a-monster, …):
  the games' own bundles show each one builds the standard typing engine,
  exposed at `window.core` in the game iframe (confirmed live by probe).
  Two modes: *letter games* (balloon valley) read the next expected char
  from `window.core.cur_char` and verify `cur_char_index` advanced;
  *word games* (bubble burster) type whole words from `window.core.words`
  in passes — the game's own word matcher pairs keystrokes with the
  visible bubbles, so the bot just checks each word off via the engine's
  position jumps. No DOM/OCR needed. Guards respected: far under the
  250-wpm kill-switch, isolated typos only, never idles mid-game, and the
  game frame is re-found fresh on every read (lesson pages remount
  iframes, which stales held references).

## Why it's hard to catch

- **Trusted input.** Every keystroke goes through Chrome DevTools Protocol
  (`page.keyboard`), producing `isTrusted = true` keydown/keypress/keyup —
  indistinguishable from a physical keyboard. We never dispatch synthetic
  events and never call the page's internal JS APIs (what the known cheat
  scripts do — zero input events, far more suspicious).
- **Human timing model** (`src/timing.js`): lognormal inter-key intervals,
  word-boundary and line-break pauses, fast double-letters, QWERTY-adjacent
  fat-fingers with backspace corrections, per-session WPM drift.
- **Human sessions**: random 4–9 lesson runs, 30s–2min breaks between lessons,
  a real 7–20 min break every 6 lessons, results-screen "reading" pauses.
- **Stealth browser**: `playwright-extra` + stealth plugin scrubs
  `navigator.webdriver` and the usual automation fingerprints; persistent
  profile with a real login; headed window so focus/visibility checks pass.
- **Identity matching**: WPM/accuracy tuned to the account's own history.

## Honest limits

- "Very hard to catch" is not "impossible". Behavioral forensics (deep
  keystroke-dynamics analysis) could in principle flag any bot; TypingClub is
  a kids' typing site, not a bank, and is unlikely to run that.
- DOM selectors were calibrated by probe against the school edition
  (academyfse.edclub.com, Oct 2026), but EdClub can restyle at any time —
  if the bot reports "no target characters found", re-run `npm run probe`
  and paste the output.
## Troubleshooting

- **"Still not detecting a lesson"**: every 30s the bot prints a diagnostic
  dump (URL, frames, and match counts for every selector it tries). Paste
  that output back — the selectors get fixed from evidence, not guesses.
  Common causes: TypingClub restyled since the reference scripts, or the
  lesson loads inside an iframe (the bot now searches all frames).
- **Doubled keys / cursor issues**: run `npm run probe` with the lesson open
  (game started, if it's a game), press Enter, and paste the JSON dump.
  If verification ever misbehaves, set `cursorVerify: false` in
  `src/config.js` to run open-loop.
- **Game skipped**: if a game iframe never exposes `window.core` (a variant
  built differently), the bot skips it cleanly after ~20s — the session moves
  on without hanging. Paste the probe output for that game so support can
  be added.
- Keep sessions sane: sane hours, sane lesson counts, WPM near history.
