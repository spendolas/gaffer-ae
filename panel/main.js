(function () {
  var cs = new CSInterface();
  var ws = null;
  var reconnectDelay = 1000;
  var maxDelay = 30000;
  var WS_URL = 'ws://127.0.0.1:9823';

  var ledEl = document.getElementById('led');
  var statusTextEl = document.getElementById('statusText');
  var lastJsxEl = document.getElementById('lastJsx');
  var lastResultEl = document.getElementById('lastResult');
  var reconnectBtn = document.getElementById('reconnectBtn');

  function setConnected(connected) {
    if (connected) {
      ledEl.classList.add('connected');
      statusTextEl.textContent = 'Connected';
    } else {
      ledEl.classList.remove('connected');
      statusTextEl.textContent = 'Disconnected';
    }
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
  }

  function evalScriptAsync(code) {
    return new Promise(function (resolve) {
      cs.evalScript(code, function (result) {
        if (result === 'EvalScript_ErrMessage') {
          resolve({ ok: false, error: 'EvalScript error: script could not be evaluated', line: null });
        } else {
          // Daemon wraps code in try/catch that returns JSON.
          // Forward raw string — daemon will parse.
          resolve(result);
        }
      });
    });
  }

  function handleMessage(evt) {
    try {
      var msg = JSON.parse(evt.data);
      if (!msg.id || !msg.code) return;

      lastJsxEl.textContent = truncate(msg.code, 80);

      evalScriptAsync(msg.code).then(function (result) {
        lastResultEl.textContent = truncate(typeof result === 'string' ? result : JSON.stringify(result), 80);

        var response;
        if (typeof result === 'object' && result.ok === false) {
          // evalScript itself failed (EvalScript_ErrMessage)
          response = JSON.stringify({ id: msg.id, ok: false, error: result.error, line: result.line });
        } else {
          // Raw string from evalScript — daemon's safety wrapper already returned JSON
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
      setConnected(true);
      reconnectDelay = 1000; // reset backoff
    };

    ws.onmessage = handleMessage;

    ws.onclose = function () {
      console.log('Gaffer: disconnected from daemon');
      setConnected(false);
      scheduleReconnect();
    };

    ws.onerror = function (e) {
      console.error('Gaffer: WebSocket error', e);
      // onclose will fire after onerror, triggering reconnect
    };
  }

  function scheduleReconnect() {
    setTimeout(function () {
      reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
      connect();
    }, reconnectDelay);
  }

  reconnectBtn.addEventListener('click', function () {
    if (ws) {
      try { ws.close(); } catch (e) { /* ignore */ }
    }
    reconnectDelay = 1000;
    connect();
  });

  // Start connection
  connect();
})();
