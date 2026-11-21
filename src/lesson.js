// One lesson, closed-loop: read the DOM, press trusted keys, verify the
// site's own cursor advanced before moving on.
//
// School-edition DOM (from probe, Oct 2026), all inside the
// coreclassictyping.edclub.app iframe:
// - lesson text: `span.token_unit` inside `span.token` inside `span.line`
//   inside `div.typable…`  (e.g. <span class="token_unit _clr">h</span>)
// - cursor: `span.cursor.normal_cursor` — positioned AT the current char,
//   so the current index is found by rect overlap, not DOM order.
// - keys captured via a hidden top-level `input` (CDP presses just work)
// - completion: `lesson.mode === "finished"`
//
// Game activities (balloon valley, whack-a-monster, bubble burster, …) are
// Phaser canvas games in their own iframes — no DOM text. But the game
// bundle (read Oct 2026) shows every game builds the standard typing engine
// as scene.typingCore, and the engine sets `window.core = this`. So the
// sequence, current char and completion are readable from window.core in
// the game frame — no DOM/OCR needed. See typeGame() below.

import { config } from "./config.js";
import * as timing from "./timing.js";

const { sleep } = timing;

const TOKEN_CANDIDATES = [
  config.selectors.tokenUnit, // ".token span.token_unit"
  ".token_unit",
  "[class*='token_unit']",
];

const CURRENT_CANDIDATES = [
  config.selectors.cursorSelector, // "span.cursor" — the real one (probe Oct 2026)
  ".cursor",
  "#arena .sel",
  ".sel",
  ".current",
  "[class*='cursor']",
];

async function countIn(frame, sel) {
  try {
    return await frame.evaluate((s) => document.querySelectorAll(s).length, sel);
  } catch {
    return -1; // cross-origin or detached frame
  }
}

export async function diagnose(page) {
  const lines = [
    `url: ${page.url()}`,
    `title: ${await page.title().catch(() => "?")}`,
  ];
  for (const frame of page.frames()) {
    let furl;
    try {
      furl = frame.url();
    } catch {
      furl = "<inaccessible>";
    }
    lines.push(`frame: ${furl || "(no url)"}`);
    for (const sel of [...TOKEN_CANDIDATES, ...CURRENT_CANDIDATES]) {
      lines.push(`    ${sel}: ${await countIn(frame, sel)}`);
    }
  }
  return lines.join("\n");
}

function gameNameFromUrl(url) {
  const m = /phaser\d+([a-z]+)\.edclub\.app/.exec(url || "");
  return m ? m[1] : null;
}

async function visibleGameFrame(page) {
  // Lesson pages keep several game iframes in the DOM (preloaded upcoming
  // activities). The one actually running is the one that booted its
  // canvas — preloaded ones never get that far.
  const candidates = [];
  for (const frame of page.frames()) {
    let url = "";
    try {
      url = frame.url();
    } catch {
      continue;
    }
    const game = gameNameFromUrl(url);
    if (!game) continue;
    try {
      const el = await frame.frameElement();
      if (!el || !(await el.isVisible())) continue;
      // The dashboard embeds the next lesson as a small preview widget —
      // only the real lesson fills the content area.
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width < 480 || box.height < 300) continue;
      let hasCanvas = false;
      try {
        hasCanvas = await frame.evaluate(() => !!document.querySelector("canvas"));
      } catch {
        /* not booted yet */
      }
      candidates.push({ frame, game, hasCanvas });
    } catch {
      /* detached mid-navigation */
    }
  }
  if (!candidates.length) return null;
  const booted = candidates.find((c) => c.hasCanvas);
  if (booted) {
    // Log only when the candidate set changes (this runs in hot loops).
    if (candidates.length > 1) {
      const key = candidates.map((c) => c.game + (c.hasCanvas ? "1" : "0")).join(",");
      if (key !== visibleGameFrame._lastKey) {
        visibleGameFrame._lastKey = key;
        console.log(
          `  game candidates: ${candidates
            .map((c) => c.game + (c.hasCanvas ? "(running)" : ""))
            .join(", ")} → ${booted.game}`
        );
      }
    }
    return { frame: booted.frame, game: booted.game };
  }
  // One unbooted game: still loading, let the typer wait for its engine.
  // Several unbooted games: wait until the active one boots its canvas.
  if (candidates.length === 1) return { frame: candidates[0].frame, game: candidates[0].game };
  return null;
}

// The student dashboard previews the next lesson in a small game iframe.
// Only treat a game as the current lesson on an actual lesson page.
function isLessonPage(url) {
  return /\/lesson\//.test(url || "");
}

// Keys activities open with a new-key introduction: a "skip" screen
// (showing a few chars), then a "continue" button in the same spot. The bot
// must never mistake the intro's 3-char text for the real 20+ char
// activity — so the moment either screen is seen it's dismissed, twice in
// quick succession (one press sometimes half-dismisses, and the "continue"
// appears right where "skip" was).
async function dismissIntroScreens(page) {
  const matcher = () => {
    const norm = (t) => (t || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const cs = getComputedStyle(e);
      return cs.display !== "none" && cs.visibility !== "hidden";
    };
    const els = Array.from(document.querySelectorAll("button, a, [role='button']"));
    const btn = els.find((e) => {
      if (!vis(e)) return false;
      const n = norm(e.textContent);
      return n === "skip" || n === "skipintro" || n === "skipintroduction" || n === "continue";
    });
    if (btn) {
      btn.click();
      return norm(btn.textContent);
    }
    return null;
  };
  for (const frame of page.frames()) {
    let label = null;
    try {
      label = await frame.evaluate(matcher);
    } catch {
      continue; // cross-origin or detached frame
    }
    if (!label) continue;
    console.log(`  intro screen ("${label}") — dismissing…`);
    await sleep(250);
    try {
      await frame.evaluate(matcher); // second press in case it's still there
    } catch {
      /* frame went away — probably already past it */
    }
    return true;
  }
  return false;
}

export async function resolveLesson(page, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // 0. New-key intro screens first ("skip", then "continue"): dismiss
    //    before anything below can mistake the intro text for the lesson.
    if (await dismissIntroScreens(page)) {
      await sleep(1200); // let the next screen load
      continue;
    }
    // 1. prose/keys/hold lessons: lesson text in any frame
    for (const frame of page.frames()) {
      for (const tokenSel of TOKEN_CANDIDATES) {
        const n = await countIn(frame, tokenSel);
        if (n >= 3) {
          let currentSel = null;
          for (const c of CURRENT_CANDIDATES) {
            if ((await countIn(frame, c)) > 0) {
              currentSel = c;
              break;
            }
          }
          return { frame, tokenSel, currentSel, activity: "prose" };
        }
      }
    }
    // 1b. keys drills: no .token DOM (virtual keyboard), but the engine
    // holds the sequence. Detect via window.core on the lesson app frame
    // (not asset subframes like the hand SVGs).
    for (const frame of page.frames()) {
      let url = "";
      try {
        url = frame.url();
      } catch {
        continue;
      }
      if (!/^https:\/\/coreclassictyping\.edclub\.app\/\?/.test(url)) continue;
      try {
        const hasCore = await frame.evaluate(() => {
          const c = window.core;
          return !!(c && typeof c.text === "string" && c.text.length >= 3);
        });
        if (hasCore) {
          return { frame, tokenSel: null, currentSel: null, activity: "coredrill" };
        }
      } catch {
        /* not booted yet */
      }
    }
    // 2. game activity: a large, visible Phaser frame — but only on an
    //    actual lesson page, never on the dashboard (which previews the
    //    next lesson in a small widget).
    if (isLessonPage(page.url())) {
      const g = await visibleGameFrame(page);
      if (g) {
        // Skip games that already ended — we're waiting for the next
        // activity, not replaying a finished one.
        let ended = false;
        try {
          ended = await g.frame.evaluate(() => !!(window.core && window.core.has_ended));
        } catch {
          /* frame busy */
        }
        if (!ended) {
          return {
            frame: g.frame,
            tokenSel: null,
            currentSel: null,
            activity: "game",
            game: g.game,
          };
        }
      }
    }
    await sleep(800);
  }
  return null;
}

export async function readTargets(ctx) {
  return ctx.frame.evaluate((tokenSel) => {
    const els = Array.from(document.querySelectorAll(tokenSel));
    return els
      .map((el) => {
        const cls =
          el.className?.toString?.() +
          " " +
          el.firstChild?.className?.toString?.();
        if (/enter/i.test(cls || "")) return "\n";
        const t = (el.textContent || "")[0];
        if (!t) return "";
        return t === String.fromCharCode(160) ? " " : t;
      })
      .filter((c) => c !== "");
  }, ctx.tokenSel);
}

// Keys drills render a virtual keyboard (SVG keycaps, boxed chars) with no
// .token DOM — but the engine (window.core) holds the sequence. Read it,
// re-finding the frame fresh (lesson pages remount iframes during load).
async function readCoreSequence(page) {
  for (const f of page.frames()) {
    let url = "";
    try {
      url = f.url();
    } catch {
      continue;
    }
    // The lesson app frame — not asset subframes like the hand SVGs.
    if (!/^https:\/\/coreclassictyping\.edclub\.app\/\?/.test(url)) continue;
    try {
      const data = await f.evaluate(() => {
        const c = window.core;
        if (!c || typeof c.text !== "string" || !c.text) return null;
        return { text: c.text, index: c.cur_char_index || 0, ended: !!c.has_ended };
      });
      if (data) return data;
    } catch {
      /* not ready */
    }
  }
  return null;
}

async function typeCoreSequence(ctx, page, wpm) {
  // Type window.core.text, verifying via cur_char_index (the engine is
  // authoritative here — no DOM cursor to track).
  let core = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    core = await readCoreSequence(page);
    if (core) break;
    await sleep(1000);
  }
  if (!core) throw new Error("resolved a lesson frame but found no characters");
  if (core.ended) return { typed: 0, errors: 0 };
  const chars = core.text.split("");
  console.log(`  lesson text: ${chars.length} chars (via window.core)`);

  await focusLesson(ctx);
  await sleep(timing.lessonStartPauseMs());

  let typed = 0;
  let errors = 0;
  let verifyFails = 0;
  for (let i = core.index; i < chars.length; i++) {
    const want = chars[i];
    // No typos here: this engine advances on EVERY keypress (right or
    // wrong), so a typo would desync every char after it. Exact input only.
    await press(page, want);
    typed++;
    await sleep(timing.keyIntervalMs(want, "", wpm, config));

    // Verify the engine accepted it (index advanced past i).
    let ok = false;
    const vt0 = Date.now();
    while (Date.now() - vt0 < 2500) {
      const s = await readCoreSequence(page);
      if (!s) {
        await sleep(200);
        continue;
      }
      if (s.ended) return { typed, errors };
      if (s.index > i) {
        i = Math.max(i, s.index - 1);
        ok = true;
        break;
      }
      await sleep(100);
    }
    if (ok) verifyFails = 0;
    if (!ok) {
      verifyFails++;
      console.log(`  verify failed at char ${i} ("${want}") — retrying`);
      if (verifyFails >= 5) throw new Error("engine stopped advancing — aborting lesson");
      i--; // retry this char
    }
  }
  return { typed, errors };
}

export async function currentIndex(ctx) {
  if (!ctx.currentSel) return null;
  return ctx.frame.evaluate(
    ({ tokenSel, currentSel }) => {
      const els = Array.from(document.querySelectorAll(tokenSel));
      if (!els.length) return -1;
      const cur = document.querySelector(currentSel);
      if (!cur) return -1;
      const r = cur.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return -1; // hidden cursor
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < els.length; i++) {
        const b = els[i].getBoundingClientRect();
        if (cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom) return i;
        const dx = b.left + b.width / 2 - cx;
        const dy = b.top + b.height / 2 - cy;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    },
    { tokenSel: ctx.tokenSel, currentSel: ctx.currentSel }
  );
}

export async function lessonFinished(ctx) {
  try {
    return await ctx.frame.evaluate(() => {
      if (window.core?.has_ended) return true;
      try {
        if (typeof lesson !== "undefined" && lesson.mode === "finished") return true;
      } catch {
        /* lesson global not present on this screen */
      }
      return !!document.querySelector(".results, .result-screen, #results");
    });
  } catch {
    return false;
  }
}

// Some activities ask you to HOLD a key (e.g. one-hand lessons: "hold the
// F key") instead of just tapping. The engine's real mechanic (from its
// source): `window.core.anchor_key`, set via core.anchor(side, key). While
// an anchor key is set, every other key is swallowed unless the anchor key
// is physically held down — so the bot holds it while typing the text.
async function readAnchorKey(ctx) {
  try {
    const a = await ctx.frame.evaluate(() => window.core?.anchor_key || null);
    if (a) return String(a).toLowerCase();
  } catch {
    /* no engine in this frame */
  }
  try {
    return await ctx.frame.evaluate(() => {
      const text = document.body.innerText || "";
      const m = /hold\s+(?:down\s+)?(?:the\s+)?["']?([a-zA-Z])["']?\s+key/i.exec(text);
      return m ? m[1].toLowerCase() : null;
    });
  } catch {
    return null;
  }
}

async function press(page, char) {
  // Playwright key names; everything goes out as trusted CDP input.
  if (char === "\n") await page.keyboard.press("Enter");
  else if (char === " ") await page.keyboard.press("Space");
  else if (char === "Backspace") await page.keyboard.press("Backspace");
  else await page.keyboard.press(char);
}

async function focusLesson(ctx) {
  // Make sure keystrokes land in the lesson (matters when it's iframed).
  try {
    if (ctx.currentSel) {
      const el = await ctx.frame.$(ctx.currentSel);
      if (el) {
        await el.click({ timeout: 3000 });
        return;
      }
    }
    await ctx.frame.click("body", { timeout: 3000 });
  } catch {
    /* best effort */
  }
}

async function waitForAdvance(ctx, i, timeoutMs = 2500) {
  if (!ctx.currentSel) return true; // open-loop fallback
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const idx = await currentIndex(ctx);
    if (idx !== null && idx > i) return true;
    if (idx === -1 && (await lessonFinished(ctx))) return true;
    await sleep(60);
  }
  return false;
}

async function typeCharSequence(ctx, page, targets, wpm, opts = {}) {
  // The closed-loop core: press each char with human timing, verify the
  // site's cursor advanced before moving on.
  // opts.backspaceOnTypo=false for games (block mode: wrong chars never
  // advance, so there is nothing to erase).
  const backspaceOnTypo = opts.backspaceOnTypo ?? true;
  let prev = "";
  let typed = 0;
  let errors = 0;
  let verifyFails = 0;

  const startIndex = config.cursorVerify ? await currentIndex(ctx) : null;
  for (let i = Math.max(0, startIndex ?? 0); i < targets.length; i++) {
    const want = targets[i];

    // Fat-finger, notice, backspace, fix — like a human.
    const typo = timing.maybeTypo(want, config.typoRate);
    if (typo) {
      await press(page, typo);
      errors++;
      await sleep(timing.realizationPauseMs());
      if (backspaceOnTypo) {
        await press(page, "Backspace");
        await sleep(timing.realizationPauseMs() * 0.6);
      }
    }

    await press(page, want);
    typed++;

    // Closed loop: a keystroke only counts when the site's cursor moved.
    if (config.cursorVerify) {
      if (!(await waitForAdvance(ctx, i))) {
        console.log(`  verify failed at char ${i} (${JSON.stringify(want)}) — one retry`);
        await press(page, want);
        typed++;
        if (await waitForAdvance(ctx, i)) {
          verifyFails = 0;
        } else if (++verifyFails >= 5) {
          throw new Error(
            "cursor-advance detection broken (5 consecutive failures) — stopping " +
              "instead of doubling keys. Run `npm run probe` and paste the output."
          );
        }
      } else {
        verifyFails = 0;
      }
    }

    await sleep(timing.keyIntervalMs(want, prev, wpm, config));
    prev = want;

    if (await lessonFinished(ctx)) break;
  }

  return { typed, errors };
}

export async function typeLesson(ctx, page, wpm) {
  // Hold-key activity: hold the anchor key while typing the text.
  const holdKey = await readAnchorKey(ctx);
  if (holdKey) {
    console.log(`  hold-key activity: holding "${holdKey}" while typing…`);
    let targets = [];
    try {
      targets = await readTargets(ctx);
    } catch {
      /* hold-only activity, no text */
    }
    await focusLesson(ctx);
    await sleep(timing.lessonStartPauseMs());
    await page.keyboard.down(holdKey);
    try {
      if (!targets.length) {
        // No text to type — hold until the lesson reports finished.
        const t0 = Date.now();
        while (Date.now() - t0 < 90000) {
          await sleep(500);
          if (await lessonFinished(ctx)) break;
        }
        console.log("  hold complete.");
        return { typed: 0, errors: 0 };
      }
      return await typeCharSequence(ctx, page, targets, wpm);
    } finally {
      await page.keyboard.up(holdKey);
    }
  }

  const targets = ctx.tokenSel ? await readTargets(ctx) : [];
  if (!targets.length) {
    // Keys drills have no .token DOM — fall back to the engine's sequence.
    console.log("  no .token text — trying window.core sequence (keys drill?)");
    return typeCoreSequence(ctx, page, wpm);
  }
  console.log(`  lesson text: ${targets.length} chars (via "${ctx.tokenSel}")`);

  await focusLesson(ctx);
  await sleep(timing.lessonStartPauseMs()); // "reading" the lesson first
  console.log(
    `  cursor marker: ${ctx.currentSel || "none (open-loop)"}, verification: ${
      config.cursorVerify ? "ON" : "OFF"
    }`
  );

  return typeCharSequence(ctx, page, targets, wpm);
}

// --- Phaser game activities ---
//
// Two flavors, both driven by the games' own typing engine (window.core,
// set by the engine constructor — confirmed live by probe Oct 2026):
//
// LETTER games (balloon valley, …): the engine tracks every keystroke, so
// the bot types the next expected char (window.core.cur_char.chr) and
// verifies cur_char_index advanced.
//
// WORD games (bubble burster): the game wraps the engine in a word matcher
// (scene.wordsCore) that intercepts keystrokes and matches the typed prefix
// against the words currently floating in bubbles. Non-matching chars are
// silently popped, backspace is ignored, and a word only completes when its
// bubble is visible — but ANY visible word completes in ANY order (the
// engine jump-focuses to the completed word, so lesson-text order is not
// required). Words spawn sequentially from a pool in engine-word order (~2
// bubbles at a time, next spawns on each completion); escaped words are
// re-queued at the back; 5 lives; win or out-of-lives ends the engine.
// The bot simulates the spawn pool (its "believed-visible" set), types
// those words, and mirrors the game's re-queue rule from what the engine
// confirms — a word counts only when the engine index lands exactly past
// it (end+1), never assumed. The game's keystroke buffer only clears on
// completion, so a failed word gets a stale-prefix recovery attempt before
// being mirror-requeued.
//
// Guards found in the bundles — all harmless at human speed:
//   balloon valley: wpm > 250 → game over (we type ~55)
//   bubble burster: 5 lives, one lost per bubble that floats off untyped
//   both: typos are always isolated (word mode: misses are popped, never
//         counted; letter mode: block mode, immediately corrected)
//   both: never idle mid-game — the bubbles/balloons keep moving
//   engine: >15 invalid keys within 2s → abort (never at our accuracy)
//
// Lesson pages remount game iframes during load, silently staling a held
// frame reference — so the game frame is re-found fresh on every read.
async function readGameState(frame) {
  try {
    return await frame.evaluate(() => {
      const core = window.core;
      if (!core || typeof core.text !== "string" || !core.text.length) return null;
      return {
        text: core.text,
        len: core.text.length,
        index: core.cur_char_index,
        cur: core.cur_char ? core.cur_char.chr : null,
        ended: !!core.has_ended,
      };
    });
  } catch {
    return null; // frame not ready / cross-origin
  }
}

// Fresh frame lookup every time: the lesson page remounts game iframes
// during load, and a held reference goes silently stale.
async function gameFrame(page, game) {
  if (!isLessonPage(page.url())) return null;
  const g = await visibleGameFrame(page);
  if (!g || (game && g.game !== game)) return null;
  return g.frame;
}

async function focusGame(page, game) {
  const frame = await gameFrame(page, game);
  if (!frame) return false;
  try {
    await frame.click("body", { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function gameFinished(page, game) {
  const frame = await gameFrame(page, game);
  if (!frame) return false;
  const st = await readGameState(frame);
  return !!st && st.ended;
}

async function readLetterState(page, game) {
  const frame = await gameFrame(page, game);
  if (!frame) return null;
  return readGameState(frame);
}

async function waitForGameAdvance(page, game, i, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await readLetterState(page, game);
    if (!st) return false;
    if (st.ended || st.index > i) return true;
    await sleep(60);
  }
  return false;
}

async function readWordState(page, game) {
  const frame = await gameFrame(page, game);
  if (!frame) return null;
  try {
    const st = await frame.evaluate(() => {
      const core = window.core;
      if (!core || typeof core.text !== "string" || !core.text.length) return null;
      const words = [];
      try {
        const w = core.words || {};
        for (const k of Object.keys(w).map(Number).sort((a, b) => a - b)) {
          const cl = (w[k] && w[k].char_list) || [];
          const text = cl.map((c) => c.chr).join("");
          if (text) words.push({ text, end: cl[cl.length - 1].index });
        }
      } catch {
        /* ignore */
      }
      return { index: core.cur_char_index, ended: !!core.has_ended, words };
    });
    return st && st.words.length ? st : null;
  } catch {
    return null;
  }
}

const WORD_GAMES = new Set(["bubbleburster"]);

export async function typeGame(ctx, page, wpm) {
  if (WORD_GAMES.has(ctx.game)) return typeWordGame(ctx, page, wpm);
  return typeLetterGame(ctx, page, wpm);
}

async function typeLetterGame(ctx, page, wpm) {
  const game = ctx.game;
  // Wait for the game's typing engine (built when the game boots).
  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    st = await readLetterState(page, game);
    if (st) break;
    await sleep(1000);
  }
  if (!st)
    throw new Error(
      `game frame (${game || "unknown"}) has no window.core typing engine — ` +
        "cannot play this variant"
    );
  console.log(`  game "${game || "unknown"}": ${st.len} chars (via window.core)`);

  await focusGame(page, game);
  await sleep(timing.lessonStartPauseMs()); // "reading" the game

  // Belt and braces: balloon valley ends the run if wpm exceeds 250.
  const gameWpm = Math.min(wpm, 120);
  let typed = 0;
  let errors = 0;
  let verifyFails = 0;
  let prev = "";

  for (;;) {
    st = await readLetterState(page, game);
    if (!st) throw new Error("lost the game state mid-lesson");
    if (st.ended || st.index >= st.len) break;
    const want = st.cur ?? st.text[st.index];
    if (!want) {
      await sleep(200);
      continue;
    }
    const i = st.index;

    // Isolated typo only — the game uses block mode (wrong chars don't
    // advance), so no backspace needed; the correct char resets the
    // consecutive-error counter.
    const typo = timing.maybeTypo(want, config.typoRate);
    if (typo) {
      await press(page, typo);
      errors++;
      await sleep(timing.realizationPauseMs());
    }

    await press(page, want);
    typed++;

    if (config.cursorVerify) {
      if (!(await waitForGameAdvance(page, game, i))) {
        console.log(`  game verify failed at ${i} (${JSON.stringify(want)}) — one retry`);
        await press(page, want);
        typed++;
        if (await waitForGameAdvance(page, game, i)) {
          verifyFails = 0;
        } else if (++verifyFails >= 5) {
          throw new Error(
            "game advance detection broken (5 consecutive failures) — stopping " +
              "instead of mashing keys."
          );
        }
      } else {
        verifyFails = 0;
      }
    }

    await sleep(timing.keyIntervalMs(want, prev, gameWpm, config));
    prev = want;
    // No long pauses in games — the balloons keep falling.
  }

  return { typed, errors };
}

async function typeWordGame(ctx, page, wpm) {
  const game = ctx.game;
  // Press SPACE immediately: the game ("Hit SPACE to begin") may already
  // be spawning bubbles, and every second of setup is float time lost.
  try {
    const f0 = await gameFrame(page, game);
    if (f0) {
      try {
        await f0.click("body", { timeout: 3000 });
      } catch (e) {
        /* best effort */
      }
      await page.keyboard.press("Space");
    }
  } catch (e) {
    /* best effort */
  }
  // Wait for the game's typing engine (built when the game boots).
  let gs = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    gs = await readWordState(page, game);
    if (gs) break;
    await sleep(1000);
  }
  if (!gs)
    throw new Error(
      `game frame (${game}) has no window.core typing engine — cannot play this variant`
    );
  console.log(`  game "${game}": ${gs.words.length} words (word mode via window.core)`);

  // Best-effort probe: can page JS reach the game's bubble/word state?
  // (If a path turns up, a later build can read visible words directly
  // instead of simulating the spawn pool.)
  try {
    const frame = await gameFrame(page, game);
    if (frame) {
      const probe = await frame.evaluate(() => {
        const out = { hits: [] };
        try {
          out.coreKeys = Object.keys(window.core || {}).slice(0, 40);
        } catch (e) {
          out.coreKeys = "err";
        }
        try {
          out.approuterKeys = window.approuter ? Object.keys(window.approuter).slice(0, 40) : null;
        } catch (e) {
          /* ignore */
        }
        const tests = {
          "core.scene.wordsCore.visible_words": () =>
            window.core &&
            window.core.scene &&
            window.core.scene.wordsCore &&
            window.core.scene.wordsCore.visible_words,
          "core.wordsCore.visible_words": () =>
            window.core && window.core.wordsCore && window.core.wordsCore.visible_words,
          "approuter.scene.wordsCore": () =>
            window.approuter && window.approuter.scene && window.approuter.scene.wordsCore,
        };
        for (const k of Object.keys(tests)) {
          try {
            const v = tests[k]();
            if (v !== undefined && v !== null)
              out.hits.push(k + "=" + (Array.isArray(v) ? "array[" + v.length + "]" : typeof v));
          } catch (e) {
            /* ignore */
          }
        }
        return out;
      });
      console.log("  state probe: " + JSON.stringify(probe).slice(0, 400));
    }
  } catch (e) {
    /* best effort only */
  }

  // Make sure the game is started ("Hit SPACE to begin" — harmless if
  // already started; one was also pressed earlier to cut setup time).
  await focusGame(page, game);
  await sleep(600);
  await page.keyboard.press("Space");
  await sleep(800);

  // Word games need pace — bubbles escape if you dawdle. Fast-human speed,
  // no typos: a wrong char can strand the game's keystroke buffer on
  // another bubble's prefix.
  //
  // How the game works (from its bundle): words spawn sequentially from a
  // pool in engine-word order, ~2 bubbles at a time; every completion
  // spawns the next; escaped words are re-queued at the back; 5 lives.
  // The matcher completes ANY visible word in ANY order (the engine
  // jump-focuses to it), the keystroke buffer ONLY clears on completion,
  // and game over — win or out of lives — ends the engine.
  //
  // So the bot simulates the spawn pool (its "believed-visible" set),
  // types those words, and mirrors the game's own rules from what the
  // engine confirms. A word counts ONLY when the engine index lands
  // exactly past it (end+1) — never assumed.
  const gameWpm = 100;
  let typed = 0;
  let words, pool, visible, doneEnds;

  function resetBelief(freshWords) {
    words = freshWords;
    pool = words.slice();
    visible = [];
    doneEnds = new Set();
    spawnNext();
    spawnNext(); // the game opens with two bubbles
  }
  function spawnNext() {
    // Mirror activate_and_pull_word: next pool word that isn't done and
    // isn't already believed visible.
    for (let n = 0; n < pool.length; n++) {
      const w = pool.shift();
      if (doneEnds.has(w.end) || visible.some((v) => v.end === w.end)) {
        pool.push(w); // stays in the pool for later
        continue;
      }
      visible.push(w);
      return;
    }
  }
  async function pollCompletion(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = await readWordState(page, game);
      if (!s) return { status: "lost" };
      if (s.ended) return { status: "ended" };
      const hit = words.find((w) => !doneEnds.has(w.end) && s.index === w.end + 1);
      if (hit) return { status: "completed", word: hit };
      await sleep(200);
    }
    return { status: "none" };
  }
  async function typeText(text) {
    for (const ch of text) {
      await press(page, ch);
      typed++;
      await sleep(timing.keyIntervalMs(ch, "", gameWpm, config));
    }
  }
  function markCompleted(w) {
    doneEnds.add(w.end);
    visible = visible.filter((v) => v.end !== w.end);
    const pi = pool.findIndex((p) => p.end === w.end);
    if (pi >= 0) pool.splice(pi, 1);
    console.log(`  "${w.text}" done (${doneEnds.size}/${words.length})`);
    spawnNext();
  }
  // A failed word may have left a stale prefix in the game's buffer (when
  // it shares a prefix with a visible word) — and a stale buffer replayed
  // on the next escape is what the engine counts as errors (the wrong
  // sounds). Finish the word the stale prefix points at: completing
  // anything flushes the buffer. Candidates are (shared-prefix, word)
  // pairs, visible bubbles first, longest shared prefix first.
  async function recoverStale(w) {
    const cands = [];
    for (const y of words) {
      if (doneEnds.has(y.end) || y.end === w.end) continue;
      let p = 0;
      while (p < w.text.length && p < y.text.length && w.text[p] === y.text[p]) p++;
      if (p >= 1 && p < y.text.length) cands.push({ p, y });
    }
    cands.sort(
      (a, b) =>
        (visible.some((v) => v.end === b.y.end) ? 0 : 1) -
          (visible.some((v) => v.end === a.y.end) ? 0 : 1) || b.p - a.p
    );
    for (const { p, y } of cands.slice(0, 3)) {
      await typeText(y.text.slice(p));
      await sleep(300);
      const r = await pollCompletion(600);
      if (r.status === "lost") throw new Error("lost the game state mid-lesson");
      if (r.status === "ended") return "ended";
      if (r.status === "completed") {
        markCompleted(r.word);
        return "completed";
      }
    }
    return "failed";
  }
  function mirrorRequeue(w) {
    // Words we can't complete are treated like escapes: re-queued at the
    // back so the belief keeps moving with the game.
    visible = visible.filter((v) => v.end !== w.end);
    if (!pool.some((p) => p.end === w.end)) pool.push(w);
    spawnNext();
  }

  resetBelief(gs.words);

  const startT = Date.now();
  const GAME_CAP_MS = 12 * 60 * 1000;
  const NO_PROGRESS_MS = 120000;
  let lastAdvanceT = Date.now();
  let lastSpaceNudge = 0;
  let retries = 0;

  for (;;) {
    const s = await readWordState(page, game);
    if (!s) throw new Error("lost the game state mid-lesson");
    if (s.ended) {
      const n = doneEnds.size;
      if (n >= words.length - 1 || retries >= 1) {
        if (n < words.length - 1) console.log(`  game over (${n}/${words.length} words) — moving on`);
        break;
      }
      // Ended with words left: out of lives. The lose screen says "Hit
      // SPACE to try again" — take it up on that, once.
      console.log(`  game over (${n}/${words.length} words) — retrying once…`);
      retries++;
      await page.keyboard.press("Space");
      await sleep(2500);
      const s2 = await readWordState(page, game);
      if (!s2 || s2.ended) {
        console.log("  retry did not restart the game — moving on");
        break;
      }
      resetBelief(s2.words);
      lastAdvanceT = Date.now();
      continue;
    }
    if (Date.now() - startT > GAME_CAP_MS)
      throw new Error("word game ran 12 minutes without finishing — aborting");
    const idleMs = Date.now() - lastAdvanceT;
    if (idleMs > NO_PROGRESS_MS)
      throw new Error("word game: no word completed in 2 minutes — aborting");
    if (idleMs > 30000 && Date.now() - lastSpaceNudge > 30000) {
      lastSpaceNudge = Date.now();
      console.log("  no progress in 30s — nudging with SPACE…");
      await page.keyboard.press("Space");
    }

    if (!visible.length) {
      spawnNext();
      spawnNext();
      if (!visible.length) {
        await sleep(1000);
        continue;
      }
    }
    const target = visible[0];

    await typeText(target.text);
    await sleep(300);
    let r = await pollCompletion(700);
    if (r.status === "lost") throw new Error("lost the game state mid-lesson");
    if (r.status === "ended") continue;
    if (r.status === "completed") {
      markCompleted(r.word);
      lastAdvanceT = Date.now();
      continue;
    }
    // Not completed — maybe a stale buffer is in the way; try to flush
    // it, then mirror-requeue so the belief keeps moving.
    r = await recoverStale(target);
    if (r === "ended") continue;
    if (r === "completed") {
      lastAdvanceT = Date.now();
      continue;
    }
    mirrorRequeue(target);
    await sleep(300);
  }

  return { typed, errors: 0 };
}
