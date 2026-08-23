(function () {
  var cs = new CSInterface();

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
  var modelSelectBtnEl = document.getElementById('modelSelectBtn');
  var modelSelectLabelEl = document.getElementById('modelSelectLabel');
  var modelSelectPopupEl = document.getElementById('modelSelectPopup');
  var moreLabelEl = document.getElementById('moreLabel');
  var moreChevronEl = document.getElementById('moreChevron');
  var autoCheckEl = document.getElementById('autoCheckUpdates');
  var mcpListEl = document.getElementById('mcpList');
  var checkNowBtnEl = document.getElementById('checkNowBtn');
  var versionTextEl = document.getElementById('versionText');
  var updateBannerEl = document.getElementById('updateBanner');
  var updateTextEl = document.getElementById('updateText');
  var updateBtnEl = document.getElementById('updateBtn');
  var dismissUpdateBtnEl = document.getElementById('dismissUpdateBtn');
  var pastePreviewRowEl = document.getElementById('pastePreviewRow');
  var dropOverlayEl = document.getElementById('dropOverlay');
  var lightboxEl = document.getElementById('imgLightbox');
  var lightboxImgEl = lightboxEl ? lightboxEl.querySelector('img') : null;

  // Chat state
  var currentSessionId = null;
  var chatBusy = false;
  var chatHistory = []; // { role: 'user'|'assistant', text: string }
  var currentModel = 'opus';
  var currentVariant = 'standard'; // 'standard' | '1m' (context-window variant)
  var currentEffort = 'high'; // low | medium | high | xhigh | max
  var autoCheckUpdates = true;
  var dismissedUpdateCommit = null;
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
    chatInputEl.disabled = state !== 'connected';
    sendBtnEl.disabled = state !== 'connected' || chatBusy;
    // Figma InputRow state matrix: offline shows a bare panel-colored
    // button + "Gaffer" placeholder; connected shows the italic prompt.
    var offline = state !== 'connected';
    chatInputEl.classList.toggle('offline', offline);
    sendBtnEl.classList.toggle('offline', offline);
    chatInputEl.placeholder = offline ? 'Gaffer' : 'Ask Gaffer...';
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
        }
        if (data.variant) {
          // migrate the short-lived 'latest' naming
          currentVariant = data.variant === 'latest' ? 'standard' : data.variant;
          updateVariantSelect();
        }
        if (data.effort) {
          currentEffort = data.effort;
          updateEffortSelect();
        }
        if (typeof data.autoCheckUpdates === 'boolean') {
          autoCheckUpdates = data.autoCheckUpdates;
          autoCheckEl.checked = autoCheckUpdates;
        }
        if (typeof data.soundEnabled === 'boolean') {
          soundEnabled = data.soundEnabled;
          var rsEl = document.getElementById('replySound');
          if (rsEl) rsEl.checked = soundEnabled;
        }
        if (typeof data.soundVariant === 'string') {
          soundVariant = data.soundVariant;
          if (soundVariant.indexOf('walkie') === 0) soundVariant = 'walkie';
          if (soundVariant === 'barn-door' || soundVariant === 'tape' || soundVariant === 'c47' || soundVariant === 'scrim') soundVariant = 'squeak';
          updateSoundCycleLabel();
        }
        if (typeof data.textScale === 'number') {
          textScale = data.textScale;
          applyTextScale();
        }
        if (data.dismissedUpdateCommit) {
          dismissedUpdateCommit = data.dismissedUpdateCommit;
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
            var div = document.createElement('div');
            div.className = 'chat-msg user';
            if (msg.images && msg.images.length) {
              var row = document.createElement('div');
              row.className = 'bubble-images-row';
              for (var k = 0; k < msg.images.length; k++) {
                (function (item) {
                  var img = document.createElement('img');
                  img.className = 'bubble-image';
                  img.src = item.dataUrl;
                  img.alt = item.name || 'image';
                  img.addEventListener('click', function () { openLightbox(item.dataUrl); });
                  row.appendChild(img);
                })(msg.images[k]);
              }
              div.appendChild(row);
            }
            if (msg.text) {
              var t = document.createElement('div');
              t.textContent = msg.text;
              div.appendChild(t);
            }
            chatMessagesEl.appendChild(div);
          } else {
            var div = document.createElement('div');
            div.className = 'chat-msg assistant';
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
    lightboxEl.hidden = false;
  }

  function closeLightbox() {
    if (!lightboxEl || !lightboxImgEl) return;
    lightboxEl.hidden = true;
    lightboxImgEl.src = '';
  }

  if (lightboxEl) {
    lightboxEl.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !lightboxEl.hidden) closeLightbox();
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
    if (!text && pendingImages.length === 0) return;

    var imgs = pendingImages.slice();
    var imgPrefix = imgs.map(function (p) { return '[image: ' + p.path + ']'; }).join('\n');
    var fullMessage = imgPrefix ? (imgPrefix + (text ? '\n' + text : '')) : text;

    // every send counts one use for each enabled server (drives tile order)
    enabledMcps.forEach(function (id) {
      var u = mcpUsage[id] || { count: 0, last: 0 };
      u.count++;
      u.last = Date.now();
      mcpUsage[id] = u;
    });
    appendUserMessage(text, imgs);
    ws.send(JSON.stringify({
      type: 'chat',
      message: fullMessage,
      sessionId: currentSessionId,
      // pinned version = full model id (may embed [1m]); alias otherwise
      model: currentVariant.indexOf('id:') === 0 ? currentVariant.slice(3) : currentModel,
      variant: currentVariant === '1m' ? '1m' : 'standard',
      effort: currentEffort,
      aeVersion: aeVersion,
      enabledMcps: enabledMcps,
    }));
    chatInputEl.value = '';
    resizeChatInput(); // collapse to one (scaled) line
    sendBtnEl.classList.remove('typed');
    pendingImages = [];
    renderPendingImages();
    setChatBusy(true);
    startAssistantMessage();
  }

  function appendUserMessage(text, images) {
    var div = document.createElement('div');
    div.className = 'chat-msg user';
    if (images && images.length) {
      div.classList.add('has-images');
      var row = document.createElement('div');
      row.className = 'bubble-images-row';
      for (var i = 0; i < images.length; i++) {
        (function (item) {
          var img = document.createElement('img');
          img.className = 'bubble-image';
          img.src = item.dataUrl;
          img.alt = item.name || 'image';
          img.addEventListener('click', function () { openLightbox(item.dataUrl); });
          row.appendChild(img);
        })(images[i]);
      }
      div.appendChild(row);
    }
    if (text) {
      var t = document.createElement('div');
      t.textContent = text;
      div.appendChild(t);
    }
    chatMessagesEl.appendChild(div);
    var entry = { role: 'user', text: text };
    if (images && images.length) {
      entry.images = images.map(function (i) { return { dataUrl: i.dataUrl, name: i.name }; });
    }
    chatHistory.push(entry);
    saveChat();
    scrollToBottom();
  }

  function setChatBusy(busy) {
    chatBusy = busy;
    sendBtnEl.disabled = busy;
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
    selCopyBtn = document.createElement('button');
    selCopyBtn.className = 'icon-btn';
    selCopyBtn.title = 'Copy selection';
    selCopyBtn.appendChild(icon('copy'));
    selReplyBtn = document.createElement('button');
    selReplyBtn.className = 'icon-btn';
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
      var text = currentSelectionText();
      if (text) replyToSelection(text);
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

  // Stage a markdown blockquote of the selection in the input; the user types
  // their reaction and sends. The quote gives the agent the exact referent —
  // no protocol change, Gaffer already pipes the input string to claude -p.
  function replyToSelection(text) {
    var quoted = text.split('\n').map(function (l) { return '> ' + l; }).join('\n');
    var existing = chatInputEl.value;
    chatInputEl.value = quoted + '\n\n' + (existing || '');
    chatInputEl.focus();
    try {
      var end = chatInputEl.value.length;
      chatInputEl.setSelectionRange(end, end);
    } catch (e) { /* non-text input — ignore */ }
    chatInputEl.dispatchEvent(new Event('input', { bubbles: true })); // auto-grow + state
  }

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
      // Show the REAL git HEAD, not the frozen version.json commit.
      var m = s.match(/dev:([0-9a-f]{4,}\+?)/i);
      if (m && m[1]) {
        var base = versionTextEl.textContent.replace(/\s*\([0-9a-f]+\)/i, '');
        versionTextEl.textContent = base + ' (' + m[1] + ')';
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
      if (!silent) alert('Dev install (git checkout) — the panel updater is disabled. Pull changes with git instead.');
      return;
    }
    // Fetch remote version.json directly — content match means same release.
    // Avoids commit-hash chicken-and-egg from amend hooks.
    fetch('https://raw.githubusercontent.com/spendolas/gaffer-ae/main/panel/version.json?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (remote) {
        if (!remote || !remote.commit) return;
        if (!versionData.commit) {
          if (!silent) alert('Local version unknown. Reinstall to enable updates.');
          return;
        }
        if (remote.commit === versionData.commit) {
          if (!silent) alert('Gaffer is up to date (' + versionData.commit.substring(0, 7) + ')');
          return;
        }
        if (remote.commit === dismissedUpdateCommit) return;
        updateTextEl.textContent = 'Update available — v' + remote.version;
        updateBannerEl.classList.add('visible');
        updateBannerEl._latestCommit = remote.commit;
      }).catch(function (e) {
        if (!silent) alert('Update check failed: ' + e.message);
      });
  }

  function runUpdate() {
    if (isDevInstall) {
      alert('Dev install (git checkout) — the panel updater is disabled. Pull changes with git instead.');
      updateBannerEl.classList.remove('visible');
      return;
    }
    if (chatBusy) {
      alert('Please wait for current response to finish before updating.');
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
          target: updateBannerEl._latestCommit || null,
          at: Date.now(),
        }));
      } catch (e) { /* ignore */ }
      updateTextEl.textContent = 'Updating…';
      var actionsEl = updateBannerEl.querySelector('.actions');
      if (actionsEl) actionsEl.style.display = 'none'; // no CTAs mid-update
      window.__gafferUpdating = true; // pauses daemon auto-respawn
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
    if (updateBannerEl._latestCommit) {
      dismissedUpdateCommit = updateBannerEl._latestCommit;
      saveChat();
    }
    updateBannerEl.classList.remove('visible');
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
    clearChat();
  });
  document.getElementById('reloadBtn').addEventListener('click', function (e) {
    e.preventDefault();
    location.reload();
  });

  // ── Custom selects (Figma atom): model, context variant, effort ──
  // Model + effort options are NOT hardcoded — the daemon discovers them
  // from the installed CLI (`claude --help`) and pushes a 'models' message
  // on load; these are only the pre-push fallbacks.
  function labelize(v) {
    if (v === 'xhigh') return 'Extra High';
    if (v === '1m') return '1M';
    return v.charAt(0).toUpperCase() + v.slice(1);
  }
  var MODELS = ['fable', 'opus', 'sonnet', 'haiku'].map(function (v) { return { value: v, label: labelize(v) }; });
  // Variant = version x context (ref: "Latest", "Latest · 1M", "4.6",
  // "4.6 · 1M"...). Latest pair is always offered (alias + [1m] suffix);
  // pinned versions come from the daemon's CLI-state discovery and are
  // full model ids carried in the value as 'id:<full-id>'.
  var modelVersions = {}; // family -> [full ids], daemon-pushed
  function versionLabel(id) {
    return id.replace(/^claude-[a-z]+-/, '').replace(/-\d{8}$/, '').replace(/-/g, '.');
  }
  function variantOptionsFor(family) {
    var opts = [
      { value: 'standard', label: 'Latest' },
      { value: '1m', label: 'Latest · 1M' },
    ];
    (modelVersions[family] || []).forEach(function (id) {
      opts.push({ value: 'id:' + id, label: versionLabel(id) });
      opts.push({ value: 'id:' + id + '[1m]', label: versionLabel(id) + ' · 1M' });
    });
    return opts;
  }
  var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'].map(function (v) { return { value: v, label: labelize(v) }; });
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
    }
  );
  var variantSelect = makeSelect(
    document.getElementById('variantSelectBtn'), document.getElementById('variantSelectPopup'),
    document.getElementById('variantSelectLabel'), variantOptionsFor(currentModel),
    function () { return currentVariant; }, function (v) { currentVariant = v; }
  );
  function rebuildVariantSelect() {
    var opts = variantOptionsFor(currentModel);
    var valid = false;
    for (var i = 0; i < opts.length; i++) if (opts[i].value === currentVariant) valid = true;
    if (!valid) currentVariant = 'standard'; // pinned version orphaned by model switch
    variantSelect.setOptions(opts);
  }
  var effortSelect = makeSelect(
    document.getElementById('effortSelectBtn'), document.getElementById('effortSelectPopup'),
    document.getElementById('effortSelectLabel'), EFFORTS,
    function () { return currentEffort; }, function (v) { currentEffort = v; }
  );
  var updateModelSelect = modelSelect.update;
  var updateVariantSelect = variantSelect.update;
  var updateEffortSelect = effortSelect.update;
  function applyModelOptions(data) {
    if (Array.isArray(data.models) && data.models.length) {
      modelSelect.setOptions(data.models.map(function (v) { return { value: v, label: labelize(v) }; }));
    }
    if (Array.isArray(data.efforts) && data.efforts.length) {
      effortSelect.setOptions(data.efforts.map(function (v) { return { value: v, label: labelize(v) }; }));
    }
    if (data.versions && typeof data.versions === 'object') {
      modelVersions = data.versions;
      rebuildVariantSelect();
    }
  }
  var soundCycleBtnEl = document.getElementById('soundCycleBtn');
  function updateSoundCycleLabel() {
    if (!soundCycleBtnEl) return;
    var label = soundVariant;
    for (var i = 0; i < SOUND_CANDIDATES.length; i++) {
      if (SOUND_CANDIDATES[i].id === soundVariant) label = SOUND_CANDIDATES[i].label;
    }
    soundCycleBtnEl.textContent = '\u266a ' + label;
  }
  if (soundCycleBtnEl) {
    updateSoundCycleLabel();
    soundCycleBtnEl.addEventListener('click', function () {
      var idx = 0;
      for (var i = 0; i < SOUND_CANDIDATES.length; i++) if (SOUND_CANDIDATES[i].id === soundVariant) idx = i;
      var next = SOUND_CANDIDATES[(idx + 1) % SOUND_CANDIDATES.length];
      soundVariant = next.id;
      updateSoundCycleLabel();
      if (soundEnabled) next.play(); // hear what you just selected
      saveChat();
    });
  }

  var replySoundEl = document.getElementById('replySound');
  if (replySoundEl) {
    replySoundEl.checked = soundEnabled;
    replySoundEl.addEventListener('change', function () {
      soundEnabled = replySoundEl.checked;
      saveChat();
      if (soundEnabled) playSelectedCue(); // hear what you enabled
    });
  }

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
  }
  // Auto-grow the composer against a cap, both scaled by --chat-text so the
  // 8-line ceiling stays 8 lines at any text size.
  function resizeChatInput() {
    if (!chatInputEl) return;
    var line = Math.round(18 * textScale);
    var cap = Math.round(144 * textScale); // 8 lines
    chatInputEl.style.height = line + 'px';
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, cap) + 'px';
    chatInputEl.style.overflowY = chatInputEl.scrollHeight > cap ? 'auto' : 'hidden';
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
  wireSpell(textResetEl, function () { return 'Text size ' + Math.round(textScale * 100) + '% — tap to reset'; });
  wireSpell(textIncEl, function () { return 'Larger text'; });
  applyTextScale(); // initialize label + disabled states at load

  autoCheckEl.addEventListener('change', function () {
    autoCheckUpdates = autoCheckEl.checked;
    saveChat();
  });
  checkNowBtnEl.addEventListener('click', function () { checkForUpdate(false); });
  // Drawer expand/collapse is class-driven with a height transition —
  // native <details> toggling can't animate, so it stays `open` and the
  // .expanded class shows/hides the animated .activity-body.
  var activityEl = document.querySelector('.activity-log');
  function activityExpanded() {
    return activityEl && activityEl.classList.contains('expanded');
  }
  // No refresh button — the list refreshes under the hood: on expand,
  // then every 60s while the drawer stays open (silent, no flicker).
  setInterval(function () {
    if (activityExpanded()) requestMcpList(true);
  }, 60000);
  if (activityEl) activityEl.querySelector('summary').addEventListener('click', function (e) {
    if (e.defaultPrevented) return; // Clear/Reload buttons handled their own click
    e.preventDefault(); // keep the native details from toggling
    var expanded = activityEl.classList.toggle('expanded');
    if (expanded) requestMcpList(availableMcps.length > 0);
    // More <-> Less, chevron flips (Figma summary affordance)
    if (moreLabelEl) moreLabelEl.textContent = expanded ? 'Less' : 'More';
    if (moreChevronEl && typeof GafferIcons !== 'undefined') {
      moreChevronEl.innerHTML = GafferIcons[expanded ? 'chevronUp' : 'chevronDown'];
    }
  });
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
    sendBtnEl.classList.toggle('typed', chatInputEl.value.trim().length > 0);
    resizeChatInput();
  });

  // NOTE: Cmd+C/V/X/A are intercepted by AE at the app level before reaching
  // the panel JS. registerKeyEventsInterest doesn't work in CEP 12 for these.
  // Copy is handled via Copy buttons on each message instead.

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
  }
  stopBtnEl.style.display = 'none';
  autoCheckEl.checked = autoCheckUpdates;
  updateModelSelect();
  restoreChat();
  loadVersion();
  if (autoCheckUpdates) {
    setTimeout(function () { checkForUpdate(true); }, 2000);
  }
  setStatus('starting', 'Starting...');
  connect();
})();
