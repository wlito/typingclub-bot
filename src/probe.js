#!/usr/bin/env node
// Probe: dumps the REAL activity DOM structure so selectors/typers can be
// built from evidence instead of guesses. Works for prose, keys, AND
// balloon/game activities (which have no lesson text at all).
//
// Usage: npm run probe
//   1. A browser window opens (same stealth profile as the bot).
//   2. Log in, open the activity, do NOT start it.
//   3. Press Enter in this terminal.
//   4. Paste the printed output back.

import readline from "node:readline";
import { launch } from "./browser.js";
import { diagnose } from "./lesson.js";

const ask = (q) =>
  new Promise((res) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(q, (a) => {
      rl.close();
      res(a);
    });
  });

const context = await launch();
try {
const page = context.pages()[0] || (await context.newPage());
await page.goto("https://www.typingclub.com/", { waitUntil: "domcontentloaded" });

await ask(
  "Log in, open the activity AND START IT (game running / balloons visible / text showing),\nthen press Enter here…\n"
);

console.log("=== diagnose ===");
console.log(await diagnose(page));

for (const frame of page.frames()) {
  let furl;
  try {
    furl = frame.url();
  } catch {
    continue;
  }
  if (!furl || furl === "about:blank") continue;

  const dump = await frame
    .evaluate(() => {
      const out = {};

      // --- lesson text (prose/keys), if any ---
      const tokenSels = [".token span.token_unit", ".token_unit", "[class*='token_unit']"];
      out.tokens = {};
      for (const s of tokenSels) {
        try {
          out.tokens[s] = document.querySelectorAll(s).length;
        } catch {
          out.tokens[s] = "err";
        }
      }
      const first = document.querySelector(".token span.token_unit, .token_unit");
      if (first) {
        out.sampleHtml = first.outerHTML.slice(0, 250);
        const chain = [];
        let el = first;
        for (let d = 0; d < 5 && el; d++) {
          const cls = (el.className?.toString?.() || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .join(".");
          chain.push(
            `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${el.id ? "#" + el.id : ""}`
          );
          el = el.parentElement;
        }
        out.parentChain = chain;
      }

      // --- cursor/highlight-ish elements ---
      const cursorish = [];
      document.querySelectorAll("*").forEach((e) => {
        if (cursorish.length >= 25) return;
        const c = (e.className?.toString?.() || "") + " " + (e.id || "");
        if (/sel|cursor|current|active|caret|highlight/i.test(c) && c.trim()) {
          cursorish.push(
            `${e.tagName.toLowerCase()} class="${(e.className?.toString?.() || "").slice(0, 90)}" id="${e.id}" text="${(e.textContent || "").slice(0, 25)}"`
          );
        }
      });
      out.cursorish = cursorish;

      // --- game-ish: single-character leaf elements, grouped by class ---
      // (balloon letters, keycap labels, etc.)
      const groups = new Map();
      let n = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode() && n < 8000) {
        n++;
        const e = walker.currentNode;
        if (e.children.length === 0) {
          const t = (e.textContent || "").trim();
          if (t.length === 1) {
            const r = e.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              const key =
                `${e.tagName.toLowerCase()}.` +
                (e.className?.toString?.() || "").trim().split(/\s+/).join(".");
              if (!groups.has(key)) {
                groups.set(key, {
                  key,
                  count: 0,
                  sampleText: t,
                  rect: {
                    x: Math.round(r.x),
                    y: Math.round(r.y),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                  },
                });
              }
              groups.get(key).count++;
            }
          }
        }
      }
      out.singleCharGroups = [...groups.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 25);

      // --- short multi-char texts (word prompts, labels, "type this") ---
      const tgroups = new Map();
      const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let n2 = 0;
      while (walker2.nextNode() && n2 < 8000) {
        n2++;
        const e = walker2.currentNode;
        if (e.children.length === 0) {
          const t = (e.textContent || "").trim();
          if (t.length >= 2 && t.length <= 16 && /[a-zA-Z]/.test(t)) {
            const key =
              `${e.tagName.toLowerCase()}.` +
              (e.className?.toString?.() || "").trim().split(/\s+/).join(".");
            if (!tgroups.has(key)) tgroups.set(key, { key, count: 0, sampleText: t });
            tgroups.get(key).count++;
          }
        }
      }
      out.shortTexts = [...tgroups.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 25);

      // --- inputs (games often capture keys via a hidden input) ---
      out.inputs = [...document.querySelectorAll("input")].map((i) => ({
        id: i.id,
        cls: String(i.className).slice(0, 60),
        type: i.type,
        value: "[redacted]",
      }));

      // --- window/game internals (for canvas games like the balloon one) ---
      // The game bundle (Oct 2026) shows each game builds the standard
      // typing engine as scene.typingCore, and the engine sets
      // `window.core = this` — so window.core exposes the full sequence,
      // current char and completion. window.approuter carries the lesson
      // activity config.
      const winInfo = { keys: [], found: {} };
      try {
        winInfo.keys = Object.keys(window).slice(0, 200);
        for (const k of ["game", "phaser", "Phaser", "__game", "G", "App", "app", "BalloonGame", "core", "approuter"]) {
          try {
            const v = window[k];
            if (v !== undefined) {
              winInfo.found[k] = {
                type: typeof v,
                preview:
                  v && typeof v === "object"
                    ? Object.keys(v).slice(0, 40)
                    : String(v).slice(0, 120),
              };
            }
          } catch {
            /* ignore */
          }
        }
        try {
          const c = window.core;
          if (c && typeof c.text === "string") {
            winInfo.coreSummary = {
              textLen: c.text.length,
              textHead: c.text.slice(0, 60),
              curIndex: c.cur_char_index,
              curChr: c.cur_char?.chr,
              ended: !!c.has_ended,
              anchorKey: c.anchor_key || null,
              wpm: c.stats?.wpm,
            };
          }
        } catch {
          /* ignore */
        }
        try {
          const g = window.game;
          if (g && g.scene) {
            const scenes = g.scene.scenes || [];
            winInfo.scenes = scenes.map((s) => {
              const list = s.children?.list || [];
              const types = [...new Set(list.map((c) => c.type))].slice(0, 20);
              return {
                key: s.sys?.settings?.key,
                children: list.length,
                childTypes: types,
              };
            });
          }
        } catch (e) {
          winInfo.sceneErr = String(e).slice(0, 150);
        }
      } catch (e) {
        winInfo.error = String(e).slice(0, 150);
      }
      out.window = winInfo;

      out.canvases = [...document.querySelectorAll("canvas")].map((c) => ({
        id: c.id,
        cls: String(c.className).slice(0, 60),
        w: c.width,
        h: c.height,
      }));
      out.topLevel = [...document.body.children]
        .slice(0, 12)
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 50)}#${e.id}`);

      return out;
    })
    .catch((e) => ({ error: String(e).slice(0, 200) }));

  console.log(`\n=== frame: ${furl} ===`);
  console.log(JSON.stringify(dump, null, 2));
}

console.log("\n=== end: paste everything above back ===");
} finally {
  await context.close();
}
