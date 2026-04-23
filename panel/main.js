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

  // Chat state
  var currentSessionId = null;
  var chatBusy = false;
  var chatHistory = []; // { role: 'user'|'assistant', text: string }

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

  function startDaemon() {
    if (daemonStartAttempted) return;
    daemonStartAttempted = true;
    setStatus('starting', 'Starting daemon...');

    var extPath = cs.getSystemPath(SystemPath.EXTENSION);

    // Detect OS and call appropriate launcher script
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
      console.log('Gaffer: daemon spawn: ' + result);
    });
  }

  // ── WebSocket ──

  // ── Chat persistence (via ExtendScript file I/O) ──

  var chatFilePath = cs.getSystemPath(SystemPath.EXTENSION) + '/chat-history.json';

  function saveChat() {
    var data = JSON.stringify({ messages: chatHistory, sessionId: currentSessionId });
    var escaped = data.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    var jsx = "(function() {"
      + "var f = new File('" + chatFilePath.replace(/'/g, "\\'") + "');"
      + "f.open('w'); f.write('" + escaped + "'); f.close();"
      + "return 'ok';"
      + "})()";
    cs.evalScript(jsx);
  }

  function restoreChat() {
    var jsx = "(function() {"
      + "var f = new File('" + chatFilePath.replace(/'/g, "\\'") + "');"
      + "if (!f.exists) return '';"
      + "f.open('r'); var d = f.read(); f.close();"
      + "return d;"
      + "})()";
    cs.evalScript(jsx, function (result) {
      if (!result || result === 'undefined' || result === 'EvalScript_ErrMessage') return;
      try {
        var data = JSON.parse(result);
        if (!data || !data.messages) return;
        currentSessionId = data.sessionId || null;
        chatHistory = data.messages;
        for (var i = 0; i < chatHistory.length; i++) {
          var msg = chatHistory[i];
          if (msg.role === 'user') {
            var div = document.createElement('div');
            div.className = 'chat-msg user';
            div.textContent = msg.text;
            chatMessagesEl.appendChild(div);
          } else {
            var div = document.createElement('div');
            div.className = 'chat-msg assistant';
            var textSpan = document.createElement('span');
            textSpan.className = 'msg-text';
            textSpan.textContent = msg.text;
            div.appendChild(textSpan);
            addCopyButton(div);
            chatMessagesEl.appendChild(div);
          }
        }
        scrollToBottom();
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
        showToolStatus(msg.tool, msg.status);
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

      // ── Legacy: JSX execution request (no type field) ──
      if (!msg.id || !msg.code) return;
      lastJsxEl.textContent = truncate(msg.code, 80);

      evalScriptAsync(msg.code).then(function (result) {
        lastResultEl.textContent = truncate(typeof result === 'string' ? result : JSON.stringify(result), 80);
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
      console.log('Gaffer: connected to daemon');
      setStatus('connected', 'Connected');
      wasConnected = true;
      reconnectDelay = 1000;
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

  // ── Chat UI ──

  function sendChatMessage() {
    var text = chatInputEl.value.trim();
    if (!text || !ws || ws.readyState !== 1 || chatBusy) return;

    appendUserMessage(text);
    ws.send(JSON.stringify({
      type: 'chat',
      message: text,
      sessionId: currentSessionId,
    }));
    chatInputEl.value = '';
    setChatBusy(true);
    startAssistantMessage();
  }

  function appendUserMessage(text) {
    var div = document.createElement('div');
    div.className = 'chat-msg user';
    div.textContent = text;
    chatMessagesEl.appendChild(div);
    chatHistory.push({ role: 'user', text: text });
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
      var text = textEl ? textEl.textContent.trim() : div.textContent.trim();
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
    // Remove typing indicator on first real chunk
    var typing = el.querySelector('.typing-indicator');
    if (typing) typing.remove();
    // Append as text node to preserve Copy button
    var textNode = el.querySelector('.msg-text');
    if (!textNode) {
      textNode = document.createElement('span');
      textNode.className = 'msg-text';
      // Insert before the copy button
      var copyBtn = el.querySelector('.copy-btn');
      if (copyBtn) {
        el.insertBefore(textNode, copyBtn);
      } else {
        el.appendChild(textNode);
      }
    }
    textNode.textContent += text;
    scrollToBottom();
  }

  function showToolStatus(tool, status) {
    var el = document.getElementById('currentResponse');
    if (!el) return;
    var pill = document.createElement('span');
    pill.className = 'tool-pill ' + status;
    var icon = status === 'running' ? '~ ' : status === 'done' ? '+ ' : 'x ';
    pill.textContent = icon + tool;
    el.appendChild(pill);
    scrollToBottom();
  }

  function finalizeChatResponse(sessionId) {
    currentSessionId = sessionId;
    var el = document.getElementById('currentResponse');
    if (el) {
      var typing = el.querySelector('.typing-indicator');
      if (typing) typing.remove();
      var msgText = el.querySelector('.msg-text');
      if ((!msgText || !msgText.textContent.trim()) && !el.querySelector('.tool-pill')) {
        el.remove();
      } else {
        el.removeAttribute('id');
        if (msgText && msgText.textContent.trim()) {
          chatHistory.push({ role: 'assistant', text: msgText.textContent.trim() });
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

  // ── Input handlers ──

  sendBtnEl.addEventListener('click', sendChatMessage);
  stopBtnEl.addEventListener('click', stopChat);
  clearBtnEl.addEventListener('click', clearChat);
  document.getElementById('reloadBtn').addEventListener('click', function () {
    location.reload();
  });
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
  restoreChat();
  setStatus('starting', 'Starting...');
  connect();
})();
