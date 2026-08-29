(function () {
  var cs = new CSInterface();

  // Single source of truth for the Claude Code install docs — referenced by both
  // the sign-in caption link and the no-CLI modal's "Learn how" button, so the
  // URL lives in exactly one place.
  var CLAUDE_CODE_DOCS_URL = 'https://code.claude.com/docs/en/quickstart#step-1-install-claude-code';
  function openClaudeCodeDocs() {
    try { cs.openURLInDefaultBrowser(CLAUDE_CODE_DOCS_URL); } catch (e) { /* no host bridge */ }
  }

  // SVG icon helper — GafferIcons comes from icons.js (generated from Figma)
  function icon(name, cls) {
    var span = document.createElement('span');
    span.className = 'gicon' + (cls ? ' ' + cls : '');
    span.innerHTML = (typeof GafferIcons !== 'undefined' && GafferIcons[name]) || '';
    return span;
  }
  var ws = null;
  var reconnectDelay = 1000;
  var maxDelay = 30000;
  var WS_URL = 'ws://127.0.0.1:9823';

  // DOM elements
  var ledEl = document.getElementById('led');
  var statusWrapEl = document.getElementById('statusWrap');
  var lastJsxEl = document.getElementById('lastJsx');
  var lastResultEl = document.getElementById('lastResult');
  var chatMessagesEl = document.getElementById('chatMessages');
  var chatInputEl = document.getElementById('chatInput');
  var sendBtnEl = document.getElementById('sendBtn');
  var stopBtnEl = document.getElementById('stopBtn');
  var clearBtnEl = document.getElementById('clearBtn');
  // Model/variant/effort selects live in the Settings modal (the source of
  // truth); the modal drives currentModel/currentVariant/currentEffort directly.
  var modelSelectBtnEl = document.getElementById('setModelBtn');
  var modelSelectLabelEl = document.getElementById('setModelLabel');
  var modelSelectPopupEl = document.getElementById('setModelPopup');
  var moreLabelEl = document.getElementById('moreLabel');
  var moreChevronEl = document.getElementById('moreChevron');
  var mcpListEl = document.getElementById('mcpList');
  // Version now lives in the Settings modal (#setVersion is the source of truth);
  // loadVersion/detectDevInstall write straight to it.
  var versionTextEl = document.getElementById('setVersion');
  var updateBannerEl = document.getElementById('updateBanner');
  var updateTextEl = document.getElementById('updateText');
  var updateBtnEl = document.getElementById('updateBtn');
  var dismissUpdateBtnEl = document.getElementById('dismissUpdateBtn');
  var pastePreviewRowEl = document.getElementById('pastePreviewRow');
  var dropOverlayEl = document.getElementById('dropOverlay');
  var lightboxEl = document.getElementById('imgLightbox');
  var lightboxImgEl = lightboxEl ? lightboxEl.querySelector('img') : null;
  var alertModalEl = document.getElementById('alertModal');
  var alertModalTitleEl = document.getElementById('alertModalTitle');
  var alertModalBodyEl = document.getElementById('alertModalBody');
  var alertModalOkEl = document.getElementById('alertModalOk');
  var alertModalCancelEl = document.getElementById('alertModalCancel');

  // Full-screen takeover fade — fade-in-up on open, fade-out-down on close.
  // Elements keep the `hidden` attr (display:none) semantics; tkShow/tkHide wrap
  // it so the CSS transition (.tk-anim / .tk-card) plays. On close we hold the
  // element visible for the exit transition, then set hidden.
  function tkShow(el) {
    if (!el) return;
    el.hidden = false;
    el.classList.remove('tk-closing');
    void el.offsetWidth; // commit the closed state so adding tk-open transitions
    el.classList.add('tk-open');
  }
  function tkHide(el) {
    if (!el || el.hidden || el.classList.contains('tk-closing')) return;
    el.classList.remove('tk-open');
    el.classList.add('tk-closing');
    var done = function () {
      el.hidden = true;
      el.classList.remove('tk-closing');
    };
    var t = setTimeout(done, 240); // fallback if transitionend doesn't fire
    el.addEventListener('transitionend', function h(ev) {
      if (ev.target !== el) return; // the backdrop's own opacity transition
      clearTimeout(t);
      el.removeEventListener('transitionend', h);
      done();
    });
  }
  function tkOpen(el) { return el && !el.hidden && !el.classList.contains('tk-closing'); }
  // Dismiss a takeover only on a genuine click IN the void: the press AND the
  // release must both land on `el` itself (the backdrop), not its card. A plain
  // 'click' listener misfires here — the DOM fires click on the nearest common
  // ancestor of mousedown/mouseup, so a press inside the card that drifts onto
  // the backdrop resolves its click to the backdrop and would dismiss. Gating on
  // the mousedown target (tracked via both pointerdown and mousedown for CEP's
  // Chromium 99, which emits only MouseEvents for real HID) fixes that.
  // anyTarget=false (modals): press AND release must both land on the backdrop
  // itself. anyTarget=true (lightbox): a genuine click on any one element (image
  // or void) closes, but a drag that starts on one element and releases on
  // another does not — so image-click-to-close survives while drag-dismiss dies.
  function dismissOnBackdrop(el, closeFn, anyTarget) {
    if (!el) return;
    var downTarget = null;
    function markDown(e) { downTarget = e.target; }
    el.addEventListener('pointerdown', markDown);
    el.addEventListener('mousedown', markDown);
    el.addEventListener('click', function (e) {
      var sameTarget = downTarget === e.target;
      var ok = anyTarget ? sameTarget : (sameTarget && e.target === el);
      downTarget = null;
      if (ok) closeFn(e);
    });
  }

  // Chat state
  var currentSessionId = null;
  var chatBusy = false;
  var authLoggedIn = null; // null = unknown/indeterminate, true/false once daemon reports
  var chatHistory = []; // { role: 'user'|'assistant', text: string }
  var currentModel = 'opus';
  var currentVariant = 'standard'; // 'standard' | '1m' (context-window variant)
  var currentEffort = 'high'; // low | medium | high | xhigh | max
  var autoCheckUpdates = true;
  var autoModel = false; // off by default; persisted in chat-history.json
  var dismissedUpdateCommit = null;
  var availableUpdateCommit = null; // independent of whether its banner was dismissed
  var enabledMcps = []; // server IDs (from `claude mcp list`) user enabled for chat
  var availableMcps = []; // [{id, displayName, status}]
  var mcpUsage = {}; // { id: { count, last } } — sends count, enables stamp recency
  var mcpListError = null; // daemon-reported error from last list_mcps
  var pendingAuthId = null; // server id with an mcp login flow in flight
  var pendingImages = []; // [{path, dataUrl, name}] — staged for next send
  var PASTE_PREFIX = 'gaffer-paste-';
  var MAX_PASTE_FILES = 10;
  var THUMB_MAX_EDGE = 512;

  // AE host info — getHostEnvironment may return either a JSON string or
  // an already-parsed object depending on CEP version.
  var hostEnv = (function () {
    try {
      var raw = cs.getHostEnvironment();
      if (typeof raw === 'string') return JSON.parse(raw);
      if (raw && typeof raw === 'object') return raw;
      return {};
    } catch (e) { return {}; }
  })();
  var rawVer = hostEnv.appVersion || '';
  var aeVersion = rawVer ? String(rawVer).split('x')[0] : 'unknown';
  console.log('Gaffer: AE version =', aeVersion, 'host =', hostEnv.appName);

  // Panel bg follows the AE UI theme (brightness slider) instead of the
  // fixed design token, so Gaffer matches native panels.
  function applyHostSkin() {
    try {
      var raw = cs.getHostEnvironment();
      var env = typeof raw === 'string' ? JSON.parse(raw) : raw;
      var c = env && env.appSkinInfo && env.appSkinInfo.panelBackgroundColor && env.appSkinInfo.panelBackgroundColor.color;
      if (!c) return;
      var triplet = Math.round(c.red) + ', ' + Math.round(c.green) + ', ' + Math.round(c.blue);
      document.documentElement.style.setProperty('--color-bg-panel', 'rgb(' + triplet + ')');
      // fader's transparent knot tracks the same color at alpha 0
      document.documentElement.style.setProperty('--color-bg-panel-0', 'rgba(' + triplet + ', 0)');
    } catch (e) { /* keep token fallback */ }
  }
  applyHostSkin();
  cs.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, applyHostSkin);

  // Chat scrolls behind the input area by half its height — keep the
  // --input-h var in sync as the textarea grows / paste row toggles.
  (function () {
    var area = document.querySelector('.chat-input-area');
    var row = document.querySelector('.chat-input-row');
    if (!area || !row) return;
    function syncInputH() {
      document.documentElement.style.setProperty('--input-h', area.offsetHeight + 'px');
      document.documentElement.style.setProperty('--row-h', row.offsetHeight + 'px');
    }
    syncInputH();
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(syncInputH);
      ro.observe(area);
      ro.observe(row);
    }
  })();

  // Daemon auto-start state
  var daemonStartAttempted = false;
  var wasConnected = false;

  // ── Status ──

  function setStatus(state, text) {
    ledEl.className = 'led' + (state === 'connected' ? ' connected' : state === 'starting' ? ' starting' : '');
    if (statusWrapEl) statusWrapEl.title = text || state; // star-only status: text is the tooltip
    // Figma InputRow state matrix: offline shows a bare panel-colored
    // button + "Gaffer" placeholder; connected shows the italic prompt.
    var offline = state !== 'connected';
    chatInputEl.classList.toggle('offline', offline);
    sendBtnEl.classList.toggle('offline', offline);
    chatInputEl.placeholder = offline ? 'Gaffer' : 'Ask Gaffer...';
    updateChatEnabled();
  }

  // Chat input/send are enabled only once both the daemon is connected AND
  // (per Task 6 auth wiring) the user is not known to be signed out — an
  // indeterminate authLoggedIn (null, before the first auth_status reply)
  // must NOT lock the chat out.
  function updateChatEnabled() {
    var connected = ledEl.classList.contains('connected');
    var ok = connected && authLoggedIn !== false;
    var hasContent = chatInputEl.value.trim().length > 0 || replyQuotes.length > 0;
    chatInputEl.disabled = !ok;                             // input: connected+auth only — preserve type-ahead while busy
    sendBtnEl.disabled = !ok || chatBusy || !hasContent;   // nothing to send = disabled (Figma send State=Disabled @ .4)
    sendBtnEl.classList.toggle('typed', hasContent);       // kept in sync as the "has content" style hook
    // NOTE: the composer's own centered/bottom-aligned text state is NOT
    // driven by hasContent — it's driven by whether the field has actually
    // wrapped to 2+ lines (see .wrapped, toggled in resizeChatInput). A
    // single typed line stays centered exactly like the placeholder.
  }

  // ── Auth ──

  var lastAuth = {}; // last auth_status payload — feeds the Settings CLI card

  // Account / API — SCAFFOLD ONLY. No real key is ever stored/handled here;
  // `key` is a static masked placeholder for visual review. status:
  // 'nokey' (no key added yet) | 'disconnected' (key present, not connected) |
  // 'connected' (key present, connected). Defaults to 'nokey' to match the
  // already-parity-verified default render (see renderApi() for the 3 states).
  var apiState = { status: 'nokey', key: 'sk-ant-…4f2a', provider: 'Bedrock' };
  // Internal preview only: the API settings scaffold is hidden in shipping UI.
  // Enable it in a development panel with:
  //   localStorage.setItem('gafferDevApiSettings', '1')
  // The audit flag also reveals it for the parity-capture harness.
  try {
    var apiSettingsItem = document.getElementById('setApiSettingsItem');
    if (apiSettingsItem) {
      apiSettingsItem.hidden = localStorage.getItem('gafferDevApiSettings') !== '1'
        && localStorage.getItem('gafferAudit') !== '1';
    }
  } catch (e) { /* localStorage blocked → keep the internal card hidden */ }
  function renderApi() {
    var keyEl = document.getElementById('setApiKey');
    var metaEl = document.getElementById('setApiMeta');
    var connectBtn = document.getElementById('setApiConnectBtn');
    var forgetBtn = document.getElementById('setApiForgetBtn');
    if (!keyEl || !metaEl || !connectBtn || !forgetBtn) return;
    if (apiState.status === 'nokey') {
      keyEl.textContent = 'Bring you API key';
      metaEl.textContent = 'From the Anthropic console';
      metaEl.classList.add('dim'); // Multiline subtitle role, #777 — see .item-sub.dim
      // Icon-only, Purpose=Default (grey) button — Figma 516:42191, Icon=Ethernet (516:44855).
      connectBtn.className = 'icon-btn';
      connectBtn.title = 'Add key';
      connectBtn.textContent = '';
      connectBtn.appendChild(icon('ethernet'));
      forgetBtn.hidden = true;
    } else {
      keyEl.textContent = apiState.key;
      metaEl.textContent = apiState.provider ? 'API • ' + apiState.provider : 'API';
      metaEl.classList.remove('dim'); // Secondary label role here, base #666 is correct
      // Connect = Purpose=Informed (blue); Disconnect = Purpose=Default (grey) — Figma 516:43487.
      connectBtn.className = apiState.status === 'connected' ? 'text-btn' : 'text-btn informed';
      connectBtn.removeAttribute('title');
      connectBtn.textContent = apiState.status === 'connected' ? 'Disconnect' : 'Connect';
      forgetBtn.hidden = false;
    }
  }
  function renderAuth(s) {
    lastAuth = s || {};
    authLoggedIn = (typeof s.loggedIn === 'boolean') ? s.loggedIn : null;
    var card = document.getElementById('signInCard');
    var signedOut = authLoggedIn === false;
    if (card) card.classList.toggle('visible', signedOut);
    if (card) { card.hidden = false; } // display controlled by .visible
    // The account identity now lives in the Settings modal's CLI card (fed from
    // lastAuth via syncSettings); refresh it if the modal is open.
    if (typeof settingsModalEl !== 'undefined' && settingsModalEl && tkOpen(settingsModalEl)) syncSettings();
    updateChatEnabled();
  }

  // ── Daemon auto-start ──

  function spawnViaNode() {
    // Direct Node spawn — works on Apple Silicon AE where system.callSystem
    // silently fails. Returns true on success, false if Node integration
    // unavailable (legacy CEP context).
    if (typeof require === 'undefined') return false;
    try {
      var cp = require('child_process');
      var fs = require('fs');
      var extPath = cs.getSystemPath(SystemPath.EXTENSION);
      var daemonDir = extPath + '/daemon';
      var isWin = process.platform === 'win32';

      var nodeBin = null;
      var candidates = isWin
        ? []
        : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
      for (var i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) { nodeBin = candidates[i]; break; } } catch (e) {}
      }
      if (!nodeBin) nodeBin = isWin ? 'node' : '/usr/bin/env';
      var args = (nodeBin === '/usr/bin/env') ? ['node', 'index.js'] : ['index.js'];

      var logPath = isWin
        ? (process.env.TEMP || 'C:\\Windows\\Temp') + '\\gaffer-daemon.log'
        : '/tmp/gaffer-daemon.log';
      var out = fs.openSync(logPath, 'a');

      var child = cp.spawn(nodeBin, args, {
        cwd: daemonDir,
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
      });
      child.on('error', function (e) { console.error('Gaffer: daemon spawn error', e); });
      child.unref();
      console.log('Gaffer: daemon spawned via Node, pid=' + child.pid + ' bin=' + nodeBin);
      return true;
    } catch (e) {
      console.error('Gaffer: spawnViaNode failed:', e);
      return false;
    }
  }

  function spawnViaExtendScript() {
    // Fallback for CEP contexts without Node integration.
    var extPath = cs.getSystemPath(SystemPath.EXTENSION);
    var jsx = '(function() {'
      + 'var isWin = $.os.indexOf("Windows") !== -1;'
      + 'var dir = "' + extPath.replace(/\\/g, '/') + '/daemon";'
      + 'if (isWin) {'
      + '  return system.callSystem("powershell -ExecutionPolicy Bypass -File \\"" + dir + "/start.ps1\\"");'
      + '} else {'
      + '  return system.callSystem("bash \\"" + dir + "/start.sh\\"");'
      + '}'
      + '})()';
    cs.evalScript(jsx, function (result) {
      console.log('Gaffer: daemon spawn via ExtendScript: ' + result);
    });
  }

  function startDaemon() {
    if (daemonStartAttempted) return;
    daemonStartAttempted = true;
    setStatus('starting', 'Starting daemon...');

    // Prefer Node spawn (works on Apple Silicon). Fall back to ExtendScript
    // system.callSystem if Node integration isn't available.
    if (!spawnViaNode()) {
      spawnViaExtendScript();
    }
  }

  // ── WebSocket ──

  // ── Reply sounds — synthesized 'gaffer' cues, no asset files ──
  // Lamp-on = relay click + warm tungsten bloom (reply ready).
  // Breaker-trip = dull click + downward whump (error).
  var soundEnabled = false; // off by default; persisted in chat-history.json
  var textScale = 1; // chat reading-surface scale (A-/A+ stepper); persisted
  var TEXT_MIN = 0.8, TEXT_MAX = 1.6, TEXT_STEP = 0.1;
  var audioCtx = null;
  function ac() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function noiseBurst(ctx, seconds) {
    var buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }
  function playSqueakClean() {
    // SQUEAK: two friction chirps ("e-EEK") — pitch glide + fast shallow
    // vibrato + slight tremolo through a resonant band.
    var ctx = ac();
    var t = ctx.currentTime + 0.01;
    var out = ctx.createGain();
    out.gain.value = 0.42;
    out.connect(ctx.destination);
    function chirp(t0, dur, f0, f1, amp) {
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f0, t0);
      osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.7);
      osc.frequency.linearRampToValueAtTime(f1 * 0.92, t0 + dur);
      var vib = ctx.createOscillator();
      vib.type = 'sine';
      vib.frequency.value = 34;
      var vibGain = ctx.createGain();
      vibGain.gain.value = f0 * 0.035;
      vib.connect(vibGain); vibGain.connect(osc.frequency);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 2.2;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(amp, t0 + 0.02);
      g.gain.setValueAtTime(amp, t0 + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      var trem = ctx.createOscillator();
      trem.type = 'sine'; trem.frequency.value = 26;
      var tremGain = ctx.createGain();
      tremGain.gain.value = amp * 0.3;
      trem.connect(tremGain); tremGain.connect(g.gain);
      osc.connect(bp); bp.connect(g); g.connect(out);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
      vib.start(t0); vib.stop(t0 + dur + 0.02);
      trem.start(t0); trem.stop(t0 + dur + 0.02);
    }
    chirp(t, 0.09, 820, 1150, 0.16);
    chirp(t + 0.13, 0.2, 980, 1600, 0.2);
  }

  function playCreakTurning() {
    // TURNING CREAK: creak = SLOW stick-slip (you hear individual grabs),
    // squeak = fast. Slip pulses at ~70-170/s, rate rising with the turn
    // and sagging at the stop, ringing low inharmonic metal modes.
    var ctx = ac();
    var t = ctx.currentTime + 0.01;
    var out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(ctx.destination);
    var dur = 0.55;
    // slip source: saw at grab-rate -> waveshaped into sharp pulses
    var drive = ctx.createOscillator();
    drive.type = 'sawtooth';
    drive.frequency.setValueAtTime(70, t);
    drive.frequency.linearRampToValueAtTime(170, t + dur * 0.6); // turn speeds up
    drive.frequency.linearRampToValueAtTime(90, t + dur);        // eases to a stop
    var jit = noiseBurst(ctx, dur + 0.1);
    var jitLp = ctx.createBiquadFilter();
    jitLp.type = 'lowpass'; jitLp.frequency.value = 12;
    var jitG = ctx.createGain();
    jitG.gain.value = 26; // grabs are uneven
    jit.connect(jitLp); jitLp.connect(jitG); jitG.connect(drive.frequency);
    jit.start(t);
    var shaper = ctx.createWaveShaper();
    var curve = new Float32Array(1024);
    for (var i = 0; i < 1024; i++) {
      var x = i / 1023;
      curve[i] = x > 0.6 ? (x - 0.6) / 0.4 : 0; // wider slip pulse = audible energy
    }
    shaper.curve = curve;
    // makeup gain — sparse pulses through high-Q bands lose ~20dB
    // (measured offline: this lands peak ~0.33)
    var makeup = ctx.createGain();
    makeup.gain.value = 10;
    shaper.connect(makeup);
    // low metal body
    var modes = [[480, 8, 1.0], [1150, 12, 0.6], [2100, 16, 0.28]];
    var env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.55, t + 0.06);
    env.gain.setValueAtTime(0.5, t + dur - 0.08);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    env.connect(out);
    for (var m = 0; m < modes.length; m++) {
      var res = ctx.createBiquadFilter();
      res.type = 'bandpass';
      res.frequency.value = modes[m][0];
      res.Q.value = modes[m][1];
      var mg = ctx.createGain();
      mg.gain.value = modes[m][2];
      makeup.connect(res); res.connect(mg); mg.connect(env);
    }
    drive.connect(shaper);
    drive.start(t); drive.stop(t + dur + 0.05);
  }

  var WALKIE_VARIANTS = {
    a: { band: [1500, 0.6], close: 0.24, bed: 0,
         blips: [[0.035, 1560, 0.07, 0.5], [0.125, 1170, 0.09, 0.45]] },
    b: { band: [1100, 1.0], close: 0.27, bed: 0.05,
         blips: [[0.04, 1250, 0.08, 0.5], [0.14, 940, 0.1, 0.45]] },
    c: { band: [1800, 0.7], close: 0.14, bed: 0,
         blips: [[0.03, 1760, 0.06, 0.5]] },
    // d = the sign-off: c's dry radio voice but the blip steps DOWN and out,
    // so disabling reads as the inverse of c's single up-chirp.
    d: { band: [1500, 0.7], close: 0.16, bed: 0,
         blips: [[0.03, 1500, 0.05, 0.5], [0.085, 1000, 0.07, 0.42]] },
  };
  function playWalkie(variant, gainScale) {
    // WALKIE: on-set radio "copy that" — squelch opens (tiny noise puff),
    // talk-permit chirp in radio band, squelch closes.
    var v = WALKIE_VARIANTS[variant] || WALKIE_VARIANTS.a;
    var ctx = ac();
    var t = ctx.currentTime + 0.01;
    var out = ctx.createGain();
    out.gain.value = 0.4 * (gainScale || 1);
    out.connect(ctx.destination);
    // radio voicing: everything through a band-limited channel
    var radio = ctx.createBiquadFilter();
    radio.type = 'bandpass'; radio.frequency.value = v.band[0]; radio.Q.value = v.band[1];
    radio.connect(out);
    function squelch(t0, amp) {
      var n = noiseBurst(ctx, 0.03);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1200;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(amp, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03);
      n.connect(hp); hp.connect(g); g.connect(radio);
      n.start(t0);
    }
    function blip(t0, freq, dur, amp) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(amp, t0 + 0.008);
      g.gain.setValueAtTime(amp, t0 + dur - 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(radio);
      osc.start(t0); osc.stop(t0 + dur + 0.01);
    }
    // static bed while the channel is open (v.bed = 0 disables)
    if (v.bed) {
      var bed = noiseBurst(ctx, v.close + 0.03);
      var bedLp = ctx.createBiquadFilter();
      bedLp.type = 'lowpass'; bedLp.frequency.value = 3000;
      var bedG = ctx.createGain();
      bedG.gain.setValueAtTime(0.0001, t);
      bedG.gain.linearRampToValueAtTime(v.bed, t + 0.01);
      bedG.gain.setValueAtTime(v.bed, t + v.close);
      bedG.gain.exponentialRampToValueAtTime(0.0001, t + v.close + 0.03);
      bed.connect(bedLp); bedLp.connect(bedG); bedG.connect(radio);
      bed.start(t);
    }
    squelch(t, 0.5); // channel opens
    for (var b = 0; b < v.blips.length; b++) {
      blip(t + v.blips[b][0], v.blips[b][1], v.blips[b][2], v.blips[b][3]);
    }
    squelch(t + v.close, 0.35); // channel closes
  }

  function playBreakerTrip() {
    var ctx = ac();
    var t = ctx.currentTime + 0.01;
    var out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(ctx.destination);
    // dull contact click (+ a quieter bounce)
    for (var c = 0; c < 2; c++) {
      var click = noiseBurst(ctx, 0.01);
      var lpc = ctx.createBiquadFilter();
      lpc.type = 'lowpass'; lpc.frequency.value = 900;
      var cg = ctx.createGain();
      var ct = t + c * 0.055;
      cg.gain.setValueAtTime(c === 0 ? 0.45 : 0.18, ct);
      cg.gain.exponentialRampToValueAtTime(0.001, ct + 0.014);
      click.connect(lpc); lpc.connect(cg); cg.connect(out);
      click.start(ct);
    }
    // power-down whump — falling sine, closing filter
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t + 0.01);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.2);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t + 0.01);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.22);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.32, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(lp); lp.connect(g); g.connect(out);
    osc.start(t + 0.01); osc.stop(t + 0.3);
  }
  // Walkie rolls: A carries the cue, B answers once every 4th play so the
  // radio doesn't wear a groove in your ear.
  var walkiePlays = 0;
  function playWalkieRolling() {
    walkiePlays++;
    playWalkie(walkiePlays % 4 === 0 ? 'b' : 'a');
  }
  var SOUND_CANDIDATES = [
    { id: 'walkie', label: 'Walkie', play: playWalkieRolling },
    { id: 'creak', label: 'Drunk Gaffer', play: playCreakTurning },
    { id: 'squeak', label: 'Hot Points', play: playSqueakClean },
  ];
  var soundVariant = 'squeak'; // Hot Points — default cue; persisted selection
  // quiet radio tick for MCP tile enable/disable — direct interaction
  // feedback, so it plays regardless of panel focus (still respects the
  // Sound toggle)
  function playMcpTick(on) {
    if (!soundEnabled) return;
    // key-up (c) when enabling, sign-off (d) when disabling
    try { playWalkie(on ? 'c' : 'd', 0.11); } catch (e) { /* audio unavailable */ }
  }
  function playSelectedCue() {
    var c = SOUND_CANDIDATES[0];
    for (var i = 0; i < SOUND_CANDIDATES.length; i++) if (SOUND_CANDIDATES[i].id === soundVariant) c = SOUND_CANDIDATES[i];
    c.play();
  }
  // unattended cap: after 3 cues with zero user activity the panel goes
  // quiet — nobody's machine squeaks all night. Any focus/click/keypress
  // re-arms it.
  var unattendedCues = 0;
  window.addEventListener('focus', function () { unattendedCues = 0; });
  document.addEventListener('pointerdown', function () { unattendedCues = 0; });
  document.addEventListener('keydown', function () { unattendedCues = 0; });
  function playReplySound(kind) {
    if (!soundEnabled) return;
    // the cue exists for when you're elsewhere — silent while focused
    try { if (document.hasFocus()) return; } catch (e) { /* play anyway */ }
    if (unattendedCues >= 3) return;
    unattendedCues++;
    try { kind === 'error' ? playBreakerTrip() : playSelectedCue(); } catch (e) { /* audio unavailable */ }
  }
  // preview hook (drawer toggle + tuning sessions) — bypasses the focus
  // gate but still respects the Sound toggle
  window.__gafferSound = function (kind) {
    if (!soundEnabled) return;
    try {
      if (kind === 'error') { playBreakerTrip(); return; }
      for (var i = 0; i < SOUND_CANDIDATES.length; i++) {
        if (SOUND_CANDIDATES[i].id === kind) { SOUND_CANDIDATES[i].play(); return; }
      }
      playSelectedCue();
    } catch (e) {}
  };

  // ── Chat persistence (via ExtendScript file I/O) ──

  var chatFilePath = cs.getSystemPath(SystemPath.EXTENSION) + '/chat-history.json';

  function saveChat() {
    var data = JSON.stringify({
      messages: chatHistory,
      sessionId: currentSessionId,
      model: currentModel,
      variant: currentVariant,
      effort: currentEffort,
      autoCheckUpdates: autoCheckUpdates,
      autoModel: autoModel,
      soundEnabled: soundEnabled,
      soundVariant: soundVariant,
      textScale: textScale,
      dismissedUpdateCommit: dismissedUpdateCommit,
      enabledMcps: enabledMcps,
      mcpUsage: mcpUsage,
    });
    // Prefer Node fs — handles large payloads (image dataUrls) reliably.
    // Fall back to ExtendScript File I/O for legacy CEP without mixed-context.
    if (typeof require !== 'undefined') {
      try {
        require('node:fs').writeFileSync(chatFilePath, data, 'utf8');
        return;
      } catch (e) { /* fall through */ }
    }
    var escaped = data.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    var jsx = "(function() {"
      + "var f = new File('" + chatFilePath.replace(/'/g, "\\'") + "');"
      + "f.open('w'); f.write('" + escaped + "'); f.close();"
      + "return 'ok';"
      + "})()";
    cs.evalScript(jsx);
  }

  function restoreChat() {
    function applyData(data) {
        // Restore settings (text size, sound, model, ...) even with no chat
        // history — they must not depend on messages existing.
        if (!data) return;
        currentSessionId = data.sessionId || null;
        chatHistory = data.messages || [];
        if (data.model) {
          currentModel = data.model;
          updateModelSelect();
          // Restoring a model must re-resolve the per-model effort list —
          // otherwise the dot count stays whatever the pre-restore default
          // was until the next 'models' message happens to arrive.
          applyEffortsForModel();
        }
        if (data.variant) {
          // migrate the short-lived 'latest' naming
          currentVariant = data.variant === 'latest' ? 'standard' : data.variant;
          updateVariantSelect();
        }
        if (data.effort) {
          currentEffort = data.effort;
        }
        // Always (re)render once model/effort restore is settled, even if
        // data.model/data.effort were both absent — keeps the dot count and
        // active dot consistent with currentModel/currentEffort as restored.
        renderEffort();
        if (typeof data.autoCheckUpdates === 'boolean') {
          autoCheckUpdates = data.autoCheckUpdates;
          var acEl = document.getElementById('setAutoCheck'); if (acEl) acEl.checked = autoCheckUpdates;
        }
        if (typeof data.autoModel === 'boolean') {
          autoModel = data.autoModel;
          var scEl = document.getElementById('setScrooge'); if (scEl) scEl.checked = autoModel;
        }
        if (typeof data.soundEnabled === 'boolean') {
          soundEnabled = data.soundEnabled;
          var soEl = document.getElementById('setSoundOn'); if (soEl) soEl.checked = soundEnabled;
        }
        if (typeof data.soundVariant === 'string') {
          soundVariant = data.soundVariant;
          if (soundVariant.indexOf('walkie') === 0) soundVariant = 'walkie';
          if (soundVariant === 'barn-door' || soundVariant === 'tape' || soundVariant === 'c47' || soundVariant === 'scrim') soundVariant = 'squeak';
          soundSelect.update();
        }
        if (typeof data.textScale === 'number') {
          textScale = data.textScale;
          applyTextScale();
        }
        if (data.dismissedUpdateCommit) {
          dismissedUpdateCommit = data.dismissedUpdateCommit;
          // Dismissed means "hide the banner", not "forget the update".
          // Preserve the Settings safeguard across panel reloads, including
          // when automatic checks are disabled.
          availableUpdateCommit = data.dismissedUpdateCommit;
        }
        if (Array.isArray(data.enabledMcps)) {
          enabledMcps = data.enabledMcps.slice();
        }
        if (data.mcpUsage && typeof data.mcpUsage === 'object') {
          mcpUsage = data.mcpUsage;
        }
        for (var i = 0; i < chatHistory.length; i++) {
          var msg = chatHistory[i];
          if (msg.role === 'user') {
            chatMessagesEl.appendChild(buildUserMessageEl(msg.text, msg.images, msg.quotes));
          } else {
            var div = document.createElement('div');
            div.className = 'chat-msg assistant';
    div.setAttribute('data-fig', '176:931'); // Bubble role=assistant
            var textSpan = document.createElement('span');
            textSpan.className = 'msg-text';
            textSpan.dataset.raw = msg.text;
            textSpan.innerHTML = renderMarkdown(msg.text);
            div.appendChild(textSpan);
            addCopyButton(div);
            chatMessagesEl.appendChild(div);
          }
        }
        scrollToBottom();
    }

    // Prefer Node fs — handles large payloads (image dataUrls) reliably.
    if (typeof require !== 'undefined') {
      try {
        var fs = require('node:fs');
        if (fs.existsSync(chatFilePath)) {
          var raw = fs.readFileSync(chatFilePath, 'utf8');
          if (raw) applyData(JSON.parse(raw));
        }
        return;
      } catch (e) { /* fall through to ExtendScript */ }
    }

    var jsx = "(function() {"
      + "var f = new File('" + chatFilePath.replace(/'/g, "\\'") + "');"
      + "if (!f.exists) return '';"
      + "f.open('r'); var d = f.read(); f.close();"
      + "return d;"
      + "})()";
    cs.evalScript(jsx, function (result) {
      if (!result || result === 'undefined' || result === 'EvalScript_ErrMessage') return;
      try {
        applyData(JSON.parse(result));
      } catch (e) { /* corrupt data, ignore */ }
    });
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
  }

  // Swap the copy icon for a check for 1.5s
  function copyFeedback(btn) {
    btn.innerHTML = '';
    btn.appendChild(icon('check'));
    setTimeout(function () {
      btn.innerHTML = '';
      btn.appendChild(icon('copy'));
    }, 1500);
  }

  function evalScriptAsync(code) {
    return new Promise(function (resolve) {
      cs.evalScript(code, function (result) {
        if (result === 'EvalScript_ErrMessage') {
          resolve({ ok: false, error: 'EvalScript error', line: null });
        } else {
          resolve(result);
        }
      });
    });
  }

  function handleMessage(evt) {
    try {
      var msg = JSON.parse(evt.data);

      // ── Typed messages (chat protocol) ──
      if (msg.type === 'chat_chunk') {
        appendChatChunk(msg.text);
        return;
      }
      if (msg.type === 'chat_result') {
        // Final full result — only use if no chunks were streamed
        var el = document.getElementById('currentResponse');
        if (el && el.textContent === '') {
          el.textContent = msg.text;
        }
        return;
      }
      if (msg.type === 'chat_tool_use') {
        showToolStatus(msg.tool, msg.status, msg.id);
        return;
      }
      if (msg.type === 'chat_done') {
        finalizeChatResponse(msg.sessionId);
        return;
      }
      if (msg.type === 'chat_error') {
        showChatError(msg.error);
        return;
      }
      if (msg.type === 'chat_event') {
        showChatNotice(msg.message || msg.event);
        return;
      }
      if (msg.type === 'daemon_reloading') {
        // Dev auto-reload: the daemon is stepping aside for updated code; the
        // onclose handler relaunches it and we reconnect. Surfaced as a neutral
        // toast (refresh action icon) rather than a chat notice.
        showToast('neutral', msg.message || 'Reloading Gaffer for updated code…', { actionIcon: 'refresh', actionTitle: 'Reloading' });
        return;
      }
      if (msg.type === 'models') {
        // CLI-discovered model/effort options (never hardcoded panel-side)
        applyModelOptions(msg);
        return;
      }
      if (msg.type === 'mcps') {
        // carry icons over from the previous list so a refresh never
        // regresses a tile to its monogram fallback
        var prev = {};
        availableMcps.forEach(function (s) { prev[s.id] = s; });
        (msg.servers || []).forEach(function (s) {
          var p = prev[s.id];
          if (p && !s.icon && p.icon) s.icon = p.icon;
        });
        availableMcps = msg.servers || [];
        mcpListError = msg.error || null;
        renderMcpList();
        return;
      }
      if (msg.type === 'mcp_auth_done') {
        pendingAuthId = null;
        if (!msg.ok) showChatNotice('MCP auth failed: ' + (msg.error || 'unknown error'));
        requestMcpList(); // status may have changed either way
        return;
      }
      if (msg.type === 'mcp_icons') {
        // background favicon fetches — merge and re-render
        availableMcps.forEach(function (s) {
          if (msg.icons && msg.icons[s.id]) s.icon = msg.icons[s.id];
        });
        renderMcpList();
        return;
      }
      if (msg.type === 'auth_status') { renderAuth(msg); return; }
      if (msg.type === 'sign_in_started') {
        document.getElementById('signInProgress').hidden = false;
        document.getElementById('signInError').hidden = true;
        var sic = document.getElementById('signInClaude'); if (sic) sic.disabled = true;
        var sico = document.getElementById('signInConsole'); if (sico) sico.disabled = true;
        return;
      }
      if (msg.type === 'sign_in_done') {
        document.getElementById('signInProgress').hidden = true;
        var sic2 = document.getElementById('signInClaude'); if (sic2) sic2.disabled = false;
        var sico2 = document.getElementById('signInConsole'); if (sico2) sico2.disabled = false;
        if (!msg.ok) { var e = document.getElementById('signInError'); e.hidden = false;
          e.textContent = msg.error === 'timeout' ? 'Sign-in timed out — try again.'
            : msg.error === 'cancelled' ? '' : ('Sign-in failed: ' + (msg.error || 'unknown')); }
        return;
      }

      // ── Legacy: JSX execution request (no type field) ──
      if (!msg.id || !msg.code) return;
      // Debug rows hidden by default (user decision) — enable with
      // localStorage.setItem('gafferDebug', '1') in the panel console.
      var debugRows = false;
      try { debugRows = localStorage.getItem('gafferDebug') === '1'; } catch (e) {}
      lastJsxEl.textContent = truncate(msg.code, 80);
      lastJsxEl.hidden = !debugRows;

      evalScriptAsync(msg.code).then(function (result) {
        lastResultEl.textContent = truncate(typeof result === 'string' ? result : JSON.stringify(result), 80);
        lastResultEl.hidden = !debugRows;
        var response;
        if (typeof result === 'object' && result.ok === false) {
          response = JSON.stringify({ id: msg.id, ok: false, error: result.error, line: result.line });
        } else {
          response = JSON.stringify({ id: msg.id, result: result });
        }
        ws.send(response);
      });
    } catch (e) {
      console.error('Gaffer: message handler error', e);
    }
  }

  function connect() {
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error('Gaffer: WebSocket constructor error', e);
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      console.log('Gaffer: connected to daemon as AE ' + aeVersion);
      // Register with daemon so it can route by AE version
      try {
        ws.send(JSON.stringify({ type: 'register', aeVersion: aeVersion }));
      } catch (e) { /* ignore */ }
      setStatus('connected', 'Connected');
      wasConnected = true;
      reconnectDelay = 1000;
      requestMcpList();
      ws.send(JSON.stringify({ type: 'auth_status' }));
    };

    ws.onmessage = handleMessage;

    ws.onclose = function () {
      console.log('Gaffer: disconnected from daemon');
      setStatus('disconnected', 'Disconnected');
      // If daemon crashed after being connected, allow restart
      if (wasConnected) {
        daemonStartAttempted = false;
        wasConnected = false;
      }
      // never respawn the daemon while an update is replacing its files —
      // a half-copied daemon grabs the port and locks node_modules
      if (!daemonStartAttempted && !window.__gafferUpdating) startDaemon();
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose fires after onerror
    };
  }

  function scheduleReconnect() {
    setTimeout(function () {
      reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
      connect();
    }, reconnectDelay);
  }

  // ── Image paste/drop ──

  function tmpDir() {
    try { return require('os').tmpdir(); } catch (e) {}
    return process && process.platform === 'win32'
      ? (process.env.TEMP || 'C:\\Windows\\Temp')
      : '/tmp';
  }

  function joinPath(dir, name) {
    try { return require('path').join(dir, name); } catch (e) {}
    var sep = process && process.platform === 'win32' ? '\\' : '/';
    return dir.replace(/[\\\/]+$/, '') + sep + name;
  }

  function pruneOldPastes() {
    try {
      var fs = require('node:fs');
      var dir = tmpDir();
      var entries = fs.readdirSync(dir)
        .filter(function (f) { return f.indexOf(PASTE_PREFIX) === 0; })
        .sort();
      while (entries.length > MAX_PASTE_FILES) {
        var oldest = entries.shift();
        try { fs.unlinkSync(joinPath(dir, oldest)); } catch (e) {}
      }
    } catch (e) { /* ignore */ }
  }

  function makeThumbnail(blob, maxEdge, cb) {
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var w = img.width, h = img.height;
      var scale = Math.min(1, maxEdge / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
      var dataUrl;
      try { dataUrl = canvas.toDataURL('image/jpeg', 0.7); }
      catch (e) { dataUrl = canvas.toDataURL('image/png'); }
      URL.revokeObjectURL(url);
      cb(dataUrl);
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }

  function extForMime(mime) {
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/gif') return 'gif';
    if (mime === 'image/webp') return 'webp';
    return 'png';
  }

  function handleImageBlob(blob) {
    if (!blob) return;
    if (typeof require === 'undefined') {
      console.warn('Gaffer: require unavailable, cannot save pasted image');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var fs = require('node:fs');
        var bytes = new Uint8Array(reader.result);
        var ext = extForMime(blob.type);
        var fname = PASTE_PREFIX + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.' + ext;
        var p = joinPath(tmpDir(), fname);
        fs.writeFileSync(p, Buffer.from(bytes));
        makeThumbnail(blob, THUMB_MAX_EDGE, function (dataUrl) {
          pendingImages.push({ path: p, dataUrl: dataUrl || '', name: blob.name || ('paste.' + ext) });
          renderPendingImages();
          pruneOldPastes();
        });
      } catch (e) {
        console.error('Gaffer: handleImageBlob failed', e);
      }
    };
    reader.readAsArrayBuffer(blob);
  }

  function renderPendingImages() {
    if (!pastePreviewRowEl) return;
    pastePreviewRowEl.innerHTML = '';
    for (var i = 0; i < pendingImages.length; i++) {
      (function (idx, item) {
        var chip = document.createElement('div');
        chip.className = 'paste-chip';
        chip.title = item.name || 'image';
        // Figma itemReverseZIndex: earlier chip's overhanging X paints
        // above the next chip
        chip.style.zIndex = String(MAX_PASTE_FILES - idx);
        var img = document.createElement('img');
        img.src = item.dataUrl;
        img.addEventListener('click', function () { openLightbox(item.dataUrl); });
        var x = icon('close', 'paste-chip-x');
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          pendingImages.splice(idx, 1);
          renderPendingImages();
        });
        chip.appendChild(img);
        chip.appendChild(x);
        pastePreviewRowEl.appendChild(chip);
      })(i, pendingImages[i]);
    }
  }

  function openLightbox(dataUrl) {
    if (!lightboxEl || !lightboxImgEl || !dataUrl) return;
    lightboxImgEl.src = dataUrl;
    tkShow(lightboxEl);
  }

  function closeLightbox() {
    if (!lightboxEl || !lightboxImgEl) return;
    tkHide(lightboxEl); // src is overwritten on next open; keep it for the fade-out
  }

  if (lightboxEl) {
    dismissOnBackdrop(lightboxEl, closeLightbox, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && tkOpen(lightboxEl)) closeLightbox();
    });
  }

  // In-panel replacement for native alert() — native OS alerts look out of
  // place inside the panel chrome. showModal(message, opts) sets the text,
  // unhides the modal, and resolves via opts.onClose when dismissed (OK
  // click, backdrop click, or Esc). opts: { title, okLabel, onClose }.
  var alertModalOnClose = null;
  var alertModalOnConfirm = null;
  var alertModalOnOk = null; // single-button action: runs on the OK button only, not on backdrop/Esc

  function showModal(message, opts) {
    opts = opts || {};
    if (!alertModalEl || !alertModalBodyEl || !alertModalOkEl) {
      // Should never happen, but never silently swallow a message the
      // caller needed the user to see.
      window.alert(message);
      if (typeof opts.onClose === 'function') opts.onClose();
      return;
    }
    if (alertModalTitleEl) {
      if (opts.title) {
        alertModalTitleEl.textContent = opts.title;
        alertModalTitleEl.hidden = false;
      } else {
        alertModalTitleEl.hidden = true;
      }
    }
    alertModalBodyEl.textContent = message;
    alertModalOnClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    alertModalOnConfirm = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
    alertModalOnOk = typeof opts.onOk === 'function' ? opts.onOk : null;
    if (alertModalOnConfirm) {
      // Confirm mode: Cancel (neutral) + a confirm action (danger-styled for destructive ops like Clear chat).
      alertModalOkEl.textContent = opts.confirmLabel || 'Confirm';
      alertModalOkEl.classList.toggle('danger', !!opts.danger);
      if (alertModalCancelEl) { alertModalCancelEl.textContent = opts.cancelLabel || 'Cancel'; alertModalCancelEl.hidden = false; }
    } else {
      // Single-button mode: an optional onOk action (e.g. "Learn how" -> docs)
      // that fires only on the button, so backdrop/Esc just dismiss.
      alertModalOkEl.textContent = opts.okLabel || 'OK';
      alertModalOkEl.classList.remove('danger');
      if (alertModalCancelEl) alertModalCancelEl.hidden = true;
    }
    tkShow(alertModalEl);
  }

  function hideModal() {
    if (!tkOpen(alertModalEl)) return;
    tkHide(alertModalEl);
    var cb = alertModalOnClose;
    alertModalOnClose = null;
    if (cb) cb();
  }

  // Edge case: Claude Code CLI isn't installed. Reuses the ModalFullScreen
  // (Figma no-CLI modal 524:7807) — single "Learn how" button -> install docs.
  function showNoCliModal() {
    showModal(
      'Gaffer brings AI into After Effects, not on your computer. Please install Claude Code CLI to be able to use it.',
      { title: 'Missing pieces', okLabel: 'Learn how', onOk: openClaudeCodeDocs }
    );
  }

  if (alertModalEl && alertModalOkEl) {
    alertModalOkEl.addEventListener('click', function () {
      var f = alertModalOnConfirm || alertModalOnOk; // capture before hideModal clears state
      alertModalOnConfirm = null; alertModalOnOk = null;
      hideModal();
      if (f) f(); // confirm/onOk action runs after the modal is dismissed
    });
    if (alertModalCancelEl) alertModalCancelEl.addEventListener('click', function () { alertModalOnConfirm = null; alertModalOnOk = null; hideModal(); });
    dismissOnBackdrop(alertModalEl, function () { alertModalOnConfirm = null; alertModalOnOk = null; hideModal(); }); // void click = cancel/dismiss only
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && tkOpen(alertModalEl)) { alertModalOnConfirm = null; alertModalOnOk = null; hideModal(); }
    });
  }

  // Paste — best-effort. AE may intercept Cmd+V at app level; in that
  // case the event never fires. Drag-drop is the reliable path.
  chatInputEl.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var consumed = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
        handleImageBlob(items[i].getAsFile());
        consumed = true;
      }
    }
    if (consumed) e.preventDefault();
  });

  // Drag-drop on whole panel. Counter-based to avoid flicker on child boundaries.
  var dragDepth = 0;

  function isFileDrag(e) {
    if (!e.dataTransfer) return false;
    var t = e.dataTransfer.types;
    if (!t) return false;
    for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
    return false;
  }

  document.addEventListener('dragenter', function (e) {
    if (!isFileDrag(e)) return;
    dragDepth++;
    if (dropOverlayEl) dropOverlayEl.classList.add('visible');
  });
  document.addEventListener('dragleave', function (e) {
    if (!isFileDrag(e)) return;
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      if (dropOverlayEl) dropOverlayEl.classList.remove('visible');
    }
  });
  document.addEventListener('dragover', function (e) {
    if (isFileDrag(e)) e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    if (dropOverlayEl) dropOverlayEl.classList.remove('visible');
    var files = e.dataTransfer.files;
    for (var i = 0; i < files.length; i++) {
      if (files[i].type.indexOf('image/') === 0) handleImageBlob(files[i]);
    }
  });

  // ── Chat UI ──

  function sendChatMessage() {
    var text = chatInputEl.value.trim();
    if (!ws || ws.readyState !== 1 || chatBusy) return;
    if (authLoggedIn === false) return; // defense-in-depth: signed-out users can never send
    if (!text && pendingImages.length === 0 && replyQuotes.length === 0) return;

    // Staged reply quotes: stored structurally on the message (styled cards in
    // the log) and sent to the agent inside a <quoted_context> tag ahead of the
    // instruction. The bubble text itself is just what the user typed.
    var quotes = stagedQuotesData();
    var quoteTag = buildQuoteTag();
    var body = text;
    var agentText = quoteTag ? (quoteTag + (text ? '\n\n' + text : '')) : text;

    var imgs = pendingImages.slice();
    var imgPrefix = imgs.map(function (p) { return '[image: ' + p.path + ']'; }).join('\n');
    var fullMessage = imgPrefix ? (imgPrefix + (agentText ? '\n' + agentText : '')) : agentText;

    // every send counts one use for each enabled server (drives tile order)
    enabledMcps.forEach(function (id) {
      var u = mcpUsage[id] || { count: 0, last: 0 };
      u.count++;
      u.last = Date.now();
      mcpUsage[id] = u;
    });
    appendUserMessage(body, imgs, quotes);
    ws.send(JSON.stringify({
      type: 'chat',
      message: fullMessage,
      sessionId: currentSessionId,
      // pinned version = full model id (may embed [1m]); alias otherwise
      model: currentVariant.indexOf('id:') === 0 ? currentVariant.slice(3) : currentModel,
      variant: currentVariant === '1m' ? '1m' : 'standard',
      effort: discoveredEfforts.length ? currentEffort : null,
      aeVersion: aeVersion,
      enabledMcps: enabledMcps,
      autoModel: autoModel,
    }));
    chatInputEl.value = '';
    resizeChatInput(); // collapse to one (scaled) line
    sendBtnEl.classList.remove('typed');
    clearReplyQuotes();
    pendingImages = [];
    renderPendingImages();
    setChatBusy(true);
    startAssistantMessage();
  }

  // Shared user-bubble builder (live send + history reload use the same DOM).
  // Order inside the black bubble: quoted context (styled reply cards) on top,
  // then images, then the typed text — a reply-preview pattern.
  function buildUserMessageEl(text, images, quotes) {
    var div = document.createElement('div');
    div.className = 'chat-msg user';
    div.setAttribute('data-fig', '176:928'); // Bubble role=user
    if (quotes && quotes.length) {
      div.classList.add('has-quotes');
      var qc = document.createElement('div');
      qc.className = 'msg-quotes';
      quotes.forEach(function (q) { qc.appendChild(buildQuoteRow(q, null)); }); // no × — committed
      div.appendChild(qc);
    }
    if (images && images.length) {
      div.classList.add('has-images');
      var row = document.createElement('div');
      row.className = 'bubble-images-row';
      images.forEach(function (item) {
        var img = document.createElement('img');
        img.className = 'bubble-image';
        img.src = item.dataUrl;
        img.alt = item.name || 'image';
        img.addEventListener('click', function () { openLightbox(item.dataUrl); });
        row.appendChild(img);
      });
      div.appendChild(row);
    }
    if (text) {
      var t = document.createElement('div');
      t.textContent = text;
      div.appendChild(t);
    }
    return div;
  }

  function appendUserMessage(text, images, quotes) {
    chatMessagesEl.appendChild(buildUserMessageEl(text, images, quotes));
    var entry = { role: 'user', text: text };
    if (images && images.length) {
      entry.images = images.map(function (i) { return { dataUrl: i.dataUrl, name: i.name }; });
    }
    if (quotes && quotes.length) {
      entry.quotes = quotes.map(function (q) { return { html: q.html, text: q.text }; });
    }
    chatHistory.push(entry);
    saveChat();
    scrollToBottom();
  }

  function setChatBusy(busy) {
    chatBusy = busy;
    updateChatEnabled();
    sendBtnEl.style.display = busy ? 'none' : 'block';
    stopBtnEl.style.display = busy ? 'block' : 'none';
  }

  function addCopyButton(div) {
    var copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn copy-btn';
    copyBtn.title = 'Copy';
    copyBtn.appendChild(icon('copy'));
    copyBtn.addEventListener('click', function () {
      var textEl = div.querySelector('.msg-text');
      // Prefer raw markdown source; fall back to rendered text
      var text = textEl && textEl.dataset && textEl.dataset.raw
        ? textEl.dataset.raw
        : (textEl ? textEl.textContent.trim() : div.textContent.trim());
      if (copyToClipboard(text)) {
        copyFeedback(copyBtn);
      } else {
        // async API as backup; never shell out (pbcopy is mac-only and
        // callSystem failures raise a modal AE warning on Windows)
        try {
          navigator.clipboard.writeText(text).then(function () { copyFeedback(copyBtn); });
        } catch (e) { /* give up quietly */ }
      }
    });
    div.appendChild(copyBtn);
  }

  // Synchronous CEF-safe copy — execCommand works in CEP on both OSes
  // without clipboard permissions or window focus requirements.
  function copyToClipboard(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* fall through */ }
    ta.remove();
    return ok;
  }

  // Floating selection CTA — copy or reply-to the highlighted text inside a
  // chat message. Distinct from the per-bubble copy button (which grabs the
  // whole message's raw markdown); this copies exactly what's selected.
  var selectionCta = null, selCopyBtn = null, selReplyBtn = null;
  var ctaDismissing = false; // freezes selection-driven auto-hide during a copy confirm

  function currentSelectionText() {
    var sel = window.getSelection && window.getSelection();
    return sel ? sel.toString().trim() : '';
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Capture the selection as BOTH rendered HTML (preserves bold/code/links for
  // the styled quote) and plain text (what the agent receives). A selection that
  // spans multiple messages clones the chrome BETWEEN them too (copy buttons,
  // tool-status dashes, typing dots, message-bubble wrappers), so sanitise the
  // fragment down to content: drop the chrome elements and strip wrapper
  // identity (class/id/style/data-fig) so nothing re-styles as a bubble/button.
  var QUOTE_JUNK = 'button, svg, .copy-btn, .tool-pills-row, .tool-pill, .busy-pills,' +
    ' .typing-indicator, .selection-cta, .reply-quotes-pill, .reply-quote-x, script, style';
  function currentSelectionQuote() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var box = document.createElement('div');
    box.appendChild(sel.getRangeAt(0).cloneContents());
    var junk = box.querySelectorAll(QUOTE_JUNK);
    for (var i = junk.length - 1; i >= 0; i--) { if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]); }
    var nodes = box.querySelectorAll('*');
    for (var j = 0; j < nodes.length; j++) {
      nodes[j].removeAttribute('class');
      nodes[j].removeAttribute('id');
      nodes[j].removeAttribute('style');
      nodes[j].removeAttribute('data-fig');
    }
    // text from the CLEANED fragment (excludes chrome/hidden pill labels)
    var text = (box.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { html: box.innerHTML, text: text };
  }

  // Return the live selection only when it sits inside a chat bubble (so the
  // input field's own selection never triggers the CTA).
  function selectionInChat() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var el = sel.anchorNode;
    if (el && el.nodeType !== 1) el = el.parentNode;
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('chat-msg')) return sel;
      el = el.parentNode;
    }
    return null;
  }

  function buildSelectionCta() {
    selectionCta = document.createElement('div');
    selectionCta.className = 'selection-cta';
    selectionCta.setAttribute('data-fig', '507:40583'); // SelectedTextActions
    selCopyBtn = document.createElement('button');
    selCopyBtn.className = 'icon-btn hollow'; // Icon/Hollow (507:40563)
    selCopyBtn.setAttribute('data-fig', '507:40563');
    selCopyBtn.title = 'Copy selection';
    selCopyBtn.appendChild(icon('copy'));
    selReplyBtn = document.createElement('button');
    selReplyBtn.className = 'icon-btn hollow'; // Icon/Hollow (507:40567)
    selReplyBtn.setAttribute('data-fig', '507:40567');
    selReplyBtn.title = 'Reply to selection';
    selReplyBtn.appendChild(icon('reply'));
    selectionCta.appendChild(selCopyBtn);
    selectionCta.appendChild(selReplyBtn);
    document.body.appendChild(selectionCta);

    // mousedown + preventDefault: act before the browser clears the selection.
    selCopyBtn.addEventListener('mousedown', function (e) {
      e.preventDefault();
      // Stop here: copyFeedback swaps the icon (innerHTML=''), detaching this
      // very e.target. If the event reached the document outside-click handler,
      // selectionCta.contains(detached target) would be false → instant hide.
      e.stopPropagation();
      var text = currentSelectionText();
      if (text) {
        // copyToClipboard selects a temp textarea → fires selectionchange,
        // which would auto-hide us instantly. Freeze the auto-hide across the
        // confirm window so the check reads, then run the out-animation.
        ctaDismissing = true;
        var ok = copyToClipboard(text);
        if (ok) copyFeedback(selCopyBtn); // swap to check (auto-restores to copy)
        setTimeout(function () { ctaDismissing = false; hideSelectionCta(); }, ok ? 500 : 0);
      } else {
        hideSelectionCta();
      }
    });
    selReplyBtn.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation(); // clicks inside the CTA must not reach the outside-click handler
      var quote = currentSelectionQuote();
      if (quote) addReplyQuote(quote);
      hideSelectionCta();
    });
  }

  function positionSelectionCta() {
    var sel = selectionInChat();
    if (!sel || !currentSelectionText()) { hideSelectionCta(); return; }
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { hideSelectionCta(); return; }
    if (!selectionCta) buildSelectionCta();
    var cw = selectionCta.offsetWidth, ch = selectionCta.offsetHeight; // display:flex → measurable
    var top = rect.top - ch - 6;             // above the selection
    if (top < 4) top = rect.bottom + 6;      // flip below if no room up top
    var left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - cw - 4));
    selectionCta.style.top = top + 'px';
    selectionCta.style.left = left + 'px';
    selectionCta.classList.add('visible'); // position set first so it fades in in place
  }

  function hideSelectionCta() {
    if (selectionCta) selectionCta.classList.remove('visible');
  }

  // ── Reply quotes ──
  // Selected text is staged in a dedicated tray above the input (Figma
  // Cell: Replying). On send, each staged quote is prepended to the message
  // as a markdown blockquote — the agent gets the exact referent, same
  // routing as before (Gaffer pipes the message string to claude -p). The
  // tray rises from behind the pill on add and shrinks on remove.
  var replyQuotes = []; // [{ id, text }] — id keeps removal stable across renders
  var replyQuoteSeq = 0;
  var replyQuotesEl = document.getElementById('replyQuotes');

  function addReplyQuote(quote) {
    // Accept {html, text} (selection capture) or a bare string (audit hook /
    // programmatic). html preserves the styling; text is the agent-facing form.
    if (typeof quote === 'string') quote = { html: escapeHtml(quote), text: quote };
    if (!quote || !quote.text) return;
    replyQuotes.push({ id: ++replyQuoteSeq, html: quote.html || escapeHtml(quote.text), text: quote.text });
    renderReplyQuotes();
    chatInputEl.focus(); // ready to type the reaction
  }

  // Build one styled quote row (wave rule + rendered HTML snippet). Shared by
  // the staging tray (dismissible) and the sent user message (static). onRemove
  // omitted → no × button (committed quotes in the chat log can't be unstaged).
  function buildQuoteRow(q, onRemove) {
    var row = document.createElement('div');
    row.className = 'reply-quote-row';
    row.setAttribute('data-fig', '428:3187'); // Quote Wrapper
    var wave = document.createElement('div');
    wave.className = 'reply-quote-wave';
    wave.setAttribute('data-fig', '428:3188'); // Wave
    var txt = document.createElement('div');
    // msg-text supplies the chat inline styling (code chips, bold, links);
    // reply-quote-text (later in the sheet) overrides size/color/clamp.
    txt.className = 'reply-quote-text msg-text';
    txt.setAttribute('data-fig', '428:3198'); // banner-text
    txt.innerHTML = q.html || escapeHtml(q.text || ''); // styled snippet
    row.appendChild(wave);
    row.appendChild(txt);
    if (onRemove) {
      var x = document.createElement('button');
      x.className = 'reply-quote-x';
      x.setAttribute('data-fig', '428:3201'); // DismissBtn
      x.title = 'Remove quote';
      x.appendChild(icon('close'));
      x.addEventListener('click', function () { onRemove(); });
      row.appendChild(x);
    }
    return row;
  }

  function removeReplyQuote(id) {
    var idx = -1;
    for (var k = 0; k < replyQuotes.length; k++) { if (replyQuotes[k].id === id) { idx = k; break; } }
    if (idx === -1) return;
    var pill = replyQuotesEl.firstChild;
    var row = pill && pill.children[idx];
    // Last remaining quote (or no node) → collapse the whole tray.
    if (replyQuotes.length === 1 || !row) {
      replyQuotes.splice(idx, 1);
      renderReplyQuotes();
      return;
    }
    // Mid-list removal: collapse THIS row while siblings glide up. Two timelines
    // run in parallel and must share one curve or they visibly desync:
    //   (a) the row's own height/gap/opacity → 0
    //   (b) the tray's max-height → its measured resting height
    // Measure the tray target with the row out of layout (exact, no end-snap),
    // and LOCK the row to its real height before collapsing — otherwise it
    // animates from the 200px max-height clamp, whose visible collapse is
    // squeezed into the tail of the curve (a late jump) while the tray shrinks
    // evenly the whole time.
    row.style.display = 'none';
    var target = replyQuotesEl.scrollHeight;
    row.style.display = '';
    var startH = row.scrollHeight; // real row height, for a proportional collapse
    // Lock the row to its real height WITHOUT animating (transition off), commit
    // it, then collapse. Otherwise setting max-height off the 200px base clamp
    // starts its own 200→startH transition, and the following →0 runs from ~200
    // (back-loaded: the row sits still, then snaps at the tail — the visible jump).
    row.style.transition = 'none';
    row.style.maxHeight = startH + 'px';
    void row.offsetHeight; // commit the locked start with no transition
    row.style.transition = ''; // restore the CSS transition for the collapse
    row.classList.add('removing'); // opacity → 0
    row.style.maxHeight = '0px'; // height now collapses startH → 0 over the full curve
    // Eat the one 12px flex gap that disappears with this row (the gap above it,
    // or — for the first row — the gap below) so the content height tracks the
    // tray max-height exactly throughout: no clip, no end-snap.
    if (row.previousElementSibling) row.style.marginTop = '-12px';
    else row.style.marginBottom = '-12px';
    replyQuotesEl.style.maxHeight = target + 'px';
    // shrink the chat reserve to its FINAL value now (target = post-removal tray
    // height) so the padding transition animates the chat growing back in sync
    // with the row collapsing
    syncChatReserve(target);
    setTimeout(function () {
      var j = -1;
      for (var k = 0; k < replyQuotes.length; k++) { if (replyQuotes[k].id === id) { j = k; break; } }
      if (j === -1) return;
      replyQuotes.splice(j, 1);
      if (row.parentNode) row.parentNode.removeChild(row);
      replyQuotesEl.style.maxHeight = replyQuotesEl.scrollHeight + 'px';
      updateChatEnabled(); // recompute .typed + disabled from current content
      syncChatReserve();
    }, 200);
  }

  function clearReplyQuotes() {
    if (!replyQuotes.length) return;
    replyQuotes = [];
    renderReplyQuotes();
  }

  // The staged quotes carried to the agent, wrapped in a delimited tag so it can
  // tell the quoted material apart from the user's actual instruction. Plain text
  // (styling is display-only).
  function buildQuoteTag() {
    if (!replyQuotes.length) return '';
    var inner = replyQuotes.map(function (q) { return q.text; }).join('\n\n');
    return '<quoted_context>\n' + inner + '\n</quoted_context>';
  }
  // Structured snapshot of the staged quotes, stored on the sent message so the
  // chat log can re-render them styled (and tagged) on reload.
  function stagedQuotesData() {
    return replyQuotes.map(function (q) { return { html: q.html, text: q.text }; });
  }

  function renderReplyQuotes() {
    if (!replyQuotesEl) return;
    // staged quotes count as "typed" so the send button lights up
    updateChatEnabled(); // recompute .typed + disabled from current content
    if (replyQuotes.length === 0) {
      replyQuotesEl.style.maxHeight = '0px';
      replyQuotesEl.classList.remove('visible');
      // drop the rows only after the collapse so the shrink animates from
      // real content height, not an emptied box
      setTimeout(function () { if (replyQuotes.length === 0) replyQuotesEl.innerHTML = ''; }, 220);
      syncChatReserve();
      return;
    }
    replyQuotesEl.innerHTML = '';
    var pill = document.createElement('div');
    pill.className = 'reply-quotes-pill';
    pill.setAttribute('data-fig', '428:3186'); // Pill (canonical Reply Quote 428:3200)
    replyQuotes.forEach(function (q) {
      pill.appendChild(buildQuoteRow(q, function () { removeReplyQuote(q.id); }));
    });
    replyQuotesEl.appendChild(pill);
    replyQuotesEl.classList.add('visible');
    replyQuotesEl.style.maxHeight = replyQuotesEl.scrollHeight + 'px'; // animate to content
    syncChatReserve();
  }

  // Reserve chat scroll room for the EXTRA the reply tray covers beyond the
  // input pill. The chat's bottom padding is calc(34px + --reply-reserve): the
  // 34px base already clears the pill, so the reserve is only how far the tray's
  // top rises ABOVE that base line — NOT the whole chat-bottom→tray-top distance
  // (subtracting the base was missing, which over-reserved by 34px). Measured
  // from settled geometry (anchored bottom + pill content height) so it's right
  // even mid open/close animation. Padding grows only at the bottom → no jump.
  var CHAT_BASE_PAD = 34; // must match the 34px in .chat-messages padding-bottom
  // trayHeight optional: pass the FINAL height (e.g. a removal's measured target)
  // so the reserve jumps to its end value up front and the CSS padding-bottom
  // transition animates the chat's grow/shrink in step with the tray. Omit to
  // measure the current pill height (add / settle).
  function syncChatReserve(trayHeight) {
    var reserve = 0;
    var pill = replyQuotesEl && replyQuotesEl.firstChild;
    var h = trayHeight != null ? trayHeight : (pill ? pill.scrollHeight : 0);
    if (h > 0 && replyQuotes.length) {
      var trayBottom = replyQuotesEl.getBoundingClientRect().bottom; // anchored, stable
      var settledTop = trayBottom - h;                               // top when settled at h
      var chatBottom = chatMessagesEl.getBoundingClientRect().bottom;
      reserve = Math.max(0, Math.round(chatBottom - settledTop) - CHAT_BASE_PAD);
    }
    chatMessagesEl.style.setProperty('--reply-reserve', reserve + 'px');
  }

  // Re-pin the tray height after the quote text reflows (e.g. an A-/A+ text-size
  // change): --chat-text scales .reply-quote-text, so the fixed max-height set at
  // render time would otherwise clip the taller text or leave a gap.
  function refitReplyQuotes() {
    if (!replyQuotesEl || !replyQuotes.length) return;
    replyQuotesEl.style.maxHeight = replyQuotesEl.scrollHeight + 'px';
    syncChatReserve();
  }

  // Audit/test seam — panel-capture.mjs drives the REAL builders over CDP so the
  // parity capture reflects shipping DOM, not a hand-mirrored mock (mock drift
  // has burned us). Gated to dev use: exposed ONLY when localStorage.gafferAudit
  // === '1', which the capture tool sets and end-user installs never do — so no
  // test surface ships in normal use. (This project ships unsigned, so end users
  // also run with PlayerDebugMode on; that can't be the gate.)
  try {
    if (localStorage.getItem('gafferAudit') === '1') {
      window.__gaffer = window.__gaffer || {};
      window.__gaffer.addReplyQuote = addReplyQuote;
      window.__gaffer.clearReplyQuotes = clearReplyQuotes;
      window.__gaffer.currentSelectionQuote = currentSelectionQuote;
      window.__gaffer.showToast = showToast;
      window.__gaffer.openSettings = openSettings;
      // Account / API review hook — sets apiState.status + re-renders, so the 3
      // Figma states (nokey/disconnected/connected) can be captured without a
      // real key. See apiState/renderApi() above.
      window.__gaffer.setApiState = function (status) {
        if (status !== 'nokey' && status !== 'disconnected' && status !== 'connected') return;
        apiState.status = status;
        renderApi();
      };
      window.__gaffer.showModal = showModal;
      window.__gaffer.showNoCliModal = showNoCliModal;
    }
  } catch (e) { /* localStorage blocked → no audit seam, which is the safe default */ }

  chatMessagesEl.addEventListener('mouseup', function () {
    setTimeout(positionSelectionCta, 0); // let the selection settle first
  });
  chatMessagesEl.addEventListener('scroll', hideSelectionCta);
  document.addEventListener('mousedown', function (e) {
    if (selectionCta && !selectionCta.contains(e.target)) hideSelectionCta();
  });
  document.addEventListener('selectionchange', function () {
    if (ctaDismissing) return; // mid copy-confirm — the temp-textarea copy clears the selection
    if (selectionCta && selectionCta.classList.contains('visible') && !currentSelectionText()) {
      hideSelectionCta();
    }
  });

  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return text;
    try {
      // Normalize whitespace: collapse 3+ newlines, strip blanks between list
      // items so marked produces tight lists (no <p> inside <li>).
      var clean = text
        .replace(/(\n[ \t]*){3,}/g, '\n\n')
        .replace(/^(\s*[-*+]\s+.*)\n\s*\n(?=\s*[-*+]\s)/gm, '$1\n')
        .replace(/^(\s*\d+\.\s+.*)\n\s*\n(?=\s*\d+\.\s)/gm, '$1\n')
        .trim();
      return marked.parse(clean, { breaks: false, gfm: true });
    } catch (e) {
      return text;
    }
  }

  function startAssistantMessage() {
    var div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.setAttribute('data-fig', '176:931'); // Bubble role=assistant
    div.id = 'currentResponse';
    // copy CTA arrives with the first text — nothing to copy before that
    var typing = document.createElement('span');
    typing.className = 'typing-indicator';
    typing.innerHTML = '<i></i><i></i><i></i>';
    div.appendChild(typing);
    chatMessagesEl.appendChild(div);
    scrollToBottom();
  }

  // Typing dots lifecycle: visible before the first output, hidden while
  // content flows, and BACK whenever the agent goes quiet mid-turn
  // (thinking, long tool runs) — any stream event resets the idle timer.
  var typingIdleTimer = null;
  function markStreamActivity() {
    var el = document.getElementById('currentResponse');
    if (el) {
      var t = el.querySelector('.typing-indicator');
      if (t) t.remove();
    }
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(function () {
      typingIdleTimer = null;
      var cur = document.getElementById('currentResponse');
      if (!chatBusy || !cur) return;
      var t = document.createElement('span');
      t.className = 'typing-indicator';
      t.innerHTML = '<i></i><i></i><i></i>';
      cur.appendChild(t);
      scrollToBottom();
    }, 700);
  }
  function removeTyping(el) {
    if (typingIdleTimer) { clearTimeout(typingIdleTimer); typingIdleTimer = null; }
    var t = el && el.querySelector('.typing-indicator');
    if (t) t.remove();
  }

  function appendChatChunk(text) {
    var el = document.getElementById('currentResponse');
    if (!el) startAssistantMessage();
    el = document.getElementById('currentResponse');
    markStreamActivity();
    var textNode = el.querySelector('.msg-text');
    if (!textNode) {
      textNode = document.createElement('span');
      textNode.className = 'msg-text';
      textNode.dataset.raw = '';
      el.appendChild(textNode);
      if (!el.querySelector('.copy-btn')) addCopyButton(el);
    }
    // Accumulate raw markdown, re-render on each chunk
    textNode.dataset.raw = (textNode.dataset.raw || '') + text;
    textNode.innerHTML = renderMarkdown(textNode.dataset.raw);
    scrollToBottom();
  }

  function showToolStatus(tool, status, id) {
    var el = document.getElementById('currentResponse');
    if (!el) return;
    // Pills live in a single row container inside the bubble (Figma
    // ToolPillsRow) — the bubble itself is a flex column with gap 12.
    var row = el.querySelector('.tool-pills-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'tool-pills-row';
      el.appendChild(row);
    }
    // Reuse existing pill for this tool call (dedupe running → done/error)
    var pill = id ? row.querySelector('[data-tool-id="' + id + '"]') : null;
    if (!pill) {
      pill = document.createElement('span');
      if (id) pill.dataset.toolId = id;
      // dash carries no visible label — tool name lives in the tooltip
      pill.addEventListener('mouseenter', function () { showMcpTooltip(pill, pill.textContent); });
      pill.addEventListener('mouseleave', hideMcpTooltip);
      row.appendChild(pill);
    }
    pill.className = 'tool-pill ' + status;
    pill.textContent = tool;
    markStreamActivity(); // dots return if the tool runs long
    scrollToBottom();
  }

  function finalizeChatResponse(sessionId) {
    currentSessionId = sessionId;
    var el = document.getElementById('currentResponse');
    removeTyping(el);
    if (el) {
      var msgText = el.querySelector('.msg-text');
      var rawText = msgText && msgText.dataset && msgText.dataset.raw
        ? msgText.dataset.raw.trim()
        : (msgText ? msgText.textContent.trim() : '');
      if (!rawText && !el.querySelector('.tool-pill')) {
        el.remove();
      } else {
        el.removeAttribute('id');
        if (rawText) {
          chatHistory.push({ role: 'assistant', text: rawText });
          saveChat();
        }
      }
    }
    setChatBusy(false);
    playReplySound('done');
    chatInputEl.focus();
  }

  function showChatNotice(text) {
    if (!text) return;
    var notice = document.createElement('div');
    notice.className = 'chat-notice';
    notice.textContent = text;
    chatMessagesEl.appendChild(notice);
    scrollToBottom();
  }

  // Toast — dark pill (Toast set 464:10032). `type` (info|success|warning|error|
  // neutral) selects only the head-icon glyph; the pill is uniform. Auto-dismisses
  // with pause-on-hover/focus (WCAG 2.2.1) plus a manual dismiss button.
  var TOAST_ICON = { info: 'galaxy', success: 'check', warning: 'flag', error: 'circleOff', neutral: 'book' };
  var TOAST_FIG = { info: '462:10030', success: '480:24373', warning: '480:24379', error: '480:24385', neutral: '480:24665' };
  function showToast(type, label, opts) {
    opts = opts || {};
    var stack = document.getElementById('toastStack');
    if (!stack) return null;
    var t = document.createElement('div');
    t.className = 'toast ' + (TOAST_ICON[type] ? type : 'neutral'); // type tint + head-icon glyph
    if (TOAST_FIG[type]) t.setAttribute('data-fig', TOAST_FIG[type]);
    t.appendChild(icon(TOAST_ICON[type] || 'book'));
    var lbl = document.createElement('span');
    lbl.className = 'toast-label';
    lbl.textContent = label || '';
    t.appendChild(lbl);
    var btn = document.createElement('button');
    btn.className = 'icon-btn hollow';
    btn.setAttribute('data-fig', '462:10028'); // Button (Icon/Hollow)
    btn.title = opts.actionTitle || 'Dismiss';
    btn.appendChild(icon(opts.actionIcon || 'close'));
    t.appendChild(btn);
    stack.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('visible'); });

    var timer = null, life = opts.duration == null ? 6000 : opts.duration;
    function dismiss() {
      if (!t.parentNode) return;
      clearTimeout(timer);
      var stack = t.parentNode;
      // Capture the toasts below BEFORE this one leaves the flow.
      var movers = [];
      for (var s = t.nextElementSibling; s; s = s.nextElementSibling) {
        movers.push({ el: s, top: s.getBoundingClientRect().top });
      }
      // Detach the dismissing toast to <body> at fixed VIEWPORT coords, out of
      // the stack. The stack is a center-aligned hug-width column, so once this
      // toast leaves the flow the stack shrinks + its translateX(-50%) box
      // shifts; a toast pinned inside the stack would ride that shift sideways
      // (the "slide right"). Fixed on <body> is immune — it fades in place, no x.
      var r = t.getBoundingClientRect();
      document.body.appendChild(t); // removes from stack -> siblings reflow up now
      t.style.position = 'fixed';
      t.style.top = r.top + 'px';
      t.style.left = r.left + 'px';
      t.style.width = r.width + 'px';
      t.style.margin = '0';
      t.style.zIndex = '3999'; // just under the stack (4000): behind the staying toasts
      t.style.transition = 'opacity 0.28s ease, transform 0.28s ease'; // slower fade
      void t.offsetWidth; // commit the in-place state before animating
      t.classList.remove('visible'); // fade out — vertical drift only, no x/scale
      t.style.transform = 'translateY(4px)';
      // FLIP the siblings up on a soft ease-out, synced with the fade.
      var EASE = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
      movers.forEach(function (m) {
        var delta = m.top - m.el.getBoundingClientRect().top; // px it jumped up
        if (!delta) return;
        m.el.style.transition = 'none';
        m.el.style.transform = 'translateY(' + delta + 'px)';
        void m.el.offsetHeight; // commit the pre-slide position instantly
        m.el.style.transition = EASE;
        m.el.style.transform = ''; // -> settles to translateY(0), animated
        var clear = function () { m.el.style.transition = ''; m.el.style.transform = ''; m.el.removeEventListener('transitionend', clear); };
        m.el.addEventListener('transitionend', clear);
      });
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }
    function arm() { if (life) timer = setTimeout(dismiss, life); }
    function pause() { clearTimeout(timer); }
    t.addEventListener('mouseenter', pause);
    t.addEventListener('mouseleave', arm);
    t.addEventListener('focusin', pause);
    t.addEventListener('focusout', arm);
    btn.addEventListener('click', function () { if (opts.onAction) opts.onAction(); dismiss(); });
    arm();
    return { el: t, dismiss: dismiss };
  }

  // Dev-only toast trigger: Cmd/Ctrl+Shift+T fires a demo toast, cycling
  // info -> success -> warning -> error -> neutral on repeat presses. Gated on a
  // localStorage flag so end users never trigger it; enable it (persists across
  // reloads) with:  localStorage.setItem('gafferDevToasts', '1')
  var DEMO_TOASTS = [
    ['info', 'Gaffer updated'],
    ['success', 'Added to render queue'],
    ['warning', 'Conversation compacted'],
    ['error', 'Render failed — check the output module'],
    ['neutral', 'Reloading Gaffer for updated code…']
  ];
  var demoToastIdx = 0;
  document.addEventListener('keydown', function (e) {
    if (!e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
    if ((e.key || '').toLowerCase() !== 't') return;
    try { if (localStorage.getItem('gafferDevToasts') !== '1') return; } catch (_) { return; }
    e.preventDefault();
    var d = DEMO_TOASTS[demoToastIdx % DEMO_TOASTS.length];
    demoToastIdx++;
    showToast(d[0], d[1]);
  });

  function showChatError(error) {
    var el = document.getElementById('currentResponse');
    if (!el) startAssistantMessage();
    el = document.getElementById('currentResponse');
    removeTyping(el);
    el.className += ' error';
    playReplySound('error');
    el.textContent += '\n[Error: ' + error + ']';
    el.removeAttribute('id');
    setChatBusy(false);
    // Errors abandon the current session — drop the saved id so a reload
    // doesn't resume a broken/bloated session and hit the same wall.
    currentSessionId = null;
    saveChat();
  }

  function clearChat() {
    chatMessagesEl.innerHTML = '';
    currentSessionId = null;
    chatHistory = [];
    clearReplyQuotes();
    saveChat();
    if (chatBusy) startAssistantMessage();
  }

  function stopChat() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'chat_cancel' }));
    }
    finalizeChatResponse(currentSessionId);
  }

  function scrollToBottom() {
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  // ── MCP server picker ──

  function requestMcpList(silent) {
    if (!ws || ws.readyState !== 1) return;
    // silent = background refresh: keep the current tiles on screen
    if (mcpListEl && !(silent && availableMcps.length)) {
      mcpListEl.innerHTML = '<span class="mcp-loading">loading…</span>';
      mcpFreshLoad = true;
    }
    ws.send(JSON.stringify({ type: 'list_mcps' }));
  }

  // Shared hover tooltip (CEF title tooltips are unreliable in panels).
  // Optional second line carries state detail (Connected / Click to
  // authorise / Error: <title> ...).
  var mcpTooltipEl = null;
  function showMcpTooltip(tile, text, detail) {
    hideMcpTooltip();
    mcpTooltipEl = document.createElement('div');
    mcpTooltipEl.className = 'mcp-tooltip';
    var title = document.createElement('div');
    title.textContent = text;
    mcpTooltipEl.appendChild(title);
    if (detail) {
      var d = document.createElement('div');
      d.className = 'tip-detail';
      d.textContent = detail;
      mcpTooltipEl.appendChild(d);
    }
    document.body.appendChild(mcpTooltipEl);
    var r = tile.getBoundingClientRect();
    var tt = mcpTooltipEl.getBoundingClientRect();
    var left = Math.max(4, Math.min(r.left + r.width / 2 - tt.width / 2, innerWidth - tt.width - 4));
    mcpTooltipEl.style.left = left + 'px';
    mcpTooltipEl.style.top = (r.top - tt.height - 4) + 'px';
  }
  function hideMcpTooltip() {
    if (mcpTooltipEl) { mcpTooltipEl.remove(); mcpTooltipEl = null; }
  }

  // Tile state (audit §4.6): amber = needs auth, red = failed,
  // blue = enabled (in the chat allowlist), no fill = available.
  function mcpTileState(s) {
    var connected = s.status.indexOf('Connected') !== -1;
    if (!connected && s.status.indexOf('auth') !== -1) return 'auth';
    if (!connected) return 'failed';
    return enabledMcps.indexOf(s.id) !== -1 ? 'enabled' : 'available';
  }

  var mcpFreshLoad = true; // fade tiles in on first population only

  function renderMcpList() {
    if (!mcpListEl) return;
    hideMcpTooltip();
    mcpListEl.innerHTML = '';
    if (!availableMcps.length) {
      var empty = document.createElement('span');
      empty.className = mcpListError ? 'mcp-error' : 'mcp-loading';
      empty.textContent = mcpListError || 'none registered';
      if (mcpListError) empty.title = mcpListError;
      mcpListEl.appendChild(empty);
      return;
    }
    var RANK = { enabled: 0, available: 1, auth: 2, failed: 3 };
    var sorted = availableMcps.slice().sort(function (a, b) {
      var r = RANK[mcpTileState(a)] - RANK[mcpTileState(b)];
      if (r !== 0) return r;
      // within a state: most used, then most recent, then name
      var ua = mcpUsage[a.id] || { count: 0, last: 0 };
      var ub = mcpUsage[b.id] || { count: 0, last: 0 };
      if (ub.count !== ua.count) return ub.count - ua.count;
      if (ub.last !== ua.last) return ub.last - ua.last;
      return a.displayName.localeCompare(b.displayName);
    });
    var fade = mcpFreshLoad;
    mcpFreshLoad = false;
    sorted.forEach(function (s, i) {
      var tile = buildMcpTile(s);
      if (fade) {
        tile.classList.add('fade-in');
        tile.style.animationDelay = Math.min(i * 20, 400) + 'ms';
      }
      mcpListEl.appendChild(tile);
    });
  }

  function monogram(name) {
    var words = name.replace(/\(.*\)/, '').trim().split(/\s+/);
    if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
    // one word: two letters, 'Ab' style
    var w = words[0] || name;
    return w.slice(0, 1).toUpperCase() + w.slice(1, 2).toLowerCase();
  }

  function buildMcpTile(s) {
    var state = mcpTileState(s);
    var tile = document.createElement('button');
    tile.className = 'mcp-tile ' + state + (pendingAuthId === s.id ? ' authing' : '');
    tile.dataset.mcpId = s.id;
    tile.addEventListener('mouseenter', function () {
      var st = mcpTileState(s);
      var detail;
      if (pendingAuthId === s.id) detail = 'Authorising…';
      else if (st === 'enabled') detail = 'Connected';
      else if (st === 'available') detail = 'Available';
      else if (st === 'auth') detail = 'Click to authorise';
      else detail = 'Error: ' + String(s.status || 'unknown').replace(/^[^a-zA-Z]+/, '');
      showMcpTooltip(tile, s.displayName, detail);
    });
    tile.addEventListener('mouseleave', hideMcpTooltip);
    // Tiles are vector-or-monogram, nothing else: bundled/CDN brand SVGs
    // render via currentColor; anything without a vector gets the
    // two-letter monogram. (Favicon masking removed — bad experience.)
    if (s.icon && s.icon.indexOf('image/svg') !== -1) {
      var span = document.createElement('span');
      span.className = 'gicon';
      span.innerHTML = atob(s.icon.split(',')[1]);
      tile.appendChild(span);
    } else {
      var mono = document.createElement('span');
      mono.className = 'monogram';
      mono.textContent = monogram(s.displayName);
      tile.appendChild(mono);
    }
    tile.addEventListener('click', function () {
      // state changes animate in place (CSS background transition);
      // sort order corrects on the next list refresh, not mid-click
      var st = mcpTileState(s);
      if (st === 'available' || st === 'enabled') {
        if (st === 'available') {
          enabledMcps.push(s.id);
          // enabling stamps recency so fresh picks pin left next refresh
          var u = mcpUsage[s.id] || { count: 0, last: 0 };
          u.last = Date.now();
          mcpUsage[s.id] = u;
        } else {
          enabledMcps = enabledMcps.filter(function (x) { return x !== s.id; });
        }
        saveChat();
        playMcpTick(st === 'available'); // 'available' → we just enabled it
        tile.classList.remove('enabled', 'available');
        tile.classList.add(mcpTileState(s));
      } else if (st === 'auth' && !pendingAuthId && ws && ws.readyState === 1) {
        pendingAuthId = s.id;
        ws.send(JSON.stringify({ type: 'auth_mcp', id: s.id }));
        tile.classList.add('authing');
      }
    });
    return tile;
  }

  // ── Version + update check ──

  var versionData = { version: 'dev', commit: null };
  var isDevInstall = false; // panel dir lives inside a git checkout
  var lastUpdateCheckAt = 0;
  try { lastUpdateCheckAt = Number(localStorage.getItem('gafferLastUpdateCheckAt')) || 0; } catch (e) { /* ignore */ }

  function renderLastUpdateCheck() {
    var el = document.getElementById('setLastCheck');
    if (!el) return;
    if (!lastUpdateCheckAt) { el.textContent = 'Never'; return; }
    var age = Math.max(0, Date.now() - lastUpdateCheckAt);
    if (age < 60000) el.textContent = 'Just now';
    else if (age < 3600000) el.textContent = Math.floor(age / 60000) + 'm ago';
    else if (age < 86400000) el.textContent = Math.floor(age / 3600000) + 'h ago';
    else el.textContent = new Date(lastUpdateCheckAt).toLocaleDateString();
  }

  function markUpdateChecked() {
    lastUpdateCheckAt = Date.now();
    try { localStorage.setItem('gafferLastUpdateCheckAt', String(lastUpdateCheckAt)); } catch (e) { /* ignore */ }
    renderLastUpdateCheck();
  }

  // A dev install symlinks the panel out of a git repo — tarball updates
  // would clobber uncommitted work (update.sh refuses too; this is the UX
  // half). Kernel path resolution follows the symlink, so <ext>/../.git
  // hits the repo's .git. ExtendScript File objects collapse ".." textually,
  // hence callSystem instead.
  function detectDevInstall() {
    var extPath = cs.getSystemPath(SystemPath.EXTENSION);
    var p = extPath.replace(/'/g, "\\'");
    // One shell-out: confirm the repo AND read the live HEAD. Kernel path
    // resolution follows the symlink, so <ext>/.. is the repo root. Append
    // '+' when the working tree is dirty. Returns "dev:<hash>[+]" or "prod".
    var jsx = '(function(){'
      + 'if ($.os.indexOf("Windows") !== -1) return "prod";'
      + 'return system.callSystem("bash -c \'D=\\"' + p + '/..\\"; if test -d \\"$D/.git\\"; then h=$(git -C \\"$D\\" rev-parse --short HEAD 2>/dev/null); git -C \\"$D\\" diff --quiet 2>/dev/null || h=\\"$h+\\"; echo \\"dev:$h\\"; else echo prod; fi\'");'
      + '})()';
    cs.evalScript(jsx, function (result) {
      var s = String(result);
      isDevInstall = s.indexOf('dev') === 0;
      if (!isDevInstall) return;
      availableUpdateCommit = null;
      updateBannerEl.classList.remove('visible');
      syncSettingsUpdateButton();
      // Show the REAL git HEAD, not the frozen version.json commit.
      var m = s.match(/dev:([0-9a-f]{4,}\+?)/i);
      if (m && m[1]) {
        var base = versionTextEl.textContent.replace(/\s*\([0-9a-f]+\)/i, '');
        versionTextEl.textContent = base + ' (' + m[1] + ')';
        // Keep update state and the visible dev label on the same live HEAD.
        // The trailing + is a dirty-tree display marker, not part of the hash.
        versionData.commit = m[1].replace(/\+$/, '');
      }
      versionTextEl.textContent = versionTextEl.textContent + ' · dev';
      versionTextEl.title = 'Dev install — build number is the live git HEAD'
        + (m && m[1] && m[1].charAt(m[1].length - 1) === '+' ? ' (uncommitted changes present)' : '')
        + '. Update with git pull, not the panel updater.';
    });
  }

  function loadVersion() {
    var path = cs.getSystemPath(SystemPath.EXTENSION) + '/version.json';
    var jsx = "(function(){var f=new File('" + path.replace(/'/g, "\\'") + "');if(!f.exists)return '';f.open('r');var d=f.read();f.close();return d;})()";
    cs.evalScript(jsx, function (result) {
      if (result && result !== 'undefined') {
        try {
          versionData = JSON.parse(result);
          var label = 'v' + (versionData.version || 'dev');
          if (versionData.commit) label += ' (' + versionData.commit.substring(0, 7) + ')';
          versionTextEl.textContent = label;
          // An update remembered from a dismissed banner may since have been
          // installed outside this panel. Reconcile it against the local stamp.
          if (availableUpdateCommit === versionData.commit) availableUpdateCommit = null;
          syncSettingsUpdateButton();
        } catch (e) { /* ignore */ }
      } else {
        versionTextEl.textContent = 'v(dev)';
      }
      detectDevInstall(); // after label is set — it appends to it
      // Post-update verdict: if we attempted an update just before this
      // reload and the commit didn't move, the script failed — say so.
      try {
        var attempt = JSON.parse(localStorage.getItem('gafferUpdateAttempt') || 'null');
        if (attempt && attempt.target && Date.now() - attempt.at < 10 * 60 * 1000) {
          localStorage.removeItem('gafferUpdateAttempt');
          if (versionData.commit !== attempt.target) {
            showChatNotice('Update did not complete — the updater log has details: '
              + '%TEMP%\\gaffer-update.log (Windows) / /tmp/gaffer-update.log (macOS). '
              + 'You can also run the update script manually from the daemon folder.');
          }
        } else if (attempt) {
          localStorage.removeItem('gafferUpdateAttempt');
        }
      } catch (e) { /* ignore */ }
    });
  }

  function checkForUpdate(silent) {
    if (isDevInstall) {
      availableUpdateCommit = null;
      updateBannerEl.classList.remove('visible');
      syncSettingsUpdateButton();
      markUpdateChecked();
      if (!silent) showModal('Dev install (git checkout) — the panel updater is disabled. Pull changes with git instead.');
      return;
    }
    // Fetch remote version.json directly — content match means same release.
    // Avoids commit-hash chicken-and-egg from amend hooks.
    fetch('https://raw.githubusercontent.com/spendolas/gaffer-ae/main/panel/version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (remote) {
        if (!remote || !remote.commit) throw new Error('Invalid version response');
        markUpdateChecked();
        if (!versionData.commit) {
          if (!silent) showModal('Local version unknown. Reinstall to enable updates.');
          return;
        }
        if (remote.commit === versionData.commit) {
          availableUpdateCommit = null;
          updateBannerEl.classList.remove('visible');
          syncSettingsUpdateButton();
          if (!silent) showModal('Gaffer is up to date (' + remote.commit.substring(0, 7) + ')');
          return;
        }
        // Availability is durable for the session; banner dismissal is only a
        // presentation preference and must never remove the Settings safeguard.
        availableUpdateCommit = remote.commit;
        syncSettingsUpdateButton();
        if (remote.commit === dismissedUpdateCommit) return;
        updateTextEl.textContent = 'Update available — v' + remote.version;
        updateBannerEl.classList.add('visible');
        syncSettingsUpdateButton();
      }).catch(function (e) {
        markUpdateChecked();
        if (!silent) showModal('Update check failed: ' + e.message);
      });
  }

  function runUpdate() {
    if (isDevInstall) {
      availableUpdateCommit = null;
      showModal('Dev install (git checkout) — the panel updater is disabled. Pull changes with git instead.');
      updateBannerEl.classList.remove('visible');
      syncSettingsUpdateButton();
      return;
    }
    if (chatBusy) {
      showModal('Please wait for current response to finish before updating.');
      return;
    }
    var extPath = cs.getSystemPath(SystemPath.EXTENSION);
    var daemonDir = extPath + '/daemon';

    function reloadAfterUpdate() {
      // The updater needs ~30-60s (download + npm). Poll the on-disk
      // version.json and reload ONLY once the commit moves — reloading
      // early would load half-copied files and flag a false failure.
      try {
        localStorage.setItem('gafferUpdateAttempt', JSON.stringify({
          target: availableUpdateCommit || null,
          at: Date.now(),
        }));
      } catch (e) { /* ignore */ }
      updateTextEl.textContent = 'Updating…';
      var actionsEl = updateBannerEl.querySelector('.actions');
      if (actionsEl) actionsEl.style.display = 'none'; // no CTAs mid-update
      window.__gafferUpdating = true; // pauses daemon auto-respawn
      syncSettingsUpdateButton(); // prevent a second update launch from Settings
      var startCommit = versionData.commit;
      var path = cs.getSystemPath(SystemPath.EXTENSION) + '/version.json';
      var jsx = "(function(){var f=new File('" + path.replace(/'/g, "\\'") + "');if(!f.exists)return '';f.open('r');var d=f.read();f.close();return d;})()";
      var waited = 0;
      var timer = setInterval(function () {
        waited += 5000;
        cs.evalScript(jsx, function (result) {
          var commit = null;
          try { commit = JSON.parse(result).commit; } catch (e) { /* mid-write */ }
          if (commit && commit !== startCommit) {
            clearInterval(timer);
            try { localStorage.removeItem('gafferUpdateAttempt'); } catch (e) { /* ignore */ }
            location.reload(); // fresh panel + fresh daemon
          } else if (waited >= 180000) {
            clearInterval(timer);
            window.__gafferUpdating = false;
            updateBannerEl.classList.remove('visible');
            syncSettingsUpdateButton();
            if (actionsEl) actionsEl.style.display = '';
            showChatNotice('Update did not complete — the updater log has details: '
              + '%TEMP%\\gaffer-update.log (Windows) / /tmp/gaffer-update.log (macOS).');
          }
        });
      }, 5000);
    }

    function runViaExtendScript() {
      var jsx = '(function(){'
        + 'var isWin = $.os.indexOf("Windows") !== -1;'
        + 'var dir = "' + extPath.replace(/\\/g, '/') + '/daemon";'
        + 'if (isWin) return system.callSystem("powershell -NoProfile -ExecutionPolicy Bypass -File \\"" + dir + "/update.ps1\\"");'
        + 'return system.callSystem("bash \\"" + dir + "/update.sh\\"");'
        + '})()';
      cs.evalScript(jsx, function (result) {
        console.log('Gaffer: update result (ExtendScript):', result);
        reloadAfterUpdate();
      });
    }

    // Prefer Node spawn (Apple Silicon-safe), fall back to ExtendScript.
    if (typeof require !== 'undefined') {
      try {
        var cp = require('child_process');
        var isWin = process.platform === 'win32';
        var cmd, args;
        if (isWin) {
          // absolute path — CEP's stripped PATH may not resolve bare
          // 'powershell', and spawn failures are ASYNC (error event), so a
          // bad resolution used to look like a successful no-op
          cmd = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
          args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', daemonDir + '\\update.ps1'];
        } else {
          cmd = 'bash';
          args = [daemonDir + '/update.sh'];
        }
        // stdio must be real file handles: detached + stdio:'ignore' silently
        // kills the child on some Node/Windows combos (verified on Win11) —
        // the daemon spawn survives for exactly this reason
        var ufs = require('fs');
        var ulog = isWin
          ? (process.env.TEMP || 'C:\\Windows\\Temp') + '\\gaffer-update-spawn.log'
          : '/tmp/gaffer-update-spawn.log';
        var uout = ufs.openSync(ulog, 'a');
        // Windows: detached kills the child silently on Node v24 combos
        // (verified isolation table in the field handoff); the child
        // survives location.reload() anyway — CEP's Node context is
        // process-scoped, not document-scoped. Mac keeps detached (proven).
        var child = cp.spawn(cmd, args, { detached: !isWin, stdio: ['ignore', uout, uout], windowsHide: true });
        var spawnFailed = false;
        child.on('error', function (e) {
          spawnFailed = true;
          console.error('Gaffer: Node spawn of updater failed — ExtendScript fallback', e);
          runViaExtendScript();
        });
        child.unref();
        // spawn errors surface asynchronously — give them a beat before
        // declaring victory and reloading
        setTimeout(function () {
          if (!spawnFailed) {
            console.log('Gaffer: update spawned via Node');
            reloadAfterUpdate();
          }
        }, 400);
        return;
      } catch (e) {
        console.error('Gaffer: update spawn (Node) failed, falling back', e);
      }
    }

    runViaExtendScript();
  }

  function dismissUpdate() {
    if (availableUpdateCommit) {
      dismissedUpdateCommit = availableUpdateCommit;
      saveChat();
    }
    updateBannerEl.classList.remove('visible');
    syncSettingsUpdateButton();
  }

  // ── Input handlers ──

  sendBtnEl.addEventListener('click', sendChatMessage);
  stopBtnEl.addEventListener('click', stopChat);
  // Clear/Reload live inside <summary> — preventDefault stops the click
  // from also toggling the details element.
  // Action spell (291:11938) — hover description in the summary row for
  // the left-cluster controls. Fades with the shared 0.15s state ease.
  var actionSpellEl = document.getElementById('actionSpell');
  function wireSpell(el, getText) {
    if (!el || !actionSpellEl) return;
    el.addEventListener('mouseenter', function () {
      actionSpellEl.textContent = getText();
      actionSpellEl.classList.add('visible');
    });
    el.addEventListener('mouseleave', function () {
      actionSpellEl.classList.remove('visible');
    });
  }
  wireSpell(statusWrapEl, function () {
    return 'Gaffer ' + (statusWrapEl.title || 'starting').toLowerCase();
  });
  wireSpell(clearBtnEl, function () { return clearBtnEl.title || 'Clear chat'; });
  wireSpell(document.getElementById('reloadBtn'), function () {
    return document.getElementById('reloadBtn').title || 'Reload panel';
  });

  clearBtnEl.addEventListener('click', function (e) {
    e.preventDefault();
    showModal("This clears the current conversation and can't be undone.", {
      title: 'Clear chat?', confirmLabel: 'Clear', cancelLabel: 'Cancel',
      danger: true, onConfirm: clearChat
    });
  });
  document.getElementById('reloadBtn').addEventListener('click', function (e) {
    e.preventDefault();
    location.reload();
  });

  // ── Custom selects (Figma atom): model, context variant, effort ──
  // Model + effort options are NOT hardcoded — opening Settings asks the
  // daemon to discover them afresh from the installed CLI (`claude --help`)
  // and current CLI state. These are only the pre-response fallbacks.
  function labelize(v) {
    if (typeof v !== 'string') return '';
    if (v === 'xhigh') return 'Extra High';
    if (v === '1m') return '1M';
    // A restored pinned version can briefly precede the fresh model response,
    // so don't expose the internal select value while its options rebuild.
    if (v.indexOf('id:') === 0) {
      var pinned = v.substring(3);
      var oneM = /\[1m\]$/.test(pinned);
      if (oneM) pinned = pinned.replace(/\[1m\]$/, '');
      return versionLabel(pinned) + (oneM ? ' · 1M' : '');
    }
    return v.charAt(0).toUpperCase() + v.slice(1);
  }
  var MODELS = ['fable', 'opus', 'sonnet', 'haiku'].map(function (v) { return { value: v, label: labelize(v) }; });
  // Variant = version x context (ref: "Latest", "Latest · 1M", "4.6",
  // "4.6 · 1M"...). 1M is offered only when the daemon's fresh capability
  // response says the selected model supports it; pinned versions come from
  // the daemon's CLI-state discovery and are full ids carried as
  // 'id:<full-id>'.
  var modelVersions = {}; // family -> [full ids], daemon-pushed
  var modelCapabilities = null; // key -> { oneM, efforts, entitlement }
  function versionLabel(id) {
    return id.replace(/^claude-[a-z]+-/, '').replace(/-\d{8}$/, '').replace(/-/g, '.');
  }
  function supportsOneM(key) {
    var caps = modelCapabilities && modelCapabilities[key];
    return !!(caps && caps.oneM);
  }
  function variantOptionsFor(family) {
    var opts = [{ value: 'standard', label: 'Latest' }];
    if (supportsOneM(family)) opts.push({ value: '1m', label: 'Latest · 1M' });
    (modelVersions[family] || []).forEach(function (id) {
      opts.push({ value: 'id:' + id, label: versionLabel(id) });
      if (supportsOneM(id)) opts.push({ value: 'id:' + id + '[1m]', label: versionLabel(id) + ' · 1M' });
    });
    return opts;
  }
  // Effort is a custom dot-slider (not a popup select). EFFORT_LEVELS is the
  // full ordered scale; discoveredEfforts is what the current daemon/model
  // actually allows (defaults to the full scale until the daemon reports).
  var EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
  var discoveredEfforts = EFFORT_LEVELS.slice();
  // globalEfforts: the daemon's back-compat/fallback list (data.efforts), used
  // when effortsByModel is absent or has no entry for the current model.
  var globalEfforts = EFFORT_LEVELS.slice();
  // effortsByModel: per-model efforts map from the daemon
  // ({ modelId: [efforts...] }). An explicit [] means the model has no effort
  // control; null means an older daemon has not sent capability data yet.
  var effortsByModel = null;
  // Generic popup select: options is [{value,label}], get/set close over the
  // state var. Popup goes position:fixed on open so the drawer's
  // overflow:hidden (animation requirement) can't clip it. Returned handle
  // exposes update() and setOptions() for CLI-discovered rebuilds.
  function makeSelect(btnEl, popupEl, labelEl, options, get, set) {
    function update() {
      var cur = null;
      for (var i = 0; i < options.length; i++) if (options[i].value === get()) cur = options[i];
      labelEl.textContent = cur ? cur.label : labelize(get());
      var opts = popupEl.querySelectorAll('.option');
      for (var j = 0; j < opts.length; j++) {
        opts[j].classList.toggle('selected', opts[j].dataset.value === get());
      }
    }
    function build() {
      popupEl.innerHTML = '';
      options.forEach(function (o) {
        var opt = document.createElement('span');
        opt.className = 'option';
        opt.dataset.value = o.value;
        opt.textContent = o.label;
        opt.addEventListener('click', function () {
          set(o.value);
          popupEl.hidden = true;
          update();
          saveChat();
        });
        popupEl.appendChild(opt);
      });
    }
    build();
    btnEl.addEventListener('click', function (e) {
      e.preventDefault();
      popupEl.hidden = !popupEl.hidden;
      if (!popupEl.hidden) {
        var r = btnEl.getBoundingClientRect();
        var s = popupEl.style;
        s.position = 'fixed';
        s.left = r.left + 'px';
        s.bottom = (window.innerHeight - r.top + 2) + 'px';
        s.minWidth = r.width + 'px';
      }
      update();
    });
    document.addEventListener('click', function (e) {
      if (!popupEl.hidden && !btnEl.contains(e.target) && !popupEl.contains(e.target)) {
        popupEl.hidden = true;
      }
    });
    return {
      update: update,
      setOptions: function (next) { options = next; build(); update(); },
    };
  }
  var modelSelect = makeSelect(
    modelSelectBtnEl, modelSelectPopupEl, modelSelectLabelEl, MODELS,
    function () { return currentModel; },
    function (v) {
      currentModel = v;
      rebuildVariantSelect(); // versions are family-specific
      applyEffortsForModel(); // dot count + clamp follow the new model
      renderEffort(); // keep the effort slider consistent on model switch
    }
  );
  var variantSelect = makeSelect(
    document.getElementById('setVariantBtn'), document.getElementById('setVariantPopup'),
    document.getElementById('setVariantLabel'), variantOptionsFor(currentModel),
    function () { return currentVariant; }, function (v) {
      currentVariant = v;
      applyEffortsForModel();
      renderEffort();
    }
  );
  function rebuildVariantSelect() {
    var opts = variantOptionsFor(currentModel);
    var valid = false;
    for (var i = 0; i < opts.length; i++) if (opts[i].value === currentVariant) valid = true;
    if (!valid) currentVariant = 'standard'; // pinned version orphaned by model switch
    variantSelect.setOptions(opts);
  }
  var updateModelSelect = modelSelect.update;
  var updateVariantSelect = variantSelect.update;
  // Given an effort no longer in `levels`, return the closest one on the full
  // EFFORT_LEVELS scale (so 'max' clamps to the highest still-allowed level).
  function nearestEffort(target, levels) {
    if (levels.indexOf(target) >= 0) return target;
    var ti = EFFORT_LEVELS.indexOf(target);
    if (ti < 0) return levels[0];
    var best = levels[0], bestDist = Infinity;
    for (var i = 0; i < levels.length; i++) {
      var li = EFFORT_LEVELS.indexOf(levels[i]);
      if (li < 0) continue;
      var dist = Math.abs(li - ti);
      if (dist < bestDist) { bestDist = dist; best = levels[i]; }
    }
    return best;
  }
  // Resolve discoveredEfforts for the CURRENT model: prefer
  // effortsByModel[currentModel] (daemon-supplied, per-model) when present and
  // non-empty, else fall back to the global list. Re-clamps currentEffort to
  // the nearest level still valid on the resolved list. Safe to call even
  // when effortsByModel is null (old daemon) — falls straight through to
  // globalEfforts, same behavior as before this per-model wiring existed.
  function applyEffortsForModel() {
    var selectedKey = currentVariant.indexOf('id:') === 0 ? currentVariant.slice(3) : currentModel;
    var hasPerModel = effortsByModel && Object.prototype.hasOwnProperty.call(effortsByModel, selectedKey);
    var perModel = hasPerModel ? effortsByModel[selectedKey] : null;
    var levels = hasPerModel ? (Array.isArray(perModel) ? perModel : []) : globalEfforts;
    discoveredEfforts = levels.slice();
    currentEffort = discoveredEfforts.length ? nearestEffort(currentEffort, discoveredEfforts) : null;
  }
  function applyModelOptions(data) {
    if (data.capabilitiesByModel && typeof data.capabilitiesByModel === 'object') {
      modelCapabilities = data.capabilitiesByModel;
    }
    if (Array.isArray(data.models) && data.models.length) {
      modelSelect.setOptions(data.models.map(function (v) { return { value: v, label: labelize(v) }; }));
    }
    if (data.effortsByModel && typeof data.effortsByModel === 'object') {
      effortsByModel = data.effortsByModel;
    }
    if (Array.isArray(data.efforts) && data.efforts.length) {
      globalEfforts = data.efforts.slice();
    }
    if (effortsByModel || (Array.isArray(data.efforts) && data.efforts.length)) {
      applyEffortsForModel(); // dot count follows the current model's set
      renderEffort();
    }
    if (data.versions && typeof data.versions === 'object') {
      modelVersions = data.versions;
      rebuildVariantSelect();
    }
  }

  // ── Effort dot-slider (Settings modal, 484:30131) ──
  // Custom <div> slider (never a native range): renders exactly
  // discoveredEfforts.length dots + a thumb inserted after the active index.
  // Click or drag the thumb; snaps to the nearest dot. Pointer-capture pattern
  // (preventDefault + setPointerCapture + window-level move/up) keeps the drag
  // bound to the slider under mouse/pen/touch even as the dots rebuild mid-drag.
  var DOT_FIG = ['484:30421', '484:31057', '484:31060', '484:31051', '484:31054'];
  var CIRC_FIG = ['484:30422', '484:31058', '484:31061', '484:31052', '484:31055'];
  function renderEffort() {
    var levels = discoveredEfforts;
    var lbl = document.getElementById('setEffortLabel');
    var slider = document.getElementById('setEffortDots');
    if (!levels.length) {
      currentEffort = null;
      if (lbl) lbl.textContent = 'Unavailable';
      if (slider) { slider.hidden = true; slider.innerHTML = ''; }
      return;
    }
    if (slider) slider.hidden = false;
    if (levels.indexOf(currentEffort) < 0) currentEffort = nearestEffort(currentEffort, levels);
    var idx = levels.indexOf(currentEffort); if (idx < 0) idx = 0;
    if (lbl) lbl.textContent = labelize(currentEffort);
    if (!slider) return;
    slider.innerHTML = '';
    var n = levels.length;
    // n dots, evenly space-between; the thumb + fill are ABSOLUTE overlays so the
    // thumb can follow the pointer freely during a drag and ease into the nearest
    // dot on release. Dots d<idx are "on" (blue); the thumb sits over dot[idx].
    for (var d = 0; d < n; d++) {
      var dt = document.createElement('span'); dt.className = 'e-dot' + (d <= idx ? ' on' : '');
      if (DOT_FIG[d]) dt.setAttribute('data-fig', 'I484:27883;' + DOT_FIG[d]);
      var circ = document.createElement('span'); circ.className = 'e-circ';
      if (CIRC_FIG[d]) circ.setAttribute('data-fig', 'I484:27883;' + CIRC_FIG[d]);
      dt.appendChild(circ); slider.appendChild(dt);
    }
    // Filled "handle" region (484:30252) grows from the left to the thumb; the
    // thumb (484:30631) + knob (484:30565) ride at its leading edge.
    var fill = document.createElement('span'); fill.className = 'e-fill';
    fill.setAttribute('data-fig', 'I484:27883;484:30252');
    var thumb = document.createElement('span'); thumb.className = 'e-thumb';
    thumb.setAttribute('data-fig', 'I484:27883;484:30631');
    var knob = document.createElement('span'); knob.className = 'e-knob';
    knob.setAttribute('data-fig', 'I484:27883;484:30565');
    thumb.appendChild(knob);
    slider.appendChild(fill); slider.appendChild(thumb);
    settleEffortToIdx(idx, false); // instant placement on a full render
  }
  // Track-relative center x of dot `idx` (measured live; even-split fallback).
  function effortDotCenterPx(idx) {
    var slider = document.getElementById('setEffortDots');
    if (!slider) return 0;
    var sr = slider.getBoundingClientRect();
    var dots = slider.querySelectorAll('.e-dot');
    if (dots[idx] && sr.width > 0) {
      var dr = dots[idx].getBoundingClientRect();
      return (dr.left + dr.width / 2) - sr.left;
    }
    var n = discoveredEfforts.length;
    return n > 1 ? (idx / (n - 1)) * (sr.width || 184) : 0;
  }
  // Nearest dot index to a track-relative x (measures live dot centers).
  function effortNearestIdx(px) {
    var slider = document.getElementById('setEffortDots');
    var n = discoveredEfforts.length;
    if (!slider || n <= 1) return 0;
    var sr = slider.getBoundingClientRect();
    var dots = slider.querySelectorAll('.e-dot');
    if (dots.length !== n || sr.width <= 0) {
      return Math.round(Math.max(0, Math.min(1, px / (sr.width || 184))) * (n - 1));
    }
    var best = 0, bd = Infinity;
    for (var i = 0; i < dots.length; i++) {
      var dr = dots[i].getBoundingClientRect();
      var c = (dr.left + dr.width / 2) - sr.left;
      var dist = Math.abs(px - c);
      if (dist < bd) { bd = dist; best = i; }
    }
    return best;
  }
  // Place the thumb + fill at track-x `px` (clamped). Does not change the effort.
  function positionEffortThumb(px) {
    var slider = document.getElementById('setEffortDots');
    if (!slider) return;
    var w = slider.clientWidth || 184;
    px = Math.max(0, Math.min(w, px));
    var thumb = slider.querySelector('.e-thumb');
    var fill = slider.querySelector('.e-fill');
    if (thumb) thumb.style.left = px + 'px';
    // Fill wraps the knob on its right too: extend past the thumb centre by the
    // knob half-width (8) + Figma's 2px pad, so the knob sits INSIDE the fill
    // pill with an even 2px margin on top/right/bottom (Figma 484:30252 pad 2).
    if (fill) fill.style.width = Math.min(w, px + 10) + 'px';
  }
  // Snap the thumb to dot `idx` — animated (ease into place) or instant.
  function settleEffortToIdx(idx, animate) {
    var slider = document.getElementById('setEffortDots');
    if (!slider) return;
    var thumb = slider.querySelector('.e-thumb'), fill = slider.querySelector('.e-fill');
    var px = effortDotCenterPx(idx);
    if (!animate) {
      if (thumb) thumb.style.transition = 'none';
      if (fill) fill.style.transition = 'none';
      positionEffortThumb(px);
      if (thumb) { void thumb.offsetWidth; thumb.style.transition = ''; }
      if (fill) fill.style.transition = '';
    } else {
      positionEffortThumb(px); // CSS transition eases it into place
    }
  }
  // Live-update currentEffort + label + dot colors to the level nearest track-x
  // `px` during a drag (the thumb itself follows the finger, not the dot).
  function updateEffortFromPx(px) {
    var idx = effortNearestIdx(px);
    var v = discoveredEfforts[idx];
    if (v) {
      currentEffort = v;
      var lbl = document.getElementById('setEffortLabel'); if (lbl) lbl.textContent = labelize(v);
      var slider = document.getElementById('setEffortDots');
      var dots = slider ? slider.querySelectorAll('.e-dot') : [];
      for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('on', d <= idx);
    }
    return idx;
  }
  // Programmatic set (model clamp / restore): snap to a dot, full render.
  function applyEffortIndex(i) {
    if (!discoveredEfforts.length) return;
    i = Math.max(0, Math.min(discoveredEfforts.length - 1, i));
    var v = discoveredEfforts[i];
    if (v && v !== currentEffort) { currentEffort = v; renderEffort(); }
  }
  // Re-place the thumb once the modal is actually laid out (measurement needs a
  // visible track) — call after opening Settings.
  function relayoutEffort() {
    if (!discoveredEfforts.length) return;
    var i = discoveredEfforts.indexOf(currentEffort); if (i < 0) i = 0;
    settleEffortToIdx(i, false);
  }
  var effortDragging = false;
  function wireEffortSlider() {
    var slider = document.getElementById('setEffortDots');
    if (!slider || slider._effortWired) return;
    slider._effortWired = true;
    function trackX(clientX) { return clientX - slider.getBoundingClientRect().left; }
    function startDrag(clientX) {
      effortDragging = true;
      slider.classList.add('dragging'); // transition off → thumb tracks the finger 1:1
      var px = trackX(clientX);
      positionEffortThumb(px); updateEffortFromPx(px);
    }
    function moveDrag(clientX) {
      if (!effortDragging) return;
      var px = trackX(clientX);
      positionEffortThumb(px); updateEffortFromPx(px);
    }
    function endDrag() {
      if (!effortDragging) return;
      effortDragging = false;
      slider.classList.remove('dragging'); // restore transition
      var idx = discoveredEfforts.indexOf(currentEffort); if (idx < 0) idx = 0;
      settleEffortToIdx(idx, true); // ease the thumb into the nearest dot
      saveChat();
    }
    slider.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { slider.setPointerCapture(e.pointerId); } catch (_) {}
      startDrag(e.clientX);
    });
    window.addEventListener('pointermove', function (e) { moveDrag(e.clientX); });
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // Mouse + touch fallbacks: CEP's Chromium 99 delivers only real MouseEvents
    // (and touch) for real HID input — NOT PointerEvents. The effortDragging guard
    // + pointerdown's preventDefault prevent double-processing where pointer fires.
    slider.addEventListener('mousedown', function (e) { e.preventDefault(); startDrag(e.clientX); });
    window.addEventListener('mousemove', function (e) { moveDrag(e.clientX); });
    window.addEventListener('mouseup', endDrag);
    slider.addEventListener('touchstart', function (e) { if (!e.touches[0]) return; e.preventDefault(); startDrag(e.touches[0].clientX); }, { passive: false });
    window.addEventListener('touchmove', function (e) { if (!effortDragging || !e.touches[0]) return; e.preventDefault(); moveDrag(e.touches[0].clientX); }, { passive: false });
    window.addEventListener('touchend', endDrag);
    window.addEventListener('touchcancel', endDrag);
  }

  // Sounds cue picker (Settings modal) — a real dropdown over the cue
  // candidates; choosing one previews it (if sound is on) and persists.
  var soundSelect = makeSelect(
    document.getElementById('setSoundBtn'), document.getElementById('setSoundPopup'),
    document.getElementById('setSoundLabel'),
    SOUND_CANDIDATES.map(function (c) { return { value: c.id, label: c.label }; }),
    function () { return soundVariant; },
    // Picking a cue always previews it — hearing the option is the whole point
    // of the picker, independent of whether reply sounds are enabled.
    function (v) { soundVariant = v; playSelectedCue(); }
  );

  // (Legacy inline sound cue-cycle button + reply-sound toggle removed \u2014 the
  //  Settings modal's soundSelect dropdown + setSoundOn toggle own this now.)

  // Text-size stepper: scales the chat reading surface via --chat-text.
  var textDecEl = document.getElementById('textDecBtn');
  var textIncEl = document.getElementById('textIncBtn');
  var textResetEl = document.getElementById('textResetBtn');
  if (textDecEl) textDecEl.appendChild(icon('minus'));
  if (textResetEl) textResetEl.appendChild(icon('textSize'));
  if (textIncEl) textIncEl.appendChild(icon('plus'));
  function applyTextScale() {
    // clamp + snap to the step grid so restored/legacy values stay clean
    textScale = Math.max(TEXT_MIN, Math.min(TEXT_MAX, Math.round(textScale / TEXT_STEP) * TEXT_STEP));
    // set on :root so BOTH the chat log and the composer (which sits
    // outside .chat-messages) inherit the factor
    document.documentElement.style.setProperty('--chat-text', textScale);
    // Figma design carries no numeric readout — the glyph is the only label;
    // the current percent rides the reset button's tooltip instead.
    if (textResetEl) textResetEl.title = 'Reset chat text size (' + Math.round(textScale * 100) + '%)';
    if (textDecEl) textDecEl.disabled = textScale <= TEXT_MIN + 1e-6;
    if (textIncEl) textIncEl.disabled = textScale >= TEXT_MAX - 1e-6;
    resizeChatInput(); // re-fit the composer to the new line height
    refitReplyQuotes(); // re-fit the reply tray to the reflowed quote text
  }
  // Auto-grow the composer against a cap, both scaled by --chat-text so the
  // 8-line ceiling stays 8 lines at any text size.
  function resizeChatInput() {
    if (!chatInputEl) return;
    // Pin the composer's font to the FINAL scaled px, bypassing the animated
    // --chat-text var. Otherwise, when text-size changes, the var is still
    // easing (0.18s @property transition) and scrollHeight is measured against
    // a transient font — on shrink that fakes an overflow, wrongly latches
    // `.wrapped` (bottom-align) on the empty field, and the placeholder sits
    // low. The reading surface still animates; the JS-driven textarea can't
    // smoothly animate its height anyway, so an instant composer resize is fine.
    chatInputEl.style.fontSize = (14 * textScale) + 'px';
    chatInputEl.style.lineHeight = (18 * textScale) + 'px';
    var line = Math.round(18 * textScale);
    var cap = Math.round(144 * textScale); // 8 lines
    chatInputEl.style.height = line + 'px';
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, cap) + 'px';
    chatInputEl.style.overflowY = chatInputEl.scrollHeight > cap ? 'auto' : 'hidden';
    // Bottom-align (.wrapped) only once content has actually wrapped past a
    // single line — a +1px tolerance absorbs the fractional-DPI rounding
    // noted above so a true single line never falsely triggers it. Below
    // that, stay centered (matches placeholder / idle) so the first line
    // never jumps on the first keystroke; it grows downward from there.
    chatInputEl.classList.toggle('wrapped', chatInputEl.scrollHeight > line + 1);
  }
  function nudgeTextScale(delta) {
    textScale += delta;
    applyTextScale();
    saveChat();
  }
  // The whole control lives inside <summary>. Catch-all: ANY click over
  // the pill (buttons, gaps, disabled buttons, the container itself)
  // preventDefaults so it never expands the drawer — the summary handler
  // bails on defaultPrevented, same contract as Clear/Reload.
  var textSizeEl = textDecEl && textDecEl.parentNode;
  if (textSizeEl) textSizeEl.addEventListener('click', function (e) { e.preventDefault(); });
  if (textDecEl) textDecEl.addEventListener('click', function () { nudgeTextScale(-TEXT_STEP); });
  if (textIncEl) textIncEl.addEventListener('click', function () { nudgeTextScale(TEXT_STEP); });
  if (textResetEl) textResetEl.addEventListener('click', function () { textScale = 1; applyTextScale(); saveChat(); });
  // Hover descriptions ride the action spell like the other left-cluster
  // controls (native CEF title tooltips don't render in the panel). The
  // centre glyph doubles as the readout — it shows the current percent.
  wireSpell(textDecEl, function () { return 'Smaller text'; });
  wireSpell(textResetEl, function () { return 'Text size ' + Math.round(textScale * 100) + '% · tap to reset'; });
  wireSpell(textIncEl, function () { return 'Larger text'; });
  applyTextScale(); // initialize label + disabled states at load

  // Auto-check, Save-tokens (Scrooge) and Check-now are owned by the Settings
  // modal now (setAutoCheck / setScrooge / setCheckNowBtn handlers below).
  // Drawer expand/collapse is class-driven with a height transition —
  // native <details> toggling can't animate, so it stays `open` and the
  // .expanded class shows/hides the animated .activity-body.
  var activityEl = document.querySelector('.activity-log');
  function activityExpanded() {
    return activityEl && activityEl.classList.contains('expanded');
  }
  // Hover-spell for the two summary-row cluster buttons that lacked it: the
  // Settings gear, and the now-icon-only expand chevron (its More/Less label
  // moved from inline text to the hover-spell).
  wireSpell(document.getElementById('settingsBtn'), function () {
    return document.getElementById('settingsBtn').title || 'Settings';
  });
  wireSpell(document.querySelector('.activity-more'), function () {
    return activityExpanded() ? 'Less' : 'More';
  });
  // No refresh button — the list refreshes under the hood: on expand,
  // then every 60s while the drawer stays open (silent, no flicker).
  setInterval(function () {
    if (activityExpanded()) requestMcpList(true);
  }, 60000);
  if (activityEl) {
    // The summary row must never auto-toggle on its own — only the expand
    // button (.activity-more) drives .expanded. Block native <details>
    // click-to-toggle for the whole row (status text, toolbar icons, etc.).
    activityEl.querySelector('summary').addEventListener('click', function (e) {
      e.preventDefault(); // keep the native details from toggling
    });
    var activityMoreEl = document.querySelector('.activity-more');
    if (activityMoreEl) activityMoreEl.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation(); // don't also run the summary's own click handler
      var expanded = activityEl.classList.toggle('expanded');
      if (expanded) requestMcpList(availableMcps.length > 0);
      // More <-> Less, chevron flips (Figma summary affordance)
      if (moreLabelEl) moreLabelEl.textContent = expanded ? 'Less' : 'More';
      if (moreChevronEl && typeof GafferIcons !== 'undefined') {
        moreChevronEl.innerHTML = GafferIcons[expanded ? 'chevronUp' : 'chevronDown'];
      }
    });
  }
  updateBtnEl.addEventListener('click', runUpdate);
  dismissUpdateBtnEl.addEventListener('click', dismissUpdate);
  chatInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  // Typed state + auto-grow (Figma InputRow mode=typed: field grows to 2+ lines)
  chatInputEl.addEventListener('input', function () {
    updateChatEnabled(); // recompute .typed + disabled from current content
    resizeChatInput();
  });

  // NOTE: Cmd+C/V/X/A are intercepted by AE at the app level before reaching
  // the panel JS. registerKeyEventsInterest doesn't work in CEP 12 for these.
  // Copy is handled via Copy buttons on each message instead.

  // ── Auth wiring ──
  function sendWs(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  var b;
  if ((b = document.getElementById('signInClaude'))) b.addEventListener('click', function () { sendWs({ type: 'sign_in', mode: 'claudeai' }); });
  if ((b = document.getElementById('signInConsole'))) b.addEventListener('click', function () { sendWs({ type: 'sign_in', mode: 'console' }); });
  if ((b = document.getElementById('signInCancel'))) b.addEventListener('click', function () { sendWs({ type: 'cancel_sign_in' }); });
  // "Claude Code CLI" in the sign-in caption opens the install docs.
  if ((b = document.getElementById('signInCliLink'))) {
    b.addEventListener('click', openClaudeCodeDocs);
    b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClaudeCodeDocs(); } });
  }
  // (Sign-out is handled by the Settings modal's setSignOutBtn handler.)
  window.__gafferAuth = function (s) { renderAuth(s || {}); }; // dev/test hook (mirrors __gafferSound)

  // Account / API — scaffold actions only: these send a WS message the daemon
  // does not yet handle (or is a no-op today). No key is read/entered/stored
  // here — see apiState above.
  if ((b = document.getElementById('setApiConnectBtn'))) b.addEventListener('click', function () {
    sendWs({ type: apiState.status === 'connected' ? 'api_disconnect' : apiState.status === 'disconnected' ? 'api_connect' : 'api_add_key' });
  });
  if ((b = document.getElementById('setApiForgetBtn'))) b.addEventListener('click', function () { sendWs({ type: 'api_forget' }); });

  // ── Start ──
  if (typeof GafferIcons !== 'undefined') {
    ledEl.innerHTML = GafferIcons.star;
    sendBtnEl.appendChild(icon('up'));
    stopBtnEl.appendChild(icon('stop'));
    clearBtnEl.appendChild(icon('brush'));
    document.getElementById('reloadBtn').appendChild(icon('refresh'));
    if (moreChevronEl) moreChevronEl.innerHTML = GafferIcons.chevronDown;
    dismissUpdateBtnEl.appendChild(icon('close'));
    var dropIconEl = document.getElementById('dropIcon');
    if (dropIconEl) dropIconEl.innerHTML = GafferIcons.drop;
    document.getElementById('settingsBtn').appendChild(icon('settings'));
    document.getElementById('settingsDismissBtn').appendChild(icon('close'));
    document.getElementById('setSoundPreview').appendChild(icon('speak'));
    document.getElementById('setApiForgetBtn').appendChild(icon('shred'));
    // Avatars are per-account galaxy rasters via CSS background-image (see .account-avatar).
  }
  // Settings full-screen takeover open/close + state sync.
  var settingsModalEl = document.getElementById('settingsModal');
  function syncSettingsUpdateButton() {
    var button = document.getElementById('setUpdateBtn');
    if (!button) return;
    var available = !!availableUpdateCommit && !window.__gafferUpdating;
    button.hidden = !available;
  }
  function syncSettings() {
    // #setVersion (== versionTextEl) is written directly by loadVersion/detectDevInstall.
    renderLastUpdateCheck();
    // Update CTA reflects actual availability, never the banner's dismissed
    // state, including checks that completed while Settings was already open.
    syncSettingsUpdateButton();
    document.getElementById('setAutoCheck').checked = autoCheckUpdates;
    document.getElementById('setScrooge').checked = autoModel;
    document.getElementById('setSoundOn').checked = soundEnabled;
    // Labels + effort dots are owned by their controls (makeSelect / renderEffort);
    // refresh them so the modal opens reflecting current state.
    updateModelSelect();
    updateVariantSelect();
    soundSelect.update();
    renderEffort();
    // Account / CLI from last auth status
    var em = document.getElementById('setCliEmail'), meta = document.getElementById('setCliMeta');
    var so = document.getElementById('setSignOutBtn');
    if (lastAuth && lastAuth.loggedIn) {
      em.textContent = lastAuth.email || 'Signed in';
      meta.textContent = ['CLI', lastAuth.orgName, lastAuth.plan ? labelize(lastAuth.plan) : ''].filter(Boolean).join(' • ');
      so.hidden = false;
    } else { em.textContent = 'Signed out'; meta.textContent = 'CLI'; so.hidden = true; }
    // Account / API — re-render from apiState so the modal reflects the latest
    // status whenever it's opened (see renderApi() / apiState above).
    renderApi();
  }
  function openSettings() {
    syncSettings(); tkShow(settingsModalEl);
    // Never reuse daemon-lifetime model data: every Settings visit re-reads
    // the installed CLI and current account/model state.
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'list_models' }));
    // Thumb placement measures live dot centers — re-run once the modal is
    // actually laid out (syncSettings' renderEffort ran while it was hidden).
    requestAnimationFrame(relayoutEffort);
  }
  function closeSettings() { tkHide(settingsModalEl); }
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsDismissBtn').addEventListener('click', closeSettings);
  dismissOnBackdrop(settingsModalEl, closeSettings); // void click only, not a drag out of the card
  // Wire the modal controls back to existing state/handlers.
  document.getElementById('setAutoCheck').addEventListener('change', function (e) { autoCheckUpdates = e.target.checked; saveChat(); });
  document.getElementById('setScrooge').addEventListener('change', function (e) { autoModel = e.target.checked; saveChat(); });
  // Enabling sound previews the selected cue (mirrors the reply-sound toggle).
  document.getElementById('setSoundOn').addEventListener('change', function (e) { soundEnabled = e.target.checked; if (soundEnabled) playSelectedCue(); saveChat(); });
  // Preview button plays the currently SELECTED cue (not a cue type) — gated by
  // the sound toggle, ungated by focus so you can audition it.
  document.getElementById('setSoundPreview').addEventListener('click', function () { playSelectedCue(); }); // explicit preview — always plays, toggle or not
  // (setSoundBtn is now a real dropdown wired via soundSelect/makeSelect above.)
  document.getElementById('setCheckNowBtn').addEventListener('click', function () { checkForUpdate(false); });
  document.getElementById('setUpdateBtn').addEventListener('click', runUpdate);
  document.getElementById('setSignOutBtn').addEventListener('click', function () {
    // Gaffer signs in through the Claude Code CLI, so signing out here logs the
    // whole machine out of Claude Code — confirm first (reuses the clear-chat
    // confirm modal). Humane, plain-language copy.
    showModal("This signs the whole machine out of Claude Code, not just Gaffer. Anything here that uses it will need to sign in again. You can sign back in anytime from the CLI.", {
      title: 'Sign out of Claude Code?', confirmLabel: 'Sign out', cancelLabel: 'Cancel',
      danger: true, onConfirm: function () { sendWs({ type: 'sign_out' }); closeSettings(); }
    });
  });
  // Model / variant / effort / sound controls are wired natively (makeSelect +
  // renderEffort) — no proxying to inline.
  stopBtnEl.style.display = 'none';
  document.getElementById('setAutoCheck').checked = autoCheckUpdates;
  updateModelSelect();
  updateVariantSelect();
  soundSelect.update();
  wireEffortSlider();
  renderEffort();
  restoreChat();
  loadVersion();
  if (autoCheckUpdates) {
    setTimeout(function () { checkForUpdate(true); }, 2000);
  }
  setStatus('starting', 'Starting...');
  connect();
})();
