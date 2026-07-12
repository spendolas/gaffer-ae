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

  // ── Chat persistence (via ExtendScript file I/O) ──

  var chatFilePath = cs.getSystemPath(SystemPath.EXTENSION) + '/chat-history.json';

  function saveChat() {
    var data = JSON.stringify({
      messages: chatHistory,
      sessionId: currentSessionId,
      model: currentModel,
      autoCheckUpdates: autoCheckUpdates,
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
        if (!data || !data.messages) return;
        currentSessionId = data.sessionId || null;
        chatHistory = data.messages;
        if (data.model) {
          currentModel = data.model;
          updateModelSelect();
        }
        if (typeof data.autoCheckUpdates === 'boolean') {
          autoCheckUpdates = data.autoCheckUpdates;
          autoCheckEl.checked = autoCheckUpdates;
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

  function copyViaPbcopy(text, btn) {
    // Use ExtendScript system.callSystem to pipe text to clipboard
    var escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    var jsx = 'system.callSystem("echo \\"" + "' + escaped + '" + "\\" | pbcopy")';
    cs.evalScript(jsx, function () {
      copyFeedback(btn);
    });
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
      if (msg.type === 'mcps') {
        // carry icons + mask analysis over from the previous list so a
        // refresh never regresses a tile to its monogram/img fallback
        var prev = {};
        availableMcps.forEach(function (s) { prev[s.id] = s; });
        (msg.servers || []).forEach(function (s) {
          var p = prev[s.id];
          if (!p) return;
          if (!s.icon && p.icon) s.icon = p.icon;
          if (s.icon && p.icon === s.icon) {
            s.maskable = p.maskable;
            s.maskUrl = p.maskUrl;
          }
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
      if (!daemonStartAttempted) startDaemon();
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
      model: currentModel,
      aeVersion: aeVersion,
      enabledMcps: enabledMcps,
    }));
    chatInputEl.value = '';
    chatInputEl.style.height = '18px';
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
      try {
        navigator.clipboard.writeText(text).then(function () {
          copyFeedback(copyBtn);
        }).catch(function () { copyViaPbcopy(text, copyBtn); });
      } catch (e) {
        copyViaPbcopy(text, copyBtn);
      }
    });
    div.appendChild(copyBtn);
  }

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
    addCopyButton(div);
    var typing = document.createElement('span');
    typing.className = 'typing-indicator';
    typing.innerHTML = '<i></i><i></i><i></i>';
    div.appendChild(typing);
    chatMessagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendChatChunk(text) {
    var el = document.getElementById('currentResponse');
    if (!el) startAssistantMessage();
    el = document.getElementById('currentResponse');
    var typing = el.querySelector('.typing-indicator');
    if (typing) typing.remove();
    var textNode = el.querySelector('.msg-text');
    if (!textNode) {
      textNode = document.createElement('span');
      textNode.className = 'msg-text';
      textNode.dataset.raw = '';
      var copyBtn = el.querySelector('.copy-btn');
      if (copyBtn) el.insertBefore(textNode, copyBtn);
      else el.appendChild(textNode);
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
      row.appendChild(pill);
    }
    pill.className = 'tool-pill ' + status;
    pill.textContent = tool;
    scrollToBottom();
  }

  function finalizeChatResponse(sessionId) {
    currentSessionId = sessionId;
    var el = document.getElementById('currentResponse');
    if (el) {
      var typing = el.querySelector('.typing-indicator');
      if (typing) typing.remove();
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
    var typing = el.querySelector('.typing-indicator');
    if (typing) typing.remove();
    el.className += ' error';
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

  // Flat single-color glyphs: favicons with a transparent background mask
  // directly; solid-background favicons get an alpha channel derived from
  // luminance (bright-on-dark or dark-on-bright, picked by corner tone),
  // so e.g. Uber's white-on-black wordmark becomes a clean silhouette.
  // Session cache keyed by icon data — survives list refreshes so tiles
  // never re-detect (and re-flicker) for an icon we've already analyzed.
  var maskCache = {}; // icon dataUrl -> { maskable, maskUrl }
  var renderQueued = false;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(function () { renderQueued = false; renderMcpList(); }, 80);
  }

  function detectMaskable(s) {
    if (!s.icon || s.maskable !== undefined || s.icon.indexOf('image/svg') !== -1) return;
    var hit = maskCache[s.icon];
    if (hit) { s.maskable = hit.maskable; s.maskUrl = hit.maskUrl; return; }
    s.maskable = false; // pessimistic until proven
    var img = new Image();
    img.onload = function () {
      try {
        var N = 32;
        var c = document.createElement('canvas');
        c.width = N; c.height = N;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, N, N);
        var d = ctx.getImageData(0, 0, N, N).data;
        var corners = [0, (N - 1) * 4, (N - 1) * N * 4, ((N - 1) * N + N - 1) * 4];
        var transparentBg = corners.every(function (i) { return d[i + 3] < 40; });
        if (transparentBg) {
          s.maskable = true;
          s.maskUrl = s.icon;
          maskCache[s.icon] = { maskable: true, maskUrl: s.icon };
        } else {
          // luminance → alpha: glyph = pixels far from the bg tone
          var bgLum = corners.reduce(function (sum, i) {
            return sum + (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
          }, 0) / 4;
          var darkBg = bgLum < 128;
          var out = ctx.createImageData(N, N);
          for (var p = 0; p < d.length; p += 4) {
            var lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
            var a = darkBg ? lum : 255 - lum;
            out.data[p] = 255; out.data[p + 1] = 255; out.data[p + 2] = 255;
            out.data[p + 3] = Math.max(0, Math.min(255, (a - 40) * 1.6));
          }
          ctx.putImageData(out, 0, 0);
          s.maskable = true;
          s.maskUrl = c.toDataURL('image/png');
          maskCache[s.icon] = { maskable: true, maskUrl: s.maskUrl };
        }
        queueRender();
      } catch (e) { /* keep img fallback */ }
    };
    img.src = s.icon;
  }

  // Shared hover tooltip (CEF title tooltips are unreliable in panels)
  var mcpTooltipEl = null;
  function showMcpTooltip(tile, text) {
    hideMcpTooltip();
    mcpTooltipEl = document.createElement('div');
    mcpTooltipEl.className = 'mcp-tooltip';
    mcpTooltipEl.textContent = text;
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
    var text = words.length > 1
      ? (words[0][0] + words[1][0])
      : name.slice(0, 1);
    return text.toUpperCase();
  }

  function buildMcpTile(s) {
    var state = mcpTileState(s);
    var tile = document.createElement('button');
    tile.className = 'mcp-tile ' + state + (pendingAuthId === s.id ? ' authing' : '');
    tile.addEventListener('mouseenter', function () { showMcpTooltip(tile, s.displayName); });
    tile.addEventListener('mouseleave', hideMcpTooltip);
    if (s.icon && s.icon.indexOf('image/svg') !== -1) {
      // bundled brand SVGs — currentColor strokes/fills
      var span = document.createElement('span');
      span.className = 'gicon';
      span.innerHTML = atob(s.icon.split(',')[1]);
      tile.appendChild(span);
    } else if (s.icon && s.maskable) {
      // favicon → flat glyph in the tile color via mask (direct alpha or
      // the luminance-derived alpha built in detectMaskable)
      var glyph = document.createElement('span');
      glyph.className = 'mask-glyph';
      glyph.style.setProperty('-webkit-mask-image', 'url(' + (s.maskUrl || s.icon) + ')');
      tile.appendChild(glyph);
    } else if (s.icon) {
      detectMaskable(s); // async — upgrades to mask-glyph on re-render
      var img = document.createElement('img');
      img.src = s.icon;
      img.alt = s.displayName;
      tile.appendChild(img);
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
    var jsx = '(function(){'
      + 'if ($.os.indexOf("Windows") !== -1) return "prod";'
      + 'return system.callSystem("bash -c \'test -d \\"' + extPath.replace(/'/g, "\\'") + '/../.git\\" && echo dev || echo prod\'");'
      + '})()';
    cs.evalScript(jsx, function (result) {
      isDevInstall = String(result).indexOf('dev') !== -1;
      if (isDevInstall) {
        versionTextEl.textContent = versionTextEl.textContent + ' · dev';
        versionTextEl.title = 'Dev install (git checkout) — update with git pull, not the panel updater';
      }
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
        updateTextEl.textContent = '⬆ Update available: ' + remote.commit.substring(0, 7) + ' (current: ' + versionData.commit.substring(0, 7) + ')';
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
      setTimeout(function () { location.reload(); }, 2000);
    }

    // Prefer Node spawn (Apple Silicon-safe), fall back to ExtendScript.
    if (typeof require !== 'undefined') {
      try {
        var cp = require('child_process');
        var isWin = process.platform === 'win32';
        var cmd, args;
        if (isWin) {
          cmd = 'powershell';
          args = ['-ExecutionPolicy', 'Bypass', '-File', daemonDir + '\\update.ps1'];
        } else {
          cmd = 'bash';
          args = [daemonDir + '/update.sh'];
        }
        var child = cp.spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.unref();
        console.log('Gaffer: update spawned via Node');
        reloadAfterUpdate();
        return;
      } catch (e) {
        console.error('Gaffer: update spawn (Node) failed, falling back', e);
      }
    }

    var jsx = '(function(){'
      + 'var isWin = $.os.indexOf("Windows") !== -1;'
      + 'var dir = "' + extPath.replace(/\\/g, '/') + '/daemon";'
      + 'if (isWin) return system.callSystem("powershell -ExecutionPolicy Bypass -File \\"" + dir + "/update.ps1\\"");'
      + 'return system.callSystem("bash \\"" + dir + "/update.sh\\"");'
      + '})()';
    cs.evalScript(jsx, function (result) {
      console.log('Gaffer: update result (ExtendScript):', result);
      reloadAfterUpdate();
    });
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
  clearBtnEl.addEventListener('click', function (e) {
    e.preventDefault();
    clearChat();
  });
  document.getElementById('reloadBtn').addEventListener('click', function (e) {
    e.preventDefault();
    location.reload();
  });

  // ── Custom ModelSelect (Figma atom — options incl. Fable) ──
  var MODELS = [
    { value: 'fable', label: 'Fable' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ];
  function updateModelSelect() {
    var m = null;
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i].value === currentModel) m = MODELS[i];
    modelSelectLabelEl.textContent = m ? m.label : currentModel;
    var opts = modelSelectPopupEl.querySelectorAll('.option');
    for (var j = 0; j < opts.length; j++) {
      opts[j].classList.toggle('selected', opts[j].dataset.value === currentModel);
    }
  }
  MODELS.forEach(function (m) {
    var opt = document.createElement('span');
    opt.className = 'option';
    opt.dataset.value = m.value;
    opt.textContent = m.label;
    opt.addEventListener('click', function () {
      currentModel = m.value;
      modelSelectPopupEl.hidden = true;
      updateModelSelect();
      saveChat();
    });
    modelSelectPopupEl.appendChild(opt);
  });
  modelSelectBtnEl.addEventListener('click', function (e) {
    e.preventDefault();
    modelSelectPopupEl.hidden = !modelSelectPopupEl.hidden;
    updateModelSelect();
  });
  document.addEventListener('click', function (e) {
    if (!modelSelectPopupEl.hidden && !modelSelectBtnEl.contains(e.target) && !modelSelectPopupEl.contains(e.target)) {
      modelSelectPopupEl.hidden = true;
    }
  });
  autoCheckEl.addEventListener('change', function () {
    autoCheckUpdates = autoCheckEl.checked;
    saveChat();
  });
  checkNowBtnEl.addEventListener('click', function () { checkForUpdate(false); });
  var activityEl = document.querySelector('.activity-log');
  // No refresh button — the list refreshes under the hood: on open,
  // then every 60s while the drawer stays open (silent, no flicker).
  setInterval(function () {
    if (activityEl && activityEl.open) requestMcpList(true);
  }, 60000);
  if (activityEl) activityEl.addEventListener('toggle', function () {
    if (activityEl.open) requestMcpList(availableMcps.length > 0);
    // More <-> Less, chevron flips (Figma summary affordance)
    if (moreLabelEl) moreLabelEl.textContent = activityEl.open ? 'Less' : 'More';
    if (moreChevronEl && typeof GafferIcons !== 'undefined') {
      moreChevronEl.innerHTML = GafferIcons[activityEl.open ? 'chevronUp' : 'chevronDown'];
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
    chatInputEl.style.height = '18px';
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 72) + 'px';
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
