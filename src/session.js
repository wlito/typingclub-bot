// Multi-lesson session: human-like pacing, breaks, caps, next-lesson flow.
//
// Progression is resilient by design: after each lesson the bot clicks
// "move on" (ENTER can trigger "try again" on teacher-configured results
// screens), falling back to the next-lesson button, and if that fails (or
// navigation hiccups) it simply waits — advance manually and it picks up
// the next lesson on its own.
// The browser is never killed by a navigation error, and a finished lesson
// is never re-typed (we wait for a *different* lesson to appear).

import { config } from "./config.js";
import { launch } from "./browser.js";
import { diagnose, lessonFinished, resolveLesson, typeLesson, typeGame, gameFinished } from "./lesson.js";
import * as timing from "./timing.js";

const { sleep } = timing;

async function lessonSig(page, ctx) {
  if (ctx.activity === "game") return `${page.url()}::game:${ctx.game}`;
  try {
    const head = await ctx.frame.evaluate((tokenSel) => {
      if (!tokenSel) return (window.core?.text || "").slice(0, 80);
      const els = Array.from(document.querySelectorAll(tokenSel)).slice(0, 20);
      return els.map((e) => e.textContent).join("");
    }, ctx.tokenSel);
    return `${page.url()}::${head.slice(0, 80)}`;
  } catch {
    return page.url();
  }
}

async function waitForLesson(page, { notSig = null, timeoutMs = 5 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastDiag = 0;
  console.log("Looking for a lesson…");
  while (Date.now() < deadline) {
    const ctx = await resolveLesson(page, 4000);
    if (ctx) {
      if (notSig) {
        const sig = await lessonSig(page, ctx);
        if (sig === notSig) {
          await sleep(2000); // same lesson still showing — keep waiting
          continue;
        }
      }
      console.log(`lesson detected (${ctx.tokenSel}, ${ctx.activity})`);
      return ctx;
    }
    if (Date.now() - lastDiag > 30000) {
      lastDiag = Date.now();
      console.log("--- still not detecting a lesson. What I can see: ---");
      console.log(await diagnose(page));
      console.log(
        "--- (open a real lesson — the dashboard preview doesn't count) ---"
      );
    }
    await sleep(2000);
  }
  throw new Error("timed out waiting for a lesson page");
}

// Shared machinery: click a results-screen button by label. Trusted
// Playwright clicks first, then a synthetic fallback for non-semantic
// controls.
async function clickLabeledButton(page, regexes, normWants) {
  for (const frame of page.frames()) {
    for (const role of ["button", "link"]) {
      for (const re of regexes) {
        try {
          const loc = frame.getByRole(role, { name: re });
          if ((await loc.count()) > 0) {
            await loc.first().click({ timeout: 3000 });
            return true;
          }
        } catch {
          /* try the next combination */
        }
      }
    }
  }
  for (const frame of page.frames()) {
    try {
      const clicked = await frame.evaluate((wants) => {
        const norm = (t) => (t || "").trim().toLowerCase().replace(/[^a-z]/g, "");
        const vis = (e) => {
          const r = e.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          const cs = getComputedStyle(e);
          return cs.display !== "none" && cs.visibility !== "hidden";
        };
        const els = Array.from(
          document.querySelectorAll(
            "button, a, input[type=button], input[type=submit], [role='button'], [onclick]"
          )
        );
        for (const want of wants) {
          const btn = els.find((e) => vis(e) && norm(e.textContent || e.value) === want);
          if (btn) {
            btn.click();
            return true;
          }
        }
        return false;
      }, normWants);
      if (clicked) return true;
    } catch {
      /* frame busy — try the next one */
    }
  }
  return false;
}

// Click whatever moves to the next lesson. The results screen's button
// varies: "next" on a perfect score, "move on" otherwise — so try the
// labels in priority order.
async function clickAdvance(page, ctx) {
  if (
    await clickLabeledButton(
      page,
      [/move\s*on/i, /next/i, /continue/i],
      ["moveon", "next", "nextlesson", "continue"]
    )
  )
    return true;
  try {
    for (const sel of config.selectors.nextButton) {
      let el = null;
      try {
        el = (await ctx.frame.$(sel)) || (await page.$(sel));
      } catch {
        /* frame may be mid-navigation */
      }
      if (el) {
        try {
          await el.click({ timeout: 4000 });
          return true;
        } catch {
          // A failed click must not prevent trying the remaining selectors.
        }
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

// "Try again" on the results screen — for redoing a zero-score lesson.
async function clickRetry(page) {
  return clickLabeledButton(
    page,
    [/try\s*again/i, /\bretry\b/i, /\brepeat\b/i],
    ["tryagain", "retry", "repeat", "repeatlesson"]
  );
}

// Score 0 on the results screen means the attempt was worthless — redo
// the lesson instead of moving on. Capped so a broken lesson can't loop
// forever. Returns true when a retry was kicked off.
async function maybeRetryZeroScore(page, ctx, sig, retryCounts) {
  const info = await resultsInfo(page);
  const score =
    info && info.score != null ? parseInt(info.score.replace(/,/g, ""), 10) : null;
  if (score !== 0) return false;
  const n = retryCounts.get(sig) || 0;
  if (n >= 2) {
    console.log("  score 0 again after retries — moving on");
    return false;
  }
  console.log(`  score 0 — retrying the lesson (attempt ${n + 2})…`);
  const t0 = Date.now();
  let clicked = false;
  while (Date.now() - t0 < 10000 && !clicked) {
    clicked = await clickRetry(page);
    if (!clicked) await sleep(1500);
  }
  if (!clicked) {
    console.log("  (no retry control found — moving on)");
    return false;
  }
  retryCounts.set(sig, n + 1);
  // Make sure the retry actually reloaded the lesson before handing off;
  // otherwise the loop top would wait on a stale results screen.
  const t1 = Date.now();
  while (Date.now() - t1 < 12000) {
    if (!(await resultsInfo(page))) return true; // results gone — reloading
    const ctx2 = await resolveLesson(page, 1500);
    if (ctx2 && !(await lessonFinished(ctx2))) return true;
    await sleep(1000);
  }
  console.log("  (retry didn't reload — moving on)");
  return false;
}

async function doLesson(ctx, page, wpm, n, total) {
  if (ctx.activity === "game") {
    console.log(`  game activity (${ctx.game || "unknown"}) — playing via the game's own engine…`);
    if (await gameFinished(page, ctx.game)) {
      console.log("  this game already shows complete — waiting for the next one…");
      return "already-done";
    }
    console.log(`lesson ${n}/${total}…`);
    const { typed, errors } = await typeGame(ctx, page, wpm);
    const acc = typed ? ((typed - errors) / typed) * 100 : 100;
    console.log(`  done — ${typed} keys, ~${acc.toFixed(1)}% accuracy`);

    // typeGame only returns once the engine reports ended, so this is a
    // bounded confirmation — a remounting frame can't stall the break.
    await confirmEnd(() => gameFinished(page, ctx.game), "the results screen");
    const pauseMs = timing.resultsPauseMs();
    console.log(`  checking results (~${(pauseMs / 1000).toFixed(0)}s)…`);
    await sleep(pauseMs);
    return "done";
  }
  if (await lessonFinished(ctx)) {
    console.log("  this lesson already shows complete — waiting for the next one…");
    return "already-done";
  }
  console.log(`lesson ${n}/${total}…`);
  const { typed, errors } = await typeLesson(ctx, page, wpm);
  const acc = typed ? ((typed - errors) / typed) * 100 : 100;
  console.log(`  done — ${typed} keys, ~${acc.toFixed(1)}% accuracy`);

  await confirmEnd(() => lessonFinished(ctx), "the results screen");
  const pauseMs = timing.resultsPauseMs();
  console.log(`  checking results (~${(pauseMs / 1000).toFixed(0)}s)…`);
  await sleep(pauseMs); // "reading" the results
  return "done";
}

// The typer already drove the lesson to completion; this just confirms the
// results screen is up, bounded so it can never stall the break.
async function confirmEnd(check, label) {
  try {
    if (await check()) return;
  } catch {
    return;
  }
  console.log(`  waiting for ${label}…`);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await sleep(500);
    try {
      if (await check()) return;
    } catch {
      return;
    }
  }
  console.log(`  (${label} didn't confirm — moving on anyway)`);
}

async function advanceLesson(ctx, page, prevSig) {
  // Prefer the "move on" button: pressing ENTER can trigger "try again"
  // instead when the results screen is set up that way.
  const info = await resultsInfo(page);
  console.log(
    info
      ? `  results screen detected${info.score ? ` (score ${info.score})` : ""} — advancing…`
      : "  lesson finished — advancing…"
  );
  const t0 = Date.now();
  let attempts = 0;
  while (Date.now() - t0 < 15000) {
    const nctx = await resolveLesson(page, 1500);
    if (nctx) {
      const sig = await lessonSig(page, nctx).catch(() => null);
      if (sig && sig !== prevSig) {
        console.log("  advanced to the next lesson.");
        return true;
      }
    }
    if (attempts < 2 && Date.now() - t0 >= attempts * 6000) {
      attempts++;
      if (await clickAdvance(page, ctx)) {
        console.log("  advancing…");
      } else if (attempts === 1) {
        console.log("  (no advance control found yet)");
      }
    }
    await sleep(1000);
  }
  console.log("  advance to the next lesson manually — I'll pick it up…");
  return false;
}

// What's on the results screen? Used for logging (and to confirm we're
// looking at results at all, the way Erik suggested: score + a number).
async function resultsInfo(page) {
  for (const frame of page.frames()) {
    try {
      const info = await frame.evaluate(() => {
        const body = document.body ? document.body.innerText || "" : "";
        const hasContainer = !!document.querySelector(".results, .result-screen, #results");
        const m = body.match(/score[^0-9]{0,12}([0-9][0-9,]*)/i);
        if (!hasContainer && !m) return null;
        return { score: m ? m[1] : null };
      });
      if (info) return info;
    } catch {
      /* next frame */
    }
  }
  return null;
}

export async function runSession(opts = {}) {
  const context = await launch();
  try {
    const page = context.pages()[0] || (await context.newPage());

    const wpm = opts.wpm ?? timing.sessionWpm(config);
    const [minL, maxL] = config.lessonsPerSession;
    const lessonCount = opts.lessons ?? minL + Math.floor(Math.random() * (maxL - minL + 1));

    console.log(`session: ${lessonCount} lesson(s) at ~${wpm.toFixed(0)} wpm`);
    await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });

    let completed = 0;
    let skipped = 0;
    let prevSig = null;
    const zeroRetries = new Map(); // lesson sig -> score-0 retry count
    while (completed < lessonCount) {
      let ctx;
      try {
        ctx = await waitForLesson(page, { notSig: prevSig });
      } catch (e) {
        console.log(`  ${e.message} — ending session.`);
        break;
      }

      let status;
      try {
        status = await doLesson(ctx, page, wpm, completed + 1, lessonCount);
      } catch (e) {
        console.log(`  lesson error (${String(e?.message).split("\n")[0]}) — moving on…`);
        prevSig = await lessonSig(page, ctx).catch(() => null);
        skipped++;
        if (skipped >= 15) {
          console.log("  too many lesson errors in a row — ending session.");
          break;
        }
        await advanceLesson(ctx, page, prevSig);
        continue;
      }
      if (status === "done") {
        // Worthless attempt? Redo it instead of counting it.
        const sig = await lessonSig(page, ctx).catch(() => null);
        if (await maybeRetryZeroScore(page, ctx, sig, zeroRetries)) {
          prevSig = null; // accept the reloaded (same) lesson at loop top
          continue;
        }
        completed++;
        skipped = 0;
      } else if (status === "already-done") {
        completed++;
        skipped = 0;
      } else if (status === "skipped") {
        skipped++;
        if (skipped >= 15) {
          console.log("  too many unsupported activities in a row — ending session.");
          break;
        }
      }
      prevSig = await lessonSig(page, ctx).catch(() => null);

      if (completed === lessonCount) break;

      if (completed % config.longBreakAfterLessons === 0) {
        const ms = timing.longBreakMs(config);
        console.log(`  long break (~${(ms / 60000).toFixed(0)} min)…`);
        await sleep(ms);
      } else {
        const ms = timing.betweenLessonPauseMs(config);
        console.log(`  short break (~${(ms / 1000).toFixed(0)}s)…`);
        await sleep(ms);
      }

      await advanceLesson(ctx, page, prevSig);
      // Loop top: waitForLesson (with notSig) finds the next lesson however we got there.
    }

    console.log(`session complete — ${completed} lesson(s) done.`);
  } finally {
    await context.close();
  }
}
