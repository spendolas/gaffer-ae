// Manifest loading and the video lifecycle of grid cards.
// Item = { id, video, poster, hevc?, webm?, width, height }, paths relative to site/.

// Loads the generated manifest. Never throws and never hangs: a missing,
// broken or stalled (timeoutMs) manifest gives an empty gallery.
export async function loadItems(url = 'items.json', { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((it) => it && typeof it.video === 'string');
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// HEVC in MP4 with the hvc1 tag (the tag Safari requires), Main profile,
// level 4.0: what add-sample.sh writes for an 800x800 60 fps clip (a 2.4:1
// clip at 60 fps would be 4.1; the probe is a capability check, not a match).
// The full codec string matters: Chrome answers '' for a bare "hvc1" even
// where it plays HEVC.
export const HEVC_TYPE = 'video/mp4; codecs="hvc1.1.6.L120.90"';

// The clip URL to play: the smaller HEVC file when the item has one and the
// browser says it can play it (canPlayType gives '' for no), otherwise H.264.
export function chooseVideoSource(item, canPlayType) {
  if (item.hevc && typeof canPlayType === 'function' && canPlayType(HEVC_TYPE)) return item.hevc;
  return item.video;
}

// Dev bisect override of the codec: 'auto' is chooseVideoSource, 'h264'
// always the H.264 file, 'hevc' the HEVC file whenever the item has one.
export function pickVideoSource(item, canPlayType, codec = 'auto') {
  if (codec === 'h264') return item.video;
  if (codec === 'hevc') return item.hevc || item.video;
  return chooseVideoSource(item, canPlayType);
}

// Live <video> budget for a playing cap: twice the cap, never above twice
// the pool's own maximum.
export function budgetFor(cap, max) {
  return Math.min(2 * max, 2 * cap);
}

// Codec strings the diagnostics snapshot asks the browser about.
export const AVC_TYPE = 'video/mp4; codecs="avc1.640028"';

// Styles for the poster and video inside each card's shadow root. The card
// itself (size, transform, radius, clipping, placeholder fill) is styled by
// site.css; custom properties from :root inherit into the shadow tree.
export function tileMediaCss() {
  return `.card-poster,
.card-video {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  -webkit-user-drag: none;
  user-select: none;
  -webkit-user-select: none;
}
.card-video {
  opacity: 0;
  transition: opacity 0.3s;
}
.card-video.is-playing {
  opacity: 1;
}
`;
}

// Tile media live in a CLOSED shadow root per card, so page scanners
// (document.querySelectorAll('img, video'), MutationObservers on the
// document, elementsFromPoint) never see them and events from inside report
// the card. Closed means card.shadowRoot is null, so the root is held here.
// A card keeps its root for life (attachShadow works once per element).
const roots = new WeakMap(); // card -> ShadowRoot
let sharedSheet; // one constructable stylesheet for every root, when supported

function mediaRoot(card) {
  let root = roots.get(card);
  if (root) return root;
  root = card.attachShadow({ mode: 'closed' });
  if (sharedSheet === undefined) {
    sharedSheet = null;
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(tileMediaCss());
        sharedSheet = sheet;
      }
    } catch { /* fall back to a <style> per root */ }
  }
  if (sharedSheet) {
    root.adoptedStyleSheets = [sharedSheet];
  } else {
    const style = document.createElement('style');
    style.textContent = tileMediaCss();
    root.append(style);
  }
  roots.set(card, root);
  return root;
}

// Diagnostics (setDebug/snapshot, used by the tests and off in the page): the media
// events logged per tile while debug is on, and the ring size per tile.
export const DEBUG_EVENTS = [
  'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'pause',
  'waiting', 'stalled', 'suspend', 'abort', 'emptied', 'error', 'ended',
];
export const DEBUG_RING = 30;

// Appends to a ring buffer of at most `cap` entries, dropping the oldest.
export function pushRing(list, entry, cap = DEBUG_RING) {
  list.push(entry);
  if (list.length > cap) list.splice(0, list.length - cap);
  return list;
}

// Recovery timings (Safari). RETRY_DELAYS: retries after a refused play(),
// at most two per attach. The stall watchdog samples a tile that has not
// started playing every WATCH_SAMPLE_MS and counts the seconds in a row with
// no progress (readyState up, buffered end up, or currentTime moving while
// the network is loading, or a 'progress' event: bytes arrived, which is
// the only sign of life while the header is still downloading and readyState
// and buffered have not moved yet); at WATCH_LADDER.nudge it calls load() + play()
// once (only play() when the data is ready, readyState >= 3: the buffer is
// good, so no load() and no codec switch), at .fallBack the single HEVC to H.264 switch, at .giveUp it gives up
// (slot released, tile 'failed' until it leaves and re-enters view). Progress
// resets the count, never the one-shot nudge and fallback.
export const RETRY_DELAYS = [500, 1500];
export const WATCH_SAMPLE_MS = 1000;
export const WATCH_LADDER = Object.freeze({ nudge: 3, fallBack: 6, giveUp: 10 });
const NETWORK_LOADING = 2;

// End of the last buffered range in seconds (0 when nothing is buffered).
function bufferedEnd(v) {
  try {
    const b = v.buffered;
    return b && b.length ? b.end(b.length - 1) : 0;
  } catch {
    return 0;
  }
}

// Did the video make progress between two samples { readyState, buffered,
// currentTime, networkState }? A readyState drop (our own load()) is not.
export function madeProgress(prev, now) {
  if (now.readyState > prev.readyState) return true;
  if (now.buffered > prev.buffered) return true;
  return now.networkState === NETWORK_LOADING && now.currentTime > prev.currentTime;
}

// The browser's codec answers never change: asked once, on first snapshot.
let canPlayCache = null;

// Every card shows its poster. Cards in the padded visible area get a <video>
// (sources attached, nothing downloaded until it plays), up to a budget of
// 2 x max elements, and lose it when they leave. Only cards in view play, at
// most `max` at once; playing cards keep their slot while they stay in view,
// free slots go to the cards the grid lists first (it lists them nearest the
// centre first). Everything pauses while the tab is hidden. Under reduced
// motion no video is ever created.
// Safari does not start resource selection for <source> children appended to
// a preload="none" video, so every attach calls load() once before play().
// A refused play() is retried (RETRY_DELAYS) and a tile that does not start
// and stops progressing climbs the watchdog ladder (WATCH_LADDER). A tile
// whose video has fired 'playing' is never escalated: rebuffering after the
// start is the browser's job. `timers` is injectable for tests.
// blobCache: download each clip once into memory and play every tile from it (see clipSource).
// clipFetch / makeObjectUrl are injectable for tests.
const ATTACH_BURST = 4; // new videos attached per sync
const ATTACH_GAP_MS = 40; // before the next burst
export function createVideoPool({ max = 12, reducedMotion = () => false, timers, blobCache = false, clipFetch = (u) => fetch(u), makeObjectUrl = (b) => URL.createObjectURL(b) } = {}) {
  const t = timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
  let cap = max; // playing cap; setCap (dev bisect) lowers it
  let budget = budgetFor(cap, max); // live <video> elements, playing ones included
  let codec = 'auto'; // setCodec (dev bisect)
  let forceLoad = true; // load() after the sources; setForceLoad(false) (dev bisect) skips it
  // card -> { item, img, video, src (the clip URL attached), fallBack (the
  // one-shot HEVC to H.264 switch, or null), retryTimer, watchTimer, failed,
  // and per attach: started ('playing' fired), attempts (play retries used),
  // nudged (watchdog load() used), fetched ('progress' since the last sample) }
  const state = new Map();
  const playing = new Set();
  let visible = new Set();
  let near = new Set();
  // While the grid is moving fast (setBusy), no new <video> is created or started: starting decoders
  // mid-scroll is what drops the frame rate on phones. Tiles keep their poster until it settles.
  let busy = false;
  let burstTimer = null;
  // Each clip is downloaded once into memory (a Blob) and every tile plays from that blob URL. Browsers
  // drop a removed <video>'s media buffer, so without this a tile that leaves and re-enters the grid, or
  // a second tile showing the same clip, would download it again. A tile waits on its poster until its
  // clip's blob is ready (one shared download), then attaches instantly with no network.
  // clip URL -> { status: 'loading' | 'ready' | 'failed', blobUrl }. Skipped (plain streaming) where
  // fetch or object URLs are missing, or after a failed download.
  const blobs = new Map();
  let closed = false;
  function clipSource(url) {
    if (!blobCache) return { src: url, wait: false };
    let e = blobs.get(url);
    if (!e) {
      e = { status: 'loading', blobUrl: null };
      blobs.set(url, e);
      Promise.resolve().then(() => clipFetch(url)).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((b) => { e.blobUrl = makeObjectUrl(b); e.status = 'ready'; }, () => { e.status = 'failed'; })
        .finally(() => { if (!closed) sync(); });
    }
    if (e.status === 'ready') return { src: e.blobUrl, wait: false };
    return { src: url, wait: e.status === 'loading' };
  }
  // Dev diagnostics, null unless setDebug(true): { t0, logs: card -> entries,
  // handlers: video -> [card, listener], ids: card -> number, next }.
  let debug = null;

  function register(card, item) {
    let s = state.get(card);
    if (!s) {
      s = {
        item: undefined, img: null, video: null, src: null, fallBack: null, retryTimer: null, watchTimer: null,
        failed: false, started: false, attempts: 0, nudged: false, fetched: false, idle: 0, last: null,
      };
      state.set(card, s);
    }
    if (s.item === item) return;
    dropVideo(card, s);
    s.item = item;
    s.failed = false;
    if (item && item.poster) {
      if (!s.img) {
        s.img = document.createElement('img');
        s.img.className = 'card-poster';
        s.img.alt = '';
        s.img.decoding = 'async';
        s.img.draggable = false;
        mediaRoot(card).prepend(s.img);
      }
      s.img.src = item.poster;
    } else if (s.img) {
      s.img.remove();
      s.img = null;
    }
    if (near.has(card)) sync();
  }

  function unregister(card) {
    const s = state.get(card);
    if (!s) return;
    dropVideo(card, s);
    if (s.img) s.img.remove();
    state.delete(card);
    debug?.logs.delete(card);
  }

  // visible: cards in view, in priority order. nearby: cards in the padded
  // visible area (defaults to visible).
  function setVisible(cards, nearby = cards) {
    visible = new Set(cards);
    near = new Set(nearby);
    for (const c of visible) near.add(c);
    sync();
  }

  function attach(card, s) {
    if (s.video || !s.item) return;
    const v = document.createElement('video');
    v.className = 'card-video';
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'none';
    v.disablePictureInPicture = true;
    v.draggable = false;
    v.disableRemotePlayback = true;
    v.setAttribute('disablepictureinpicture', '');
    v.setAttribute('disableremoteplayback', '');
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    if (s.item.poster) v.poster = s.item.poster;
    if (s.item.webm) v.append(source(s.item.webm, 'video/webm'));
    const item = s.item;
    const chosen = pickVideoSource(item, v.canPlayType && ((t) => v.canPlayType(t)), codec);
    const clip = clipSource(chosen);
    if (clip.wait) return; // the shared download is running; sync() runs again when it ends
    s.src = chosen;
    s.fallBack = null;
    s.started = false;
    s.attempts = 0;
    s.nudged = false;
    const mp4 = source(clip.src, 'video/mp4');
    // A browser can claim HEVC and still fail on the file: a failed fetch or
    // unsupported file errors on the <source>, a decode failure (no decoder)
    // errors on the <video>. Either way switch to H.264 once, never back; an
    // error on H.264 (first choice or after the switch) is terminal: give up
    // at once instead of holding a slot. (Compare the chosen URL, not
    // mp4.src, which the browser makes absolute.)
    let fellBack = chosen === item.video;
    if (!fellBack) {
      s.fallBack = () => {
        if (fellBack || s.video !== v) return;
        fellBack = true;
        mp4.src = clipSource(item.video).src;
        s.src = item.video;
        s.started = false;
        if (debug) note(card, 'fell back to H.264');
        v.load();
        if (playing.has(card) && !document.hidden) play(card, v);
      };
    }
    const onError = () => {
      if (s.video !== v) return;
      if (!fellBack) {
        // The H.264 file gets a full ladder: a running watchdog restarts its
        // count, a tile that had started (a mid-playback decode error) is armed.
        s.fallBack();
        if (s.watchTimer !== null) { s.idle = 0; s.last = sample(v); s.fetched = false; } else if (wants(card, v)) armWatch(card, s);
      } else giveUp(card, s, 'error on H.264');
    };
    mp4.addEventListener('error', onError);
    v.addEventListener('error', onError);
    v.addEventListener('progress', () => { if (s.video === v) s.fetched = true; });
    v.append(mp4);
    if (forceLoad) v.load();
    v.addEventListener('playing', () => {
      v.classList.add('is-playing');
      if (s.video !== v) return;
      s.started = true;
      clearWatch(s);
    });
    mediaRoot(card).append(v);
    s.video = v;
    if (debug) {
      note(card, `attached ${chosen === item.video ? 'h264' : 'hevc'}`);
      listen(card, v);
    }
  }

  function dropVideo(card, s) {
    playing.delete(card);
    stopTimers(s);
    const v = s.video;
    if (!v) return;
    if (debug) { unlisten(v); note(card, 'dropped'); }
    v.pause();
    v.replaceChildren();
    v.removeAttribute('src');
    v.load();
    v.remove();
    s.video = null;
  }

  function sync() {
    const reduced = reducedMotion();
    for (const [card, s] of state) {
      if (!visible.has(card)) s.failed = false; // left view: may try again on re-entry
      if (reduced || !near.has(card)) dropVideo(card, s);
    }
    if (reduced) return;
    for (const card of playing) {
      if (!visible.has(card)) {
        playing.delete(card);
        const s = state.get(card);
        if (s) { stopTimers(s); s.attempts = 0; } // a fresh retry budget on re-entry
        if (s && s.video) s.video.pause();
      }
    }
    // New videos start in small bursts: the rest follow a moment later, so a row of tiles entering at once
    // never spins up all its decoders in one frame.
    let started = 0;
    for (const card of busy ? [] : visible) {
      if (playing.size >= cap) break;
      const s = state.get(card);
      if (!s || !s.item || s.failed) continue;
      if (!s.video && started >= ATTACH_BURST) { if (burstTimer === null) burstTimer = t.setTimeout(() => { burstTimer = null; sync(); }, ATTACH_GAP_MS); continue; }
      const had = !!s.video;
      attach(card, s);
      if (!s.video) continue; // still waiting for its clip
      if (!had) started++;
      playing.add(card);
    }
    // Warm spares for the cards next in line, within the budget. Browsers cap
    // live media elements (Chrome on Android at a few dozen), so a big grid
    // never gets one <video> per card.
    const order = [...visible, ...[...near].filter((c) => !visible.has(c))];
    let count = 0;
    for (const s of state.values()) if (s.video) count++;
    for (const card of busy ? [] : order) {
      if (count >= budget) break;
      const s = state.get(card);
      if (s && s.item && !s.video && !s.failed) { attach(card, s); count++; }
    }
    for (let i = order.length - 1; i >= 0 && count > budget; i--) {
      const s = state.get(order[i]);
      if (s && s.video && !playing.has(order[i])) { dropVideo(order[i], s); count--; }
    }
    for (const card of playing) {
      const s = state.get(card);
      const v = s.video;
      if (document.hidden) {
        stopTimers(s); // re-armed with fresh clocks by the sync on resume
        v.pause();
        continue;
      }
      if (v.paused && s.retryTimer === null) play(card, v);
      if (!s.started) armWatch(card, s);
    }
  }

  // Does the pool still want this element playing?
  function wants(card, v) {
    return playing.has(card) && state.get(card)?.video === v && !document.hidden;
  }

  function stopTimers(s) {
    if (s.retryTimer !== null) { t.clearTimeout(s.retryTimer); s.retryTimer = null; }
    clearWatch(s);
  }

  function clearWatch(s) {
    if (s.watchTimer !== null) { t.clearTimeout(s.watchTimer); s.watchTimer = null; }
  }

  // play(). An AbortError comes from our own pause/load/source change and is
  // ignored; any other refusal is retried RETRY_DELAYS later while the tile
  // still wants to play, at most RETRY_DELAYS.length times per attach (a
  // later sync may call play() again, but never restarts the retry chain).
  // With debug on, every outcome is logged.
  function play(card, v) {
    const p = v.play();
    if (!p || typeof p.then !== 'function') return;
    p.then(() => { if (debug) note(card, 'play() resolved'); }, (err) => {
      const name = err?.name ?? 'Error';
      if (debug) note(card, `play() rejected ${name}: ${err?.message ?? ''}`);
      if (name === 'AbortError') return;
      const s = state.get(card);
      if (!s || !wants(card, v) || s.retryTimer !== null) return;
      if (s.attempts >= RETRY_DELAYS.length) {
        if (debug) note(card, 'play() retries used up');
        return;
      }
      const delay = RETRY_DELAYS[s.attempts++];
      const n = s.attempts;
      if (debug) note(card, `play() retry ${n} in ${delay} ms`);
      s.retryTimer = t.setTimeout(() => {
        s.retryTimer = null;
        if (!wants(card, v) || !v.paused) return;
        if (debug) note(card, `play() retry ${n}`);
        play(card, v);
      }, delay);
    });
  }

  function sample(v) {
    return { readyState: v.readyState, buffered: bufferedEnd(v), currentTime: v.currentTime || 0, networkState: v.networkState };
  }

  // Frees the slot, the decoder and any stuck fetch; the tile shows its
  // poster and is skipped until it leaves view and comes back.
  function giveUp(card, s, why) {
    if (debug) note(card, `gave up: ${why}`);
    dropVideo(card, s);
    s.failed = true;
    sync();
  }

  // Stall watchdog for a wanted tile that has not started playing: samples
  // every WATCH_SAMPLE_MS and climbs WATCH_LADDER on seconds in a row
  // without progress. Stops on 'playing', when the tile is no longer wanted,
  // or on give-up; sync re-arms it with a fresh count.
  function armWatch(card, s) {
    if (s.watchTimer !== null || s.started) return;
    const v = s.video;
    s.idle = 0;
    s.last = sample(v);
    s.fetched = false;
    const tick = () => {
      s.watchTimer = null;
      if (!wants(card, v) || s.started) return;
      const now = sample(v);
      let idle = s.idle = madeProgress(s.last, now) || s.fetched ? 0 : s.idle + 1;
      s.fetched = false;
      s.last = now;
      // Data ready but playback never started (play() refused or pending):
      // the buffer is good, so only play() is retried; no load(), no codec switch.
      const ready = v.readyState >= 3;
      if (idle >= WATCH_LADDER.giveUp) {
        giveUp(card, s, `no progress for ${idle}s`);
        return;
      }
      if (idle >= WATCH_LADDER.fallBack && !ready && s.fallBack && s.src !== s.item.video) {
        if (debug) note(card, `watchdog ${idle}s no progress: fall back to H.264`);
        s.fallBack();
        s.last = sample(v);
      } else if (idle >= WATCH_LADDER.nudge && !s.nudged && !v.error) {
        s.nudged = true;
        if (debug) note(card, `watchdog ${idle}s no progress: ${ready ? 'play() only (data ready)' : 'load() + play()'}`);
        if (s.retryTimer !== null) { t.clearTimeout(s.retryTimer); s.retryTimer = null; }
        if (!ready) v.load();
        play(card, v);
        s.last = sample(v);
      }
      s.watchTimer = t.setTimeout(tick, WATCH_SAMPLE_MS);
    };
    s.watchTimer = t.setTimeout(tick, WATCH_SAMPLE_MS);
  }

  // Dev bisect overrides. Each re-evaluates the pool at once; the live page
  // never calls them, so it keeps auto, the full cap and load() on attach.
  function reattachAll() {
    for (const [card, s] of state) {
      s.failed = false;
      if (s.video) dropVideo(card, s);
    }
    sync();
  }
  function setCodec(next) {
    if (!['auto', 'h264', 'hevc'].includes(next) || next === codec) return;
    codec = next;
    reattachAll();
  }
  function setForceLoad(on) {
    if (Boolean(on) === forceLoad) return;
    forceLoad = Boolean(on);
    reattachAll();
  }
  function setCap(n) {
    if (!Number.isInteger(n) || n < 1 || n > max || n === cap) return;
    cap = n;
    budget = budgetFor(cap, max);
    for (const card of [...playing].slice(cap)) {
      playing.delete(card);
      const s = state.get(card);
      if (s) { stopTimers(s); s.attempts = 0; } // a fresh retry budget when it comes back
      s?.video?.pause();
    }
    sync();
  }

  function note(card, type) {
    let log = debug.logs.get(card);
    if (!log) debug.logs.set(card, (log = []));
    pushRing(log, { t: Math.round(performance.now() - debug.t0), type });
  }

  function listen(card, v) {
    const handler = (e) => {
      if (e.type !== 'error') return note(card, e.type);
      const err = v.error;
      note(card, err ? `error ${err.code}: ${err.message || ''}` : 'error (source)');
    };
    debug.handlers.set(v, handler);
    for (const type of DEBUG_EVENTS) v.addEventListener(type, handler);
  }

  function unlisten(v) {
    const handler = debug.handlers.get(v);
    if (!handler) return;
    for (const type of DEBUG_EVENTS) v.removeEventListener(type, handler);
    debug.handlers.delete(v);
  }

  // Dev only. On: log media events, play() outcomes and pool decisions per
  // tile. Off: remove every diagnostics listener and free the logs.
  function setDebug(on) {
    if (on && !debug) {
      debug = { t0: performance.now(), logs: new Map(), handlers: new Map(), ids: new WeakMap(), next: 1 };
      for (const [card, s] of state) if (s.video) listen(card, s.video);
    } else if (!on && debug) {
      for (const v of [...debug.handlers.keys()]) unlisten(v);
      debug = null;
    }
  }

  // Dev only, JSON-safe: one entry per tile that holds a <video>, plus the
  // pool's totals and the browser facts that decide the codec.
  function snapshot() {
    const tiles = [];
    for (const [card, s] of state) {
      const v = s.video;
      if (!v) continue;
      let n = debug?.ids.get(card);
      if (debug && !n) debug.ids.set(card, (n = debug.next++));
      tiles.push({
        id: `${s.item.id ?? '?'}${n ? `#${n}` : ''}`,
        sourceType: s.src === s.item.video ? 'h264' : 'hevc',
        src: s.src,
        readyState: v.readyState,
        networkState: v.networkState,
        paused: v.paused,
        ended: v.ended,
        currentTime: Math.round((v.currentTime || 0) * 100) / 100,
        duration: Number.isFinite(v.duration) ? v.duration : null,
        errorCode: v.error ? v.error.code : null,
        wantsPlay: playing.has(card),
        events: debug ? [...(debug.logs.get(card) ?? [])] : [],
      });
    }
    // Tiles the watchdog gave up on (no <video> until they re-enter view).
    const failed = [];
    for (const [card, s] of state) {
      if (s.failed) failed.push({ id: s.item?.id ?? '?', events: debug ? [...(debug.logs.get(card) ?? [])] : [] });
    }
    if (!canPlayCache) {
      canPlayCache = { hevc: '', avc: '', mp4: '' };
      try {
        const v = document.createElement('video');
        if (v.canPlayType) {
          canPlayCache.hevc = v.canPlayType(HEVC_TYPE);
          canPlayCache.avc = v.canPlayType(AVC_TYPE);
          canPlayCache.mp4 = v.canPlayType('video/mp4');
        }
      } catch { /* leave the answers empty */ }
    }
    const can = canPlayCache;
    let reducedMotion = null;
    try { reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* no matchMedia */ }
    return {
      playingCount: playing.size,
      elementCount: tiles.length,
      cap,
      budget,
      overrides: { codec, cap, forceLoad },
      hevcChosen: codec === 'hevc' || (codec === 'auto' && Boolean(can.hevc)),
      canPlayTypeResult: can.hevc,
      canPlayType: { [HEVC_TYPE]: can.hevc, [AVC_TYPE]: can.avc, 'video/mp4': can.mp4 },
      reducedMotion,
      visibilityState: document.visibilityState ?? null,
      effectiveType: globalThis.navigator?.connection?.effectiveType ?? null,
      userAgent: globalThis.navigator?.userAgent ?? '',
      devicePixelRatio: globalThis.devicePixelRatio ?? 1,
      documentHidden: Boolean(document.hidden),
      debug: Boolean(debug),
      failed,
      tiles,
    };
  }

  function setBusy(on) {
    if (busy === Boolean(on)) return;
    busy = Boolean(on);
    if (!busy) sync();
  }

  const onVisibility = () => sync();
  document.addEventListener('visibilitychange', onVisibility);

  function destroy() {
    setDebug(false);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const card of [...state.keys()]) unregister(card);
    closed = true;
    if (burstTimer !== null) { t.clearTimeout(burstTimer); burstTimer = null; }
    for (const e of blobs.values()) if (e.blobUrl) globalThis.URL?.revokeObjectURL?.(e.blobUrl);
    blobs.clear();
    visible = new Set();
    near = new Set();
  }

  // The card's poster <img> (or null). The shadow root is closed, so callers
  // ask the pool instead of querying the card.
  function poster(card) {
    const s = state.get(card);
    return s ? s.img : null;
  }

  return { register, unregister, setVisible, sync, destroy, poster, setDebug, snapshot, setCodec, setCap, setForceLoad, setBusy };
}

function source(src, type) {
  const el = document.createElement('source');
  el.src = src;
  el.type = type;
  return el;
}
