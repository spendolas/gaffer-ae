import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadItems } from '../../site/js/media.js';

function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  return fn().finally(() => { globalThis.fetch = real; });
}

// A fetch that never settles unless its signal aborts.
const hangingFetch = (url, { signal } = {}) => new Promise((_, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason));
});

test('loadItemsGivesUpOnAStalledManifest', () => withFetch(hangingFetch, async () => {
  const t0 = Date.now();
  assert.deepEqual(await loadItems('items.json', { timeoutMs: 50 }), []);
  assert.ok(Date.now() - t0 < 1000);
}));

test('loadItemsKeepsValidItems', () => withFetch(async () => ({
  ok: true,
  json: async () => [{ id: 'a', video: 'media/a.mp4' }, { id: 'b' }, null],
}), async () => {
  assert.deepEqual(await loadItems('items.json', { timeoutMs: 50 }), [{ id: 'a', video: 'media/a.mp4' }]);
}));

test('tileMediaCssKeepsTheMediaRules', async () => {
  const { tileMediaCss } = await import('../../site/js/media.js');
  const css = tileMediaCss().replace(/\s+/g, ' ');
  for (const rule of [
    '.card-poster, .card-video {',
    'position: absolute;',
    'inset: 0;',
    'object-fit: cover;',
    'pointer-events: none;',
    '-webkit-user-drag: none;',
    'user-select: none;',
    '-webkit-user-select: none;',
    '.card-video { opacity: 0; transition: opacity 0.3s; }',
    '.card-video.is-playing { opacity: 1; }',
  ]) assert.ok(css.includes(rule), `missing: ${rule}`);
});

// Minimal DOM fakes: enough for the pool to build its poster and video.
function fakeEl(tag) {
  const el = {
    tag, children: [], parent: null, attrs: {}, classes: new Set(), listeners: {},
    paused: true, textContent: '',
    classList: { add: (c) => el.classes.add(c) },
    setAttribute(k, v) { el.attrs[k] = v; },
    removeAttribute(k) { delete el.attrs[k]; },
    addEventListener(t, f) { (el.listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { el.listeners[t] = (el.listeners[t] || []).filter((g) => g !== f); },
    append(...kids) { for (const k of kids) { k.parent = el; el.children.push(k); } },
    prepend(...kids) { for (const k of kids) { k.parent = el; el.children.unshift(k); } },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter((k) => k !== el); el.parent = null; },
    replaceChildren() { el.children = []; },
    pause() { el.paused = true; },
    play() { el.paused = false; return Promise.resolve(); },
    load() {},
  };
  return el;
}

function fakeCard() {
  const card = fakeEl('div');
  card.shadowModes = [];
  card.querySelector = () => { throw new Error('pool must not query the card'); };
  card.attachShadow = ({ mode }) => {
    card.shadowModes.push(mode);
    const root = fakeEl('#shadow-root');
    card.root = root;
    return root;
  };
  return card;
}

async function withFakeDom(fn) {
  const real = globalThis.document;
  globalThis.document = {
    hidden: false,
    createElement: fakeEl,
    addEventListener() {},
    removeEventListener() {},
  };
  try { await fn(); } finally { globalThis.document = real; }
}

test('poolPutsTileMediaInAClosedShadowRoot', () => withFakeDom(async () => {
  const { createVideoPool, tileMediaCss } = await import('../../site/js/media.js');
  const pool = createVideoPool({ max: 2 });
  const card = fakeCard();
  const item = { id: 'a', video: 'media/a.mp4', poster: 'media/a.jpg' };
  pool.register(card, item);
  pool.setVisible([card]);

  assert.deepEqual(card.shadowModes, ['closed']);
  assert.equal(card.children.length, 0, 'nothing in the light DOM');
  // Poster first, video last, so the video fades in over the poster.
  assert.deepEqual(card.root.children.map((k) => k.tag), ['img', 'style', 'video']);
  // No constructable stylesheets in Node: the fallback <style> carries the rules.
  const style = card.root.children.find((k) => k.tag === 'style');
  assert.equal(style.textContent, tileMediaCss());

  // The poster comes from the pool's own reference.
  const img = pool.poster(card);
  assert.equal(img.tag, 'img');
  assert.equal(img.src, 'media/a.jpg');
  assert.equal(img.draggable, false);

  const video = card.root.children.find((k) => k.tag === 'video');
  assert.equal(video.paused, false);
  assert.equal(video.muted, true);
  assert.equal(video.disablePictureInPicture, true);

  // A new item reuses the same root (attachShadow only once per element).
  pool.register(card, { id: 'b', video: 'media/b.mp4', poster: 'media/b.jpg' });
  pool.setVisible([card]);
  assert.deepEqual(card.shadowModes, ['closed']);
  assert.equal(pool.poster(card).src, 'media/b.jpg');

  pool.destroy();
  assert.equal(pool.poster(card), null);
  assert.ok(!card.root.children.some((k) => k.tag === 'img' || k.tag === 'video'));
}));

test('chooseVideoSourcePicksHevcOnlyWhenTheBrowserCanPlayIt', async () => {
  const { chooseVideoSource, HEVC_TYPE } = await import('../../site/js/media.js');
  // Full codec string: Chrome answers '' for a bare "hvc1".
  assert.equal(HEVC_TYPE, 'video/mp4; codecs="hvc1.1.6.L120.90"');
  const item = { id: 'a', video: 'media/a.mp4', hevc: 'media/a.hevc.mp4' };
  const asked = [];
  const answer = (reply) => (type) => { asked.push(type); return reply; };
  assert.equal(chooseVideoSource(item, answer('probably')), 'media/a.hevc.mp4');
  assert.equal(chooseVideoSource(item, answer('maybe')), 'media/a.hevc.mp4');
  assert.equal(chooseVideoSource(item, answer('')), 'media/a.mp4');
  assert.deepEqual(asked, [HEVC_TYPE, HEVC_TYPE, HEVC_TYPE]);
  // No HEVC file: H.264 without asking. No canPlayType at all: H.264.
  assert.equal(chooseVideoSource({ id: 'b', video: 'media/b.mp4' }, answer('probably')), 'media/b.mp4');
  assert.equal(asked.length, 3);
  assert.equal(chooseVideoSource(item, undefined), 'media/a.mp4');
});

test('poolPlaysHevcAndFallsBackToH264OnceOnError', () => withFakeDom(async () => {
  const { createVideoPool } = await import('../../site/js/media.js');
  const realCreate = globalThis.document.createElement;
  let loads = 0;
  globalThis.document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'video') {
      el.canPlayType = (type) => (type === 'video/mp4; codecs="hvc1.1.6.L120.90"' ? 'probably' : '');
      el.load = () => { loads++; el.paused = true; };
    }
    return el;
  };
  const pool = createVideoPool({ max: 2 });
  const card = fakeCard();
  pool.register(card, { id: 'a', video: 'media/a.mp4', hevc: 'media/a.hevc.mp4', poster: 'media/a.jpg' });
  pool.setVisible([card]);

  const video = card.root.children.find((k) => k.tag === 'video');
  const sources = video.children.filter((k) => k.tag === 'source');
  assert.deepEqual(sources.map((s) => s.src), ['media/a.hevc.mp4']);
  assert.equal(video.poster, 'media/a.jpg', 'poster still comes from the H.264 poster');
  assert.equal(video.paused, false);
  assert.equal(loads, 1, 'one load() on attach');

  // The HEVC source fails: switch to H.264, reload, keep playing.
  for (const f of sources[0].listeners.error) f();
  assert.equal(sources[0].src, 'media/a.mp4');
  assert.equal(loads, 2, 'one more load() for the H.264 source');
  assert.equal(video.paused, false);

  // A second error (H.264 broken too) is terminal: the tile gives up at once
  // (poster only, slot freed); a further error does nothing, no loop.
  for (const f of sources[0].listeners.error) f();
  for (const f of video.listeners.error) f();
  assert.equal(video.parent, null, 'video removed');
  assert.equal(loads, 3, 'only the teardown load() on top');
  assert.equal(pool.snapshot().failed[0].id, 'a');
  pool.destroy();
}));

test('poolUsesH264WhenHevcIsUnsupported', () => withFakeDom(async () => {
  const { createVideoPool } = await import('../../site/js/media.js');
  const realCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'video') el.canPlayType = () => '';
    return el;
  };
  const pool = createVideoPool({ max: 2 });
  const card = fakeCard();
  pool.register(card, { id: 'a', video: 'media/a.mp4', hevc: 'media/a.hevc.mp4', poster: 'media/a.jpg' });
  pool.setVisible([card]);
  const video = card.root.children.find((k) => k.tag === 'video');
  assert.deepEqual(video.children.map((s) => s.src), ['media/a.mp4']);
  pool.destroy();
}));

test('poolFallsBackWhenTheHevcDecodeFailsOnTheVideo', () => withFakeDom(async () => {
  const { createVideoPool } = await import('../../site/js/media.js');
  const realCreate = globalThis.document.createElement;
  let loads = 0;
  globalThis.document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'video') {
      el.canPlayType = () => 'probably';
      el.load = () => { loads++; el.paused = true; };
    }
    return el;
  };
  const pool = createVideoPool({ max: 2 });
  const card = fakeCard();
  pool.register(card, { id: 'a', video: 'media/a.mp4', hevc: 'media/a.hevc.mp4', poster: 'media/a.jpg' });
  pool.setVisible([card]);
  const video = card.root.children.find((k) => k.tag === 'video');
  assert.equal(loads, 1, 'one load() on attach');
  for (const f of video.listeners.error) f();
  assert.deepEqual(video.children.map((s) => s.src), ['media/a.mp4']);
  assert.equal(loads, 2);
  assert.equal(video.paused, false);
  for (const f of video.listeners.error) f();
  assert.equal(video.parent, null, 'a decode error on H.264 gives up at once');
  assert.equal(loads, 3, 'teardown only, no reload loop');
  pool.destroy();
}));

test('pushRingKeepsTheNewestEntriesUpToTheCap', async () => {
  const { pushRing, DEBUG_RING } = await import('../../site/js/media.js');
  assert.equal(DEBUG_RING, 30);
  const list = [];
  for (let i = 0; i < 45; i++) pushRing(list, i);
  assert.equal(list.length, 30);
  assert.equal(list[0], 15);
  assert.equal(list[29], 44);
  assert.deepEqual(pushRing([1, 2, 3], 4, 3), [2, 3, 4]);
});

// A video fake with media fields and a counter of addEventListener calls.
function withCountingVideos(fn, { canPlay = 'probably', play } = {}) {
  return withFakeDom(async () => {
    const realCreate = globalThis.document.createElement;
    const videos = [];
    globalThis.document.createElement = (tag) => {
      const el = realCreate(tag);
      if (tag === 'video') {
        Object.assign(el, { readyState: 0, networkState: 0, ended: false, currentTime: 0, duration: NaN, error: null, adds: 0 });
        el.canPlayType = (type) => (type === 'video/mp4; codecs="hvc1.1.6.L120.90"' ? canPlay : '');
        const add = el.addEventListener;
        el.addEventListener = (t, f) => { el.adds++; add(t, f); };
        if (play) el.play = () => play(el);
        videos.push(el);
      }
      return el;
    };
    await fn(videos);
  });
}

const fire = (v, type) => { for (const f of [...(v.listeners[type] || [])]) f({ type }); };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('poolAddsNoDiagnosticsListenersWhileDebugIsOff', () => withCountingVideos(async (videos) => {
  const { createVideoPool, DEBUG_EVENTS } = await import('../../site/js/media.js');
  const pool = createVideoPool({ max: 2 });
  const card = fakeCard();
  pool.register(card, { id: 'a', video: 'media/a.mp4', poster: 'media/a.jpg' });
  pool.setVisible([card]);
  const [v] = videos.filter((x) => x.parent);
  // Production listeners only: the terminal-error give-up, the watchdog's
  // byte-progress flag and the poster-to-video fade.
  assert.equal(v.adds, 3);
  assert.deepEqual(Object.keys(v.listeners), ['error', 'progress', 'playing']);

  pool.setDebug(true);
  assert.equal(v.adds, 3 + DEBUG_EVENTS.length);
  for (const type of DEBUG_EVENTS) assert.ok(v.listeners[type]?.length, `listens to ${type}`);

  pool.setDebug(false);
  for (const type of DEBUG_EVENTS) {
    assert.equal(v.listeners[type]?.length ?? 0, type === 'playing' || type === 'error' ? 1 : 0, `${type} after debug off`);
  }
  assert.equal(v.listeners.progress.length, 1);
  fire(v, 'waiting');
  assert.deepEqual(pool.snapshot().tiles[0].events, [], 'no events while off');
  pool.destroy();
}));

test('snapshotIsJsonSafeAndLogsEventsDecisionsAndPlayOutcomes', () => withCountingVideos(async (videos) => {
  const { createVideoPool, HEVC_TYPE } = await import('../../site/js/media.js');
  const pool = createVideoPool({ max: 1 });
  pool.setDebug(true);
  const a = fakeCard();
  const b = fakeCard();
  pool.register(a, { id: 'a', video: 'media/a.mp4', hevc: 'media/a.hevc.mp4', poster: 'media/a.jpg' });
  pool.register(b, { id: 'b', video: 'media/b.mp4', poster: 'media/b.jpg' });
  pool.setVisible([a, b]);
  await tick();
  const va = a.root.children.find((k) => k.tag === 'video');
  Object.assign(va, { readyState: 4, networkState: 1, currentTime: 1.23456, duration: 3 });
  fire(va, 'loadstart');
  fire(va, 'playing');
  va.error = { code: 3, message: 'decode' };
  fire(va, 'error'); // HEVC decode failure: falls back, and both are logged

  const snap = pool.snapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, 'JSON-safe');
  assert.equal(snap.playingCount, 1);
  assert.equal(snap.elementCount, 2);
  assert.equal(snap.cap, 1);
  assert.equal(snap.budget, 2);
  assert.equal(snap.hevcChosen, true);
  assert.equal(snap.canPlayTypeResult, 'probably');
  assert.equal(typeof snap.userAgent, 'string');
  assert.equal(snap.documentHidden, false);
  assert.ok(HEVC_TYPE);

  const [ta, tb] = snap.tiles;
  assert.deepEqual(Object.keys(ta).sort(), ['currentTime', 'duration', 'ended', 'errorCode', 'events', 'id', 'networkState',
    'paused', 'readyState', 'sourceType', 'src', 'wantsPlay'].sort());
  assert.equal(ta.id, 'a#1');
  assert.equal(ta.sourceType, 'h264', 'after the fallback');
  assert.equal(ta.src, 'media/a.mp4');
  assert.equal(ta.readyState, 4);
  assert.equal(ta.currentTime, 1.23);
  assert.equal(ta.duration, 3);
  assert.equal(ta.errorCode, 3);
  assert.equal(ta.wantsPlay, true);
  // The fallback listener was added first, so it logs before the error itself.
  assert.deepEqual(ta.events.map((e) => e.type).slice(0, 6),
    ['attached hevc', 'play() resolved', 'loadstart', 'playing', 'fell back to H.264', 'error 3: decode']);
  assert.ok(ta.events.every((e) => Number.isInteger(e.t) && e.t >= 0));
  assert.equal(tb.id, 'b#2');
  assert.equal(tb.wantsPlay, false, 'over the cap of 1: a spare');
  assert.equal(tb.duration, null);
  assert.deepEqual(tb.events.map((e) => e.type), ['attached h264']);

  // Ring cap per tile.
  for (let i = 0; i < 50; i++) fire(va, 'waiting');
  assert.equal(pool.snapshot().tiles[0].events.length, 30);

  // A drop is logged on the card even though its video is gone.
  pool.setVisible([a]);
  assert.equal(pool.snapshot().tiles.length, 1);
  assert.ok(videos.length >= 2);
  pool.destroy();
}));

test('snapshotLogsARejectedPlay', () => withCountingVideos(async () => {
  const { createVideoPool } = await import('../../site/js/media.js');
  const pool = createVideoPool({ max: 1 });
  pool.setDebug(true);
  const card = fakeCard();
  pool.register(card, { id: 'a', video: 'media/a.mp4', poster: 'media/a.jpg' });
  pool.setVisible([card]);
  await tick();
  const types = pool.snapshot().tiles[0].events.map((e) => e.type);
  assert.deepEqual(types, ['attached h264', 'play() rejected NotAllowedError: denied', 'play() retry 1 in 500 ms']);
  pool.destroy();
}, {
  canPlay: '',
  play: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
}));

test('pickVideoSourceAndBudgetForFollowTheBisectOverrides', async () => {
  const { pickVideoSource, budgetFor } = await import('../../site/js/media.js');
  const item = { id: 'a', video: 'media/a.mp4', hevc: 'media/a.hevc.mp4' };
  const yes = () => 'probably';
  const no = () => '';
  assert.equal(pickVideoSource(item, yes), 'media/a.hevc.mp4', 'auto by default');
  assert.equal(pickVideoSource(item, no, 'auto'), 'media/a.mp4');
  assert.equal(pickVideoSource(item, yes, 'h264'), 'media/a.mp4');
  assert.equal(pickVideoSource(item, no, 'hevc'), 'media/a.hevc.mp4', 'forced even when canPlayType says no');
  assert.equal(pickVideoSource({ id: 'b', video: 'media/b.mp4' }, yes, 'hevc'), 'media/b.mp4', 'no HEVC file');
  assert.equal(budgetFor(12, 12), 24);
  assert.equal(budgetFor(6, 12), 12);
  assert.equal(budgetFor(2, 12), 4);
  assert.equal(budgetFor(20, 12), 24, 'never above twice the maximum');
});

function cardsWithItems(pool, n, hevc = true) {
  const cards = [];
  for (let i = 0; i < n; i++) {
    const card = fakeCard();
    pool.register(card, { id: `c${i}`, video: `media/c${i}.mp4`, ...(hevc ? { hevc: `media/c${i}.hevc.mp4` } : {}), poster: `media/c${i}.jpg` });
    cards.push(card);
  }
  return cards;
}
const videoOf = (card) => card.root.children.find((k) => k.tag === 'video');

test('setCodecReattachesTheTileVideosWithTheChosenSource', () => withCountingVideos(async () => {
  const { createVideoPool } = await import('../../site/js/media.js');
  const pool = createVideoPool({ max: 2 });
  const cards = cardsWithItems(pool, 3);
  pool.setVisible(cards);
  // Auto, and this browser says no to HEVC.
  assert.deepEqual(cards.map((c) => videoOf(c).children[0].src), ['media/c0.mp4', 'media/c1.mp4', 'media/c2.mp4']);
  pool.setCodec('hevc');
  assert.deepEqual(cards.map((c) => videoOf(c).children[0].src), ['media/c0.hevc.mp4', 'media/c1.hevc.mp4', 'media/c2.hevc.mp4']);
  assert.equal(pool.snapshot().hevcChosen, true);
  const before = videoOf(cards[0]);

  pool.setCodec('h264');
  assert.notEqual(videoOf(cards[0]), before, 'a new element');
  assert.deepEqual(cards.map((c) => videoOf(c).children[0].src), ['media/c0.mp4', 'media/c1.mp4', 'media/c2.mp4']);
  assert.equal(pool.snapshot().playingCount, 2);
  assert.deepEqual(pool.snapshot().overrides, { codec: 'h264', cap: 2, forceLoad: true });
  assert.equal(pool.snapshot().hevcChosen, false);

  pool.setCodec('bogus');
  assert.equal(pool.snapshot().overrides.codec, 'h264', 'invalid value ignored');

  // Forced HEVC keeps the single fallback to H.264 and never loops: the
  // second error is terminal and the tile gives up.
  pool.setCodec('hevc');
  const v = videoOf(cards[0]);
  assert.equal(v.children[0].src, 'media/c0.hevc.mp4');
  for (const f of v.listeners.error) f();
  assert.equal(v.children[0].src, 'media/c0.mp4');
  for (const f of v.listeners.error) f();
  assert.equal(v.parent, null);
  assert.equal(videoOf(cards[0]), undefined, 'not re-attached while it stays in view');
  pool.destroy();
}, { canPlay: '' }));

test('setCapTrimsPlayingAndShrinksTheBudget', () => withCountingVideos(async () => {
  const { createVideoPool } = await import('../../site/js/media.js');
  const pool = createVideoPool({ max: 4 });
  const cards = cardsWithItems(pool, 10, false);
  pool.setVisible(cards);
  let snap = pool.snapshot();
  assert.equal(snap.playingCount, 4);
  assert.equal(snap.elementCount, 8);
  assert.equal(snap.cap, 4);
  assert.equal(snap.budget, 8);

  pool.setCap(2);
  snap = pool.snapshot();
  assert.equal(snap.cap, 2);
  assert.equal(snap.budget, 4);
  assert.equal(snap.playingCount, 2);
  assert.equal(snap.elementCount, 4);
  assert.deepEqual(snap.tiles.filter((t) => t.wantsPlay).map((t) => t.id), ['c0', 'c1'], 'the first cards keep their slots');
  assert.equal(videoOf(cards[2]).paused, true);

  pool.setCap(0);
  pool.setCap(9);
  pool.setCap(2.5);
  assert.equal(pool.snapshot().cap, 2, 'out of range ignored');
  pool.setCap(4);
  assert.equal(pool.snapshot().playingCount, 4);
  assert.equal(pool.snapshot().elementCount, 8);
  pool.destroy();
}));

test('loadIsCalledOncePerAttachAfterTheSourcesAndBeforePlay', () => withFakeDom(async () => {
  const { createVideoPool } = await import('../../site/js/media.js');
  const realCreate = globalThis.document.createElement;
  const calls = [];
  globalThis.document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'video') {
      el.canPlayType = () => '';
      el.load = () => calls.push(`load:${el.children.length}`);
      el.play = () => { calls.push('play'); el.paused = false; return Promise.resolve(); };
    }
    return el;
  };
  const pool = createVideoPool({ max: 1 });
  const [card] = cardsWithItems(pool, 1, false);
  pool.setVisible([card]);
  assert.deepEqual(calls, ['load:1', 'play'], 'on by default: one load() with the source in, then play()');
  assert.equal(pool.snapshot().overrides.forceLoad, true);
  calls.length = 0;
  pool.setForceLoad(false);
  // The old element is torn down (its own load() with no children), the new one skips load().
  assert.deepEqual(calls, ['load:0', 'play']);
  assert.equal(pool.snapshot().overrides.forceLoad, false);
  calls.length = 0;
  pool.setForceLoad(true);
  assert.deepEqual(calls, ['load:0', 'load:1', 'play']);
  pool.destroy();
}));

test('snapshotCarriesTheBrowserFacts', () => withCountingVideos(async () => {
  const { createVideoPool, HEVC_TYPE, AVC_TYPE } = await import('../../site/js/media.js');
  const pool = createVideoPool({ max: 1 });
  const snap = pool.snapshot();
  assert.deepEqual(Object.keys(snap.canPlayType), [HEVC_TYPE, AVC_TYPE, 'video/mp4']);
  assert.equal(snap.canPlayType[HEVC_TYPE], 'probably');
  assert.equal(AVC_TYPE, 'video/mp4; codecs="avc1.640028"');
  for (const key of ['reducedMotion', 'visibilityState', 'effectiveType', 'userAgent', 'devicePixelRatio']) assert.ok(key in snap, key);
  pool.destroy();
}));

// Fake clock for the retry and watchdog timers: advance(ms) runs the due
// timers in time order and lets promise handlers settle after each.
function fakeClock() {
  let now = 0;
  let id = 0;
  const pending = new Map();
  return {
    pending,
    get now() { return now; },
    setTimeout(fn, ms) { pending.set(++id, { fn, at: now + ms, ms }); return id; },
    clearTimeout(i) { pending.delete(i); },
    async advance(ms, each) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [i, timer] of pending) if (timer.at <= end && (!next || timer.at < next[1].at)) next = [i, timer];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        if (each) each(now);
        next[1].fn();
        await tick();
      }
      now = end;
      await tick();
    },
  };
}

const abortError = () => Object.assign(new Error('interrupted by load()'), { name: 'AbortError' });
const notAllowed = () => Object.assign(new Error('denied'), { name: 'NotAllowedError' });

// A document whose visibility can change, and videos that behave like a
// browser's in the two ways that matter here: play() resolves only once
// playback has started (start(v)), and load() rejects a pending play() with
// an AbortError and resets the element. refuse(el) may return an error to
// reject play() with at once. Every load() and play() is logged in el.calls.
async function withTimedPool(fn, { canPlay = 'probably', refuse = () => null } = {}) {
  const real = globalThis.document;
  const visibility = [];
  const doc = {
    hidden: false,
    createElement(tag) {
      const el = fakeEl(tag);
      if (tag === 'video') {
        Object.assign(el, {
          readyState: 0, networkState: 0, ended: false, currentTime: 0, duration: NaN, error: null,
          calls: [], pendingPlays: [], bufEnd: 0, playingNow: false,
        });
        el.buffered = { get length() { return el.bufEnd > 0 ? 1 : 0; }, end: () => el.bufEnd };
        el.canPlayType = (type) => (type === 'video/mp4; codecs="hvc1.1.6.L120.90"' ? canPlay : '');
        el.load = () => {
          el.calls.push(`load:${el.children.length}`);
          for (const p of el.pendingPlays.splice(0)) p.reject(abortError());
          Object.assign(el, { paused: true, readyState: 0, bufEnd: 0, currentTime: 0, playingNow: false, networkState: 1 });
        };
        el.play = () => {
          el.calls.push('play');
          const err = refuse(el);
          if (err) return Promise.reject(err);
          el.paused = false;
          if (el.playingNow) return Promise.resolve();
          return new Promise((resolve, reject) => el.pendingPlays.push({ resolve, reject }));
        };
        el.pause = () => {
          el.paused = true;
          el.playingNow = false;
          for (const p of el.pendingPlays.splice(0)) p.reject(abortError());
        };
      }
      return el;
    },
    addEventListener(type, f) { if (type === 'visibilitychange') visibility.push(f); },
    removeEventListener(type, f) { if (type === 'visibilitychange') visibility.splice(visibility.indexOf(f), 1); },
  };
  globalThis.document = doc;
  const setHidden = (hidden) => { doc.hidden = hidden; for (const f of [...visibility]) f(); };
  try {
    const media = await import('../../site/js/media.js');
    const clock = fakeClock();
    const make = (max) => media.createVideoPool({ max, timers: clock });
    await fn({ make, clock, setHidden, media });
  } finally { globalThis.document = real; }
}

// Playback really starts: data in, pending play() resolves, 'playing' fires.
function start(v) {
  Object.assign(v, { readyState: 4, networkState: 1, bufEnd: Math.max(v.bufEnd, 1), playingNow: true, paused: false });
  for (const p of v.pendingPlays.splice(0)) p.resolve();
  fire(v, 'playing');
}

const plays = (v) => v.calls.filter((c) => c === 'play').length;
const loads = (v) => v.calls.filter((c) => c.startsWith('load')).length;
const SAMPLE = 1000;
const retryTimers = (clock) => [...clock.pending.values()].filter((x) => x.ms !== SAMPLE).map((x) => x.ms);
const eventsOf = (pool, id) => {
  const snap = pool.snapshot();
  const row = snap.tiles.find((x) => x.id.split('#')[0] === id) ?? snap.failed.find((x) => x.id === id);
  return row.events.map((e) => e.type);
};

test('madeProgressCountsReadyStateBufferAndPlaybackWhileLoading', async () => {
  const { madeProgress, WATCH_LADDER, WATCH_SAMPLE_MS, RETRY_DELAYS } = await import('../../site/js/media.js');
  assert.deepEqual(WATCH_LADDER, { nudge: 3, fallBack: 6, giveUp: 10 });
  assert.equal(WATCH_SAMPLE_MS, SAMPLE);
  assert.deepEqual(RETRY_DELAYS, [500, 1500]);
  const at = (o) => ({ readyState: 1, buffered: 0, currentTime: 0, networkState: 1, ...o });
  assert.equal(madeProgress(at(), at()), false, 'nothing moved');
  assert.equal(madeProgress(at(), at({ readyState: 2 })), true);
  assert.equal(madeProgress(at(), at({ buffered: 0.5 })), true);
  assert.equal(madeProgress(at(), at({ currentTime: 0.2, networkState: 2 })), true, 'time moving while loading');
  assert.equal(madeProgress(at(), at({ currentTime: 0.2, networkState: 1 })), false, 'time alone, network idle');
  assert.equal(madeProgress(at({ readyState: 2, buffered: 3 }), at({ readyState: 0, buffered: 0 })), false, 'our own load() reset');
  assert.equal(madeProgress(at(), at({ networkState: 2 })), false, 'loading with nothing arriving');
});

test('everyAttachLoadsOnceBeforePlayIncludingReattachAndCodecChange', () => withTimedPool(async ({ make }) => {
  const pool = make(2);
  const cards = cardsWithItems(pool, 4);
  pool.setVisible(cards.slice(0, 2), cards);
  for (const c of cards) {
    const v = videoOf(c);
    assert.equal(loads(v), 1, 'one load() per attach');
    assert.equal(v.calls[0], 'load:1', 'after the <source> is in');
  }
  assert.deepEqual(videoOf(cards[0]).calls, ['load:1', 'play'], 'load() before play()');
  assert.deepEqual(videoOf(cards[3]).calls, ['load:1'], 'a spare loads (preload none: no download) and never plays');

  // Dropped (out of the padded area) then back: a new element, again one load().
  pool.setVisible(cards.slice(0, 2), cards.slice(0, 3));
  assert.equal(videoOf(cards[3]), undefined);
  pool.setVisible(cards.slice(0, 2), cards);
  assert.deepEqual(videoOf(cards[3]).calls, ['load:1']);

  // A codec change re-attaches with one load() each.
  pool.setCodec('h264');
  for (const c of cards) assert.equal(loads(videoOf(c)), 1);
  assert.equal(videoOf(cards[0]).children[0].src, 'media/c0.mp4');
  pool.destroy();
}));

test('aRefusedPlayIsRetriedTwicePerAttachAndSyncNeverRestartsTheChain', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  pool.setDebug(true);
  const [card] = cardsWithItems(pool, 1, false);
  pool.setVisible([card]);
  const v = videoOf(card);
  await tick();
  assert.equal(plays(v), 1);
  assert.deepEqual(retryTimers(clock), [500]);
  await clock.advance(499);
  assert.equal(plays(v), 1);
  await clock.advance(1);
  assert.equal(plays(v), 2, 'retry 1 at 500 ms');
  assert.deepEqual(retryTimers(clock), [1500]);
  await clock.advance(1500);
  assert.equal(plays(v), 3, 'retry 2 at 1500 ms after the second refusal');
  assert.deepEqual(retryTimers(clock), [], 'no third retry');

  // A later sync plays again but does not open a new retry chain.
  pool.setVisible([card]);
  await tick();
  assert.equal(plays(v), 4);
  assert.deepEqual(retryTimers(clock), []);
  assert.deepEqual(eventsOf(pool, 'c0'), [
    'attached h264',
    'play() rejected NotAllowedError: denied', 'play() retry 1 in 500 ms', 'play() retry 1',
    'play() rejected NotAllowedError: denied', 'play() retry 2 in 1500 ms', 'play() retry 2',
    'play() rejected NotAllowedError: denied', 'play() retries used up',
    'play() rejected NotAllowedError: denied', 'play() retries used up',
  ]);

  // Leaving view and coming back gives a fresh budget.
  pool.setVisible([], [card]);
  pool.setVisible([card]);
  await tick();
  assert.deepEqual(retryTimers(clock), [500]);
  pool.destroy();
  assert.equal(clock.pending.size, 0);
}, { refuse: notAllowed }));

test('anAbortErrorIsNotRetried', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  const [card] = cardsWithItems(pool, 1, false);
  pool.setVisible([card]);
  await tick();
  assert.deepEqual(retryTimers(clock), []);
  await clock.advance(2000);
  assert.equal(plays(videoOf(card)), 1);
  pool.destroy();
}, { refuse: abortError }));

test('ourOwnLoadOnTheNudgeAbortsThePendingPlayWithoutARetry', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  pool.setDebug(true);
  const [card] = cardsWithItems(pool, 1, false);
  pool.setVisible([card]);
  const v = videoOf(card);
  await clock.advance(3 * SAMPLE);
  assert.deepEqual(v.calls, ['load:1', 'play', 'load:1', 'play'], 'nudge at 3 s without progress');
  assert.deepEqual(retryTimers(clock), [], 'the AbortError from our load() is not retried');
  const types = eventsOf(pool, 'c0');
  assert.ok(types.includes('play() rejected AbortError: interrupted by load()'));
  assert.ok(!types.some((x) => x.startsWith('play() retry')));
  // The nudged play() can still start normally.
  start(v);
  await tick();
  assert.equal(clock.pending.size, 0);
  assert.equal(eventsOf(pool, 'c0').at(-1), 'play() resolved');
  pool.destroy();
}));

test('retriesAndWatchdogCancelOnPauseDropAndHiddenAndRearmOnResume', () => withTimedPool(async ({ make, clock, setHidden }) => {
  const pool = make(1);
  const [a, b] = cardsWithItems(pool, 2, false);
  pool.setVisible([a], [a, b]);
  await tick();
  const va = videoOf(a);
  assert.deepEqual(retryTimers(clock), [500]);
  assert.equal(clock.pending.size, 2, 'retry + watchdog');
  // Paused: out of view but still nearby. b gets the slot and its own timers.
  pool.setVisible([b], [a, b]);
  await tick();
  assert.ok(videoOf(a), 'still attached as a spare');
  assert.equal(clock.pending.size, 2, "only b's timers");
  pool.setVisible([], [a, b]);
  assert.equal(clock.pending.size, 0);
  await clock.advance(20000);
  assert.equal(plays(va), 1, 'nothing for a paused tile');

  // Dropped.
  pool.setVisible([a], [a]);
  await tick();
  assert.equal(clock.pending.size, 2);
  pool.setVisible([], []);
  assert.equal(clock.pending.size, 0, 'dropping cancels everything');

  // Hidden, then resumed: the retry budget is per attach, so the next refusal
  // uses the second delay; the watchdog restarts with a fresh count.
  pool.setVisible([a], [a]);
  await tick();
  const v = videoOf(a);
  await clock.advance(2 * SAMPLE);
  setHidden(true);
  assert.equal(clock.pending.size, 0, 'hidden cancels');
  await clock.advance(20000);
  const before = plays(v);
  setHidden(false);
  await tick();
  assert.equal(plays(v), before + 1, 'resume plays again');
  assert.deepEqual(retryTimers(clock), [], 'both retries were used before hiding');
  pool.destroy();
  assert.equal(clock.pending.size, 0);
}, { refuse: notAllowed }));

test('aCapTrimStopsTheTrimmedTilesTimers', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(2);
  const [a, b] = cardsWithItems(pool, 2, false);
  pool.setVisible([a, b]);
  await tick();
  start(videoOf(a));
  await tick();
  assert.deepEqual(retryTimers(clock), [500], "b's retry");
  assert.equal(clock.pending.size, 2, "b's retry and watchdog");
  pool.setCap(1);
  assert.equal(clock.pending.size, 0, 'trimmed b has no timers left');
  pool.destroy();
}, { refuse: (el) => (el.children[0]?.src === 'media/c1.mp4' ? notAllowed() : null) }));

test('watchdogClimbsTheLadderOnNoProgressSecondsAndFreesTheSlot', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  pool.setDebug(true);
  const [a, b] = cardsWithItems(pool, 2);
  pool.setVisible([a, b]);
  const va = videoOf(a);
  const vb = videoOf(b);
  assert.deepEqual(va.calls, ['load:1', 'play']);
  assert.deepEqual(vb.calls, ['load:1'], 'over the cap: no play, no watchdog');
  assert.deepEqual([...clock.pending.values()].map((x) => x.ms), [SAMPLE]);

  await clock.advance(2999);
  assert.equal(va.calls.length, 2);
  await clock.advance(1);
  assert.deepEqual(va.calls, ['load:1', 'play', 'load:1', 'play'], '3 s: load() + play()');
  assert.equal(va.children[0].src, 'media/c0.hevc.mp4');
  await clock.advance(2999);
  assert.equal(va.children[0].src, 'media/c0.hevc.mp4');
  await clock.advance(1);
  assert.equal(va.children[0].src, 'media/c0.mp4', '6 s: H.264 fallback');
  assert.deepEqual(va.calls.slice(4), ['load:1', 'play']);
  await clock.advance(3999);
  assert.ok(va.parent, 'still there at 9.999 s');
  await clock.advance(1);
  assert.equal(va.parent, null, '10 s: given up, element removed');
  assert.equal(videoOf(a), undefined, 'a shows its poster only');
  assert.equal(pool.poster(a).src, 'media/c0.jpg');
  const snap = pool.snapshot();
  assert.deepEqual(snap.failed.map((f) => f.id), ['c0']);
  assert.deepEqual(eventsOf(pool, 'c0'), [
    'attached hevc',
    'watchdog 3s no progress: load() + play()', 'play() rejected AbortError: interrupted by load()',
    'watchdog 6s no progress: fall back to H.264', 'fell back to H.264', 'play() rejected AbortError: interrupted by load()',
    'gave up: no progress for 10s', 'dropped', 'play() rejected AbortError: interrupted by load()',
  ]);
  assert.equal(snap.playingCount, 1);
  assert.deepEqual(snap.tiles.filter((x) => x.wantsPlay).map((x) => x.id.split('#')[0]), ['c1'], 'the slot went to b');
  assert.equal(plays(vb), 1);

  // No loop: while a stays in view it is not retried, whatever syncs happen.
  start(vb);
  await clock.advance(60000);
  pool.setVisible([a, b]);
  await clock.advance(60000);
  assert.equal(videoOf(a), undefined);
  assert.deepEqual(pool.snapshot().failed.map((f) => f.id), ['c0']);
  assert.equal(clock.pending.size, 0);

  // Leaves view and comes back: tried again.
  pool.setVisible([b], [b]);
  assert.deepEqual(pool.snapshot().failed, []);
  pool.setVisible([a, b]);
  assert.ok(videoOf(a), 'attached again on re-entry');
  pool.destroy();
  assert.equal(clock.pending.size, 0, 'no timers left after destroy');
}));

test('aSlowButProgressingDownloadIsNeverNudgedSwitchedOrGivenUp', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  const [card] = cardsWithItems(pool, 1);
  pool.setVisible([card]);
  const v = videoOf(card);
  // A trickle: 0.05 s of media per second, readyState stuck at HAVE_METADATA.
  const trickle = () => { v.networkState = 2; v.readyState = 1; v.bufEnd += 0.05; };
  await clock.advance(40000, trickle);
  assert.deepEqual(v.calls, ['load:1', 'play'], 'no extra load(), no fallback in 40 s');
  assert.equal(v.children[0].src, 'media/c0.hevc.mp4');
  assert.ok(v.parent);

  // The trickle stops: the ladder starts counting from there. Progress after
  // the nudge resets the count but the nudge never repeats.
  await clock.advance(3000);
  assert.equal(loads(v), 2, 'nudge after 3 s without progress');
  await clock.advance(5000, trickle);
  assert.equal(loads(v), 2);
  await clock.advance(5999);
  assert.equal(loads(v), 2, 'no second nudge');
  assert.equal(v.children[0].src, 'media/c0.hevc.mp4');
  await clock.advance(1);
  assert.equal(v.children[0].src, 'media/c0.mp4', 'fallback at 6 s without progress');
  await clock.advance(3999);
  assert.ok(v.parent);
  await clock.advance(1);
  assert.equal(v.parent, null, 'gives up at 10 s without progress');
  pool.destroy();
}));

test('bytesArrivingWhileTheHeaderDownloadsCountAsProgress', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  const [card] = cardsWithItems(pool, 1);
  pool.setVisible([card]);
  const v = videoOf(card);
  // readyState and buffered stay at 0, but 'progress' fires: bytes are coming.
  await clock.advance(30000, () => { v.networkState = 2; fire(v, 'progress'); });
  assert.deepEqual(v.calls, ['load:1', 'play'], 'never nudged, switched or given up');
  assert.ok(v.parent);
  // The bytes stop: the ladder runs from there.
  await clock.advance(3000);
  assert.equal(loads(v), 2);
  pool.destroy();
}));

test('watchdogSkipsTheFallbackForAnH264Tile', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  const [card] = cardsWithItems(pool, 1, false);
  pool.setVisible([card]);
  const v = videoOf(card);
  await clock.advance(3000);
  assert.equal(loads(v), 2);
  await clock.advance(3000);
  assert.equal(loads(v), 2, 'nothing at 6 s');
  assert.equal(v.children[0].src, 'media/c0.mp4');
  await clock.advance(4000);
  assert.equal(videoOf(card), undefined);
  assert.deepEqual(pool.snapshot().failed, [{ id: 'c0', events: [] }], 'no events while debug is off');
  pool.destroy();
}));

test('aTileThatStartedIsNeverEscalatedWhenItRebuffers', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(2);
  const [a, b] = cardsWithItems(pool, 2);
  pool.setVisible([a, b]);
  assert.equal(clock.pending.size, 2);
  const va = videoOf(a);
  start(va);
  assert.equal(clock.pending.size, 1, "'playing' stops a's watchdog at once");
  // Rebuffering after the start: waiting, readyState 2, then a sync.
  va.readyState = 2;
  fire(va, 'waiting');
  pool.setVisible([a, b]);
  await clock.advance(3000);
  await clock.advance(10000);
  await clock.advance(30000);
  assert.deepEqual(va.calls, ['load:1', 'play'], 'no extra load()');
  assert.equal(va.children[0].src, 'media/c0.hevc.mp4', 'no fallback');
  assert.ok(va.parent, 'not given up');
  assert.deepEqual(pool.snapshot().failed.map((f) => f.id), ['c1'], 'only b, which never started');
  pool.setVisible([a]);
  assert.equal(clock.pending.size, 0);
  pool.destroy();
}));

test('aTerminalErrorGivesUpAtOnce', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  const [a, b] = cardsWithItems(pool, 2, false);
  pool.setVisible([a, b]);
  const va = videoOf(a);
  va.error = { code: 4, message: 'unsupported' };
  fire(va, 'error');
  assert.equal(va.parent, null, 'H.264 error: no 10 s wait');
  assert.deepEqual(pool.snapshot().failed.map((f) => f.id), ['c0']);
  assert.ok(plays(videoOf(b)) >= 1, 'the slot went to b');
  pool.destroy();
  assert.equal(clock.pending.size, 0);
}));

test('watchdogStopsWhileHiddenOrPausedAndRestartsWithAFreshCount', () => withTimedPool(async ({ make, clock, setHidden }) => {
  const pool = make(1);
  const [a, b] = cardsWithItems(pool, 2);
  pool.setVisible([a], [a, b]);
  const va = videoOf(a);
  await clock.advance(2000);
  setHidden(true);
  assert.equal(clock.pending.size, 0, 'cleared while hidden');
  await clock.advance(60000);
  assert.equal(loads(va), 1);
  setHidden(false);
  await clock.advance(2999);
  assert.equal(loads(va), 1, 'fresh count on resume');
  await clock.advance(1);
  assert.equal(loads(va), 2);

  // Out of view (paused, kept as a spare): a's watchdog stops; b's starts.
  pool.setVisible([b], [a, b]);
  assert.equal(clock.pending.size, 1);
  pool.destroy();
  assert.equal(clock.pending.size, 0, 'no timers left after destroy');
}));

test('snapshotAsksTheBrowserForCodecAnswersOnlyOnce', () => withTimedPool(async ({ make }) => {
  const pool = make(1);
  pool.snapshot();
  const realCreate = globalThis.document.createElement;
  let made = 0;
  globalThis.document.createElement = (tag) => { if (tag === 'video') made++; return realCreate(tag); };
  for (let i = 0; i < 5; i++) pool.snapshot();
  assert.equal(made, 0, 'no throwaway <video> per refresh');
  pool.destroy();
}));

test('dataReadyButNeverPlayingOnlyRetriesPlayWithoutReloadOrCodecSwitch', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  const [card] = cardsWithItems(pool, 1);
  pool.setVisible([card]);
  const v = videoOf(card);
  // Data is in, play() stays pending, the network is idle.
  Object.assign(v, { readyState: 4, networkState: 1, bufEnd: 1 });
  await clock.advance(1000); // the sample that sees the data arrive is progress; the idle count starts after it
  await clock.advance(3000);
  assert.deepEqual(v.calls, ['load:1', 'play', 'play'], '3 s: play() only, the buffer is kept');
  await clock.advance(3000);
  assert.equal(v.children[0].src, 'media/c0.hevc.mp4', 'no codec switch at 6 s');
  assert.equal(loads(v), 1);
  await clock.advance(3999);
  assert.ok(v.parent, 'still there at 9.999 s');
  await clock.advance(1);
  assert.equal(v.parent, null, 'gives up at 10 s');
  assert.deepEqual(pool.snapshot().failed.map((f) => f.id), ['c0']);
  pool.destroy();
}));

test('noDataAndAnIdleNetworkStillGetsTheLoadAt3sAndTheFallbackAt6s', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  const [card] = cardsWithItems(pool, 1);
  pool.setVisible([card]);
  const v = videoOf(card);
  assert.equal(v.readyState, 0);
  await clock.advance(3000);
  assert.deepEqual(v.calls, ['load:1', 'play', 'load:1', 'play']);
  await clock.advance(3000);
  assert.equal(v.children[0].src, 'media/c0.mp4');
  assert.equal(loads(v), 3);
  pool.destroy();
}));

test('anHevcErrorWhileTheWatchdogRunsGivesTheH264FileAFullLadder', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  const [card] = cardsWithItems(pool, 1);
  pool.setVisible([card]);
  const v = videoOf(card);
  Object.assign(v, { readyState: 3, networkState: 1, bufEnd: 1 }); // ready: no codec switch from the watchdog
  await clock.advance(8000);
  assert.equal(v.children[0].src, 'media/c0.hevc.mp4');
  fire(v, 'error'); // the HEVC decode fails at idle 8 s
  assert.equal(v.children[0].src, 'media/c0.mp4');
  await clock.advance(9999);
  assert.ok(v.parent, 'the old count would have given up by now');
  await clock.advance(1);
  assert.equal(v.parent, null, 'gives up 10 s after the switch, not 2 s after it');
  pool.destroy();
}));

test('aStartedTileWhoseHevcDecodeErrorsFallsBackAndIsThenWatched', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(1);
  const [card] = cardsWithItems(pool, 1);
  pool.setVisible([card]);
  const v = videoOf(card);
  start(v);
  assert.equal(clock.pending.size, 0, 'started: unwatched');
  fire(v, 'error');
  assert.equal(v.children[0].src, 'media/c0.mp4');
  assert.equal(clock.pending.size, 1, 'the H.264 file is watched');
  await clock.advance(10000);
  assert.equal(videoOf(card), undefined, 'and gives up when it never starts');
  pool.destroy();
}));

test('aTrimmedTileThatComesBackStartsWithAFreshRetryBudget', () => withTimedPool(async ({ make, clock }) => {
  const pool = make(2);
  const [a, b] = cardsWithItems(pool, 2, false);
  pool.setVisible([a, b]);
  await tick();
  await clock.advance(2000);
  assert.deepEqual(retryTimers(clock), [], "b's two retries are used up");
  pool.setCap(1);
  pool.setCap(2);
  await tick();
  assert.deepEqual(retryTimers(clock), [500], 'a new retry chain after the trim');
  pool.destroy();
}, { refuse: (el) => (el.children[0]?.src === 'media/c1.mp4' ? notAllowed() : null) }));

test('blobCache: one download per clip, tiles wait on the poster, then play from the blob; a failed download streams', () => withFakeDom(async () => {
  const { createVideoPool } = await import('../../site/js/media.js');
  let fetches = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const clipFetch = async (u) => { fetches++; await gate; return { ok: true, blob: async () => ({ u }) }; };
  const pool = createVideoPool({ max: 4, blobCache: true, clipFetch, makeObjectUrl: (b) => `blob:${b.u}` });
  const c1 = fakeCard();
  const c2 = fakeCard();
  const item = (id) => ({ id, video: 'media/a.mp4', poster: 'media/a.jpg' });
  pool.register(c1, item('1'));
  pool.register(c2, item('2'));
  pool.setVisible([c1, c2]);
  await Promise.resolve();
  assert.equal(c1.root.children.some((k) => k.tag === 'video'), false, 'waiting on the poster');
  assert.equal(fetches, 1, 'one shared download');
  release();
  await new Promise((r) => setTimeout(r, 10));
  for (const c of [c1, c2]) {
    const v = c.root.children.find((k) => k.tag === 'video');
    assert.ok(v, 'attached once the blob is ready');
    assert.deepEqual(v.children.map((s) => s.src), ['blob:media/a.mp4']);
  }
  assert.equal(fetches, 1);
  pool.destroy();

  const bad = createVideoPool({ max: 4, blobCache: true, clipFetch: async () => ({ ok: false }) });
  const c3 = fakeCard();
  bad.register(c3, item('3'));
  bad.setVisible([c3]);
  await new Promise((r) => setTimeout(r, 10));
  const v3 = c3.root.children.find((k) => k.tag === 'video');
  assert.deepEqual(v3.children.map((s) => s.src), ['media/a.mp4'], 'failed download falls back to streaming');
  bad.destroy();
}));

test('new videos start in bursts of 4, the rest a moment later', () => withCountingVideos(async () => {
  const { createVideoPool } = await import('../../site/js/media.js');
  const pool = createVideoPool({ max: 12 });
  const cards = cardsWithItems(pool, 10, false);
  pool.setVisible(cards);
  assert.equal(pool.snapshot().playingCount, 4, 'first burst');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pool.snapshot().playingCount, 10, 'the rest followed');
  pool.destroy();
}));
