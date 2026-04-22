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

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
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
    scrollToBottom();
  }

  function setChatBusy(busy) {
    chatBusy = busy;
    sendBtnEl.disabled = busy;
    sendBtnEl.style.display = busy ? 'none' : '';
    stopBtnEl.style.display = busy ? '' : 'none';
  }

  function startAssistantMessage() {
    var div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.id = 'currentResponse';
    div.innerHTML = '<span class="typing-indicator"><span class="typing-dot">...</span></span>';
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
    el.textContent += text;
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
      el.removeAttribute('id');
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

  // ── Register keyboard shortcuts (CEP intercepts them by default) ──
  cs.registerKeyEventsInterest(JSON.stringify([
    { keyCode: 8 },                        // Backspace
    { keyCode: 46 },                       // Delete
    { keyCode: 65, metaKey: true },        // Cmd+A
    { keyCode: 67, metaKey: true },        // Cmd+C
    { keyCode: 86, metaKey: true },        // Cmd+V
    { keyCode: 88, metaKey: true },        // Cmd+X
    { keyCode: 90, metaKey: true },        // Cmd+Z
    { keyCode: 65, ctrlKey: true },        // Ctrl+A (Windows)
    { keyCode: 67, ctrlKey: true },        // Ctrl+C
    { keyCode: 86, ctrlKey: true },        // Ctrl+V
    { keyCode: 88, ctrlKey: true },        // Ctrl+X
    { keyCode: 90, ctrlKey: true },        // Ctrl+Z
  ]));

  // ── Start ──
  setStatus('starting', 'Starting...');
  connect();
})();
