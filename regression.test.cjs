const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Load source with browser dependencies replaced by local mocks. No website,
// browser installation, account, or network access is required.
function load(file, names, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({ console: { log() {} }, ...globals });
  vm.runInContext(source + '\n globalThis.api = {' + names.join(',') + '};', context);
  return { api: context.api, context };
}
const timing = {
  sleep: async () => {}, lessonStartPauseMs: () => 0,
  keyIntervalMs: () => 0, sessionWpm: () => 72,
  resultsPauseMs: () => 0,
};
const config = { selectors: { nextButton: ['.bad', '.good'] },
  lessonsPerSession: [1, 1], startUrl: 'about:blank', cursorVerify: true };

test('CLI rejects missing, invalid, fractional count, and unknown arguments', async () => {
  const { parseArgs } = await import('../src/cli.js');
  for (const args of [['--wpm'], ['--wpm', 'NaN'], ['--wpm', 'Infinity'],
    ['--wpm', '0'], ['--lessons', '-1'], ['--lessons', '2.5'],
    ['--lessons', '3abc'], ['--oops']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(parseArgs(['--wpm', '52.5', '--lessons', '6']), { wpm: 52.5, lessons: 6 });
  assert.deepEqual(parseArgs(['--help']), { help: true });
});

test('results controls use the first matching Playwright locator', async () => {
  let clicks = 0;
  const frame = { getByRole: () => ({ count: async () => 1,
    first: () => ({ click: async () => { clicks++; } }) }),
    evaluate: async () => { throw new Error('fallback should not run'); } };
  const { api } = load('session.js', ['clickLabeledButton'], { config, timing });
  assert.equal(await api.clickLabeledButton({ frames: () => [frame] }, [/next/i], ['next']), true);
  assert.equal(clicks, 1);
});

test('failed selector clicks allow the next selector to be tried', async () => {
  let clicks = 0;
  const { api } = load('session.js', ['clickAdvance'], { config, timing });
  const frame = { $: async sel => ({ click: async () => {
    if (sel === '.bad') throw new Error('hidden');
    clicks++;
  } }) };
  assert.equal(await api.clickAdvance({ frames: () => [] }, { frame }), true);
  assert.equal(clicks, 1);
});

test('browser closes when initial navigation fails', async () => {
  let closed = false;
  const error = new Error('navigation failed');
  const browser = { pages: () => [{ goto: async () => { throw error; } }],
    close: async () => { closed = true; } };
  const { api } = load('session.js', ['runSession'], { config, timing, launch: async () => browser });
  await assert.rejects(api.runSession(), err => err === error);
  assert.equal(closed, true);
});

test('lesson error attempts navigation instead of waiting on the same lesson', async () => {
  let advanced = false, closed = false;
  const browser = { pages: () => [{ goto: async () => {} }],
    close: async () => { closed = true; } };
  const { api, context } = load('session.js', ['runSession'], { config, timing, launch: async () => browser });
  context.advance = () => { advanced = true; throw new Error('stop test'); };
  vm.runInContext(`waitForLesson = async () => ({});
    doLesson = async () => { throw new Error('lost frame'); };
    lessonSig = async () => 'same-lesson';
    advanceLesson = advance;`, context);
  await assert.rejects(api.runSession(), /stop test/);
  assert.equal(advanced, true);
  assert.equal(closed, true);
});

test('core drills resume at the current position and stop when ended', async () => {
  const pressed = [];
  let index = 2;
  const frame = { evaluate: async fn => {
    const source = fn.toString();
    if (source.includes('c.text')) return { text: 'abcd', index, ended: index >= 3 };
    return null;
  }, click: async () => {} };
  const page = { frames: () => [{ ...frame, url: () => 'https://coreclassictyping.edclub.app/?lesson=1' }],
    keyboard: { press: async ch => { pressed.push(ch); index++; } } };
  const { api } = load('lesson.js', ['typeCoreSequence'], { config, timing });
  await api.typeCoreSequence({ frame }, page, 50);
  assert.deepEqual(pressed, ['c']);
});

test('letter games can fall back to text when the current character is absent', async () => {
  const pressed = [];
  const { api, context } = load('lesson.js', ['typeLetterGame'], { config, timing });
  context.nextState = () => ({ text: 'a', len: 1, index: pressed.length, cur: null, ended: pressed.length > 0 });
  vm.runInContext(`readLetterState = async () => nextState();
    focusGame = async () => true;
    waitForGameAdvance = async () => true;`, context);
  context.timing.maybeTypo = () => null;
  await api.typeLetterGame({ game: 'test' }, { keyboard: { press: async ch => pressed.push(ch) } }, 50);
  assert.deepEqual(pressed, ['a']);
});

test('game state includes the text required by character fallback', async () => {
  const core = { text: 'abc', cur_char_index: 0, cur_char: null, has_ended: false };
  const { api, context } = load('lesson.js', ['readGameState'], { config, timing, window: { core } });
  const frame = { evaluate: async fn => vm.runInContext('(' + fn.toString() + ')()', context) };
  assert.equal((await api.readGameState(frame)).text, 'abc');
});
