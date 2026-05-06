(function () {
  var cs = new CSInterface();
  var ws = null;
  var reconnectDelay = 1000;
  var maxDelay = 30000;
  var WS_URL = 'ws://127.0.0.1:9823';

  // DOM elements
  var ledEl = document.getElementById('led');
  var statusTextEl = document.getElementById('statusText');
  var lastJsxEl = document.getElementById('lastJsx');
  var lastResultEl = document.getElementById('lastResult');
  var chatMessagesEl = document.getElementById('chatMessages');
  var chatInputEl = document.getElementById('chatInput');
  var sendBtnEl = document.getElementById('sendBtn');
  var stopBtnEl = document.getElementById('stopBtn');
  var clearBtnEl = document.getElementById('clearBtn');
  var modelSelectEl = document.getElementById('modelSelect');
  var autoCheckEl = document.getElementById('autoCheckUpdates');
  var mcpListEl = document.getElementById('mcpList');
  var refreshMcpsBtnEl = document.getElementById('refreshMcpsBtn');
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
  var pendingImages = []; // [{path, dataUrl, name}] — staged for next send
  var PASTE_PREFIX = 'gaffer-paste-';
  var MAX_PASTE_FILES = 10;
  var THUMB_MAX_EDGE = 512;
  // mcpListEl + refreshMcpsBtnEl declared at top of file; do NOT redeclare here

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
    statusTextEl.textContent = text || state;
    var enabled = (state === 'connected') && !chatBusy;
    chatInputEl.disabled = state !== 'connected';
    sendBtnEl.disabled = state !== 'connected' || chatBusy;
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
          modelSelectEl.value = currentModel;
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
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    });
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
      if (msg.type === 'mcps') {
        availableMcps = msg.servers || [];
        renderMcpList();
        return;
      }

      // ── Legacy: JSX execution request (no type field) ──
      if (!msg.id || !msg.code) return;
      lastJsxEl.textContent = truncate(msg.code, 80);
      lastJsxEl.hidden = false;

      evalScriptAsync(msg.code).then(function (result) {
        lastResultEl.textContent = truncate(typeof result === 'string' ? result : JSON.stringify(result), 80);
        lastResultEl.hidden = false;
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
        var x = document.createElement('span');
        x.className = 'paste-chip-x';
        x.textContent = '×';
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
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', function () {
      var textEl = div.querySelector('.msg-text');
      // Prefer raw markdown source; fall back to rendered text
      var text = textEl && textEl.dataset && textEl.dataset.raw
        ? textEl.dataset.raw
        : (textEl ? textEl.textContent.trim() : div.textContent.trim());
      try {
        navigator.clipboard.writeText(text).then(function () {
          copyBtn.textContent = 'Copied';
          setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
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
    typing.innerHTML = '<span class="typing-dot">...</span>';
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
    // Reuse existing pill for this tool call (dedupe running → done/error)
    var pill = id ? el.querySelector('[data-tool-id="' + id + '"]') : null;
    if (!pill) {
      pill = document.createElement('span');
      if (id) pill.dataset.toolId = id;
      el.appendChild(pill);
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

  function requestMcpList() {
    if (!ws || ws.readyState !== 1) return;
    if (mcpListEl) mcpListEl.innerHTML = '<span style="color:#666;">loading…</span>';
    ws.send(JSON.stringify({ type: 'list_mcps' }));
  }

  function renderMcpList() {
    if (!mcpListEl) return;
    mcpListEl.innerHTML = '';
    if (!availableMcps.length) {
      var empty = document.createElement('span');
      empty.style.color = '#666';
      empty.textContent = 'none registered';
      mcpListEl.appendChild(empty);
      return;
    }
    availableMcps.forEach(function (s) {
      var label = document.createElement('label');
      label.style.display = 'inline-flex';
      label.style.alignItems = 'center';
      label.style.gap = '3px';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.mcpId = s.id;
      cb.checked = enabledMcps.indexOf(s.id) !== -1;
      cb.addEventListener('change', function () {
        if (cb.checked) {
          if (enabledMcps.indexOf(s.id) === -1) enabledMcps.push(s.id);
        } else {
          enabledMcps = enabledMcps.filter(function (x) { return x !== s.id; });
        }
        saveChat();
      });
      label.appendChild(cb);
      var dot = document.createElement('span');
      dot.style.marginLeft = '3px';
      dot.style.fontSize = '8px';
      if (s.status.indexOf('Connected') !== -1) { dot.style.color = '#4c8'; dot.textContent = '●'; }
      else if (s.status.indexOf('auth') !== -1) { dot.style.color = '#da3'; dot.textContent = '●'; label.title = 'Needs auth'; }
      else { dot.style.color = '#c44'; dot.textContent = '●'; label.title = s.status; }
      label.appendChild(dot);
      label.appendChild(document.createTextNode(' ' + s.displayName));
      mcpListEl.appendChild(label);
    });
  }

  // ── Version + update check ──

  var versionData = { version: 'dev', commit: null };

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
    });
  }

  function checkForUpdate(silent) {
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
  clearBtnEl.addEventListener('click', clearChat);
  document.getElementById('reloadBtn').addEventListener('click', function () {
    location.reload();
  });
  modelSelectEl.addEventListener('change', function () {
    currentModel = modelSelectEl.value;
    saveChat();
  });
  autoCheckEl.addEventListener('change', function () {
    autoCheckUpdates = autoCheckEl.checked;
    saveChat();
  });
  checkNowBtnEl.addEventListener('click', function () { checkForUpdate(false); });
  if (refreshMcpsBtnEl) refreshMcpsBtnEl.addEventListener('click', requestMcpList);
  updateBtnEl.addEventListener('click', runUpdate);
  dismissUpdateBtnEl.addEventListener('click', dismissUpdate);
  chatInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // NOTE: Cmd+C/V/X/A are intercepted by AE at the app level before reaching
  // the panel JS. registerKeyEventsInterest doesn't work in CEP 12 for these.
  // Copy is handled via Copy buttons on each message instead.

  // ── Start ──
  stopBtnEl.style.display = 'none';
  autoCheckEl.checked = autoCheckUpdates;
  modelSelectEl.value = currentModel;
  restoreChat();
  loadVersion();
  if (autoCheckUpdates) {
    setTimeout(function () { checkForUpdate(true); }, 2000);
  }
  setStatus('starting', 'Starting...');
  connect();
})();
