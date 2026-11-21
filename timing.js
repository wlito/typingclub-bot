// Human typing model. Goal: inter-key timing a statistician would shrug at.
//
// Real typing is not a metronome. Intervals follow a right-skewed
// distribution (lognormal-ish), common bigrams are fast, awkward ones slow,
// spaces carry word-boundary pauses, and everyone fat-fingers keys.

function randn() {
  // Box-Muller
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function jitter(sigma) {
  return Math.exp(randn() * sigma);
}

export function sessionWpm(cfg) {
  return Math.max(20, cfg.targetWpm + randn() * cfg.wpmSessionJitter);
}

// QWERTY neighbors, for believable fat-fingers.
const QWERTY_ADJ = {
  q: "wa", w: "qeas", e: "wrsd", r: "etdf", t: "ryfg", y: "tugh",
  u: "yihj", i: "uojk", o: "ipkl", p: "ol", a: "qwsz", s: "awedxz",
  d: "serfcx", f: "drtgvc", g: "ftyhbv", h: "gyujnb", j: "huikmn",
  k: "jiolm", l: "kop", z: "asx", x: "zsdc", c: "xdfv", v: "cfgb",
  b: "vghn", n: "bhjm", m: "njk", ",": "mkl.", ".": ",l;/",
  "/": ".;", ";": "l'/", "'": ";",
};

export function maybeTypo(char, rate) {
  if (Math.random() > rate) return null;
  const adj = QWERTY_ADJ[char.toLowerCase()];
  if (!adj) return null;
  const t = adj[Math.floor(Math.random() * adj.length)];
  if (t === char.toLowerCase()) return null;
  return char === char.toUpperCase() ? t.toUpperCase() : t;
}

export function keyIntervalMs(char, prevChar, wpm, cfg) {
  const base = 60000 / (wpm * 5); // mean ms per character
  let ms = base * jitter(cfg.timingSigma);
  if (char === " ") ms *= 1 + Math.random() * 0.8; // word-boundary pause
  if (char === "\n") ms = 250 + Math.random() * 450; // line-break pause
  if (char !== " " && char === prevChar) ms *= 0.7; // double letters are fast
  return Math.max(cfg.minKeyIntervalMs, ms);
}

export const realizationPauseMs = () => 180 + Math.random() * 320; // "oops"
export const lessonStartPauseMs = () => 1200 + Math.random() * 2500; // "reading"
export const resultsPauseMs = () => 3000 + Math.random() * 4000; // "checking score"

export function betweenLessonPauseMs(cfg) {
  const [a, b] = cfg.breakBetweenLessonsSec;
  return (a + Math.random() * (b - a)) * 1000;
}

export function longBreakMs(cfg) {
  const [a, b] = cfg.longBreakSec;
  return (a + Math.random() * (b - a)) * 1000;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
