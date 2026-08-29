import { PanelBridge } from './panel-bridge.js';
import { Queue } from './queue.js';
import { startMcpServer } from './mcp-server.js';
import { ChatHandler, augmentedEnv } from './chat-handler.js';
import { authStatus, signIn, signOut } from './auth.js';
import { findClaudeBinary } from './claude-binary.js';
import { maxSourceMtime, isDevInstall, shouldReload } from './dev-reload.js';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

var WS_PORT = 9823;
var MCP_PORT = 9824;

var bridge = new PanelBridge(WS_PORT);

// Handle port conflicts — if daemon is already running, exit gracefully
bridge.start().catch((err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Gaffer: port ' + WS_PORT + ' in use — daemon already running. Exiting.');
    process.exit(0);
  }
  console.error('Gaffer: failed to start panel bridge', err);
  process.exit(1);
});

var chatHandler = new ChatHandler();
bridge.onChat = (msg, socket) => chatHandler.handleChat(msg, socket);
bridge.onChatCancel = () => chatHandler.cancel();
bridge.onListModels = async (socket) => {
  try {
    var opts = await chatHandler.listModelOptions();
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({
        type: 'models',
        models: opts.models,
        efforts: opts.efforts,
        effortsByModel: opts.effortsByModel,
        capabilitiesByModel: opts.capabilitiesByModel,
        versions: opts.versions,
        capabilitySource: opts.capabilitySource,
        entitlement: opts.entitlement,
        live: !!opts.live,
        modelAccess: opts.modelAccess || (opts.live ? 'ready' : 'unavailable'),
      }));
    }
  } catch (e) {
    console.error('Gaffer: model discovery failed:', e.message);
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({
        type: 'models', models: [], efforts: [], effortsByModel: {},
        capabilitiesByModel: {}, versions: {}, capabilitySource: 'unavailable',
        entitlement: 'unknown', live: false, modelAccess: 'unavailable',
      }));
    }
  }
};
bridge.onListMcps = async (socket) => {
  var result = await chatHandler.listMcps(function (icons) {
    // background favicon fetches finished — push them to the panel
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'mcp_icons', icons: icons }));
    }
  });
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ type: 'mcps', servers: result.servers || [], error: result.error }));
  }
};
bridge.onAuthMcp = async (msg, socket) => {
  var result = await chatHandler.authMcp(msg.id);
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ type: 'mcp_auth_done', id: msg.id, ok: result.ok, error: result.error }));
  }
};

let activeSignIn = null;
let signInInFlight = false;
function sendAuthStatus(socket, s) {
  if (socket && socket.readyState === 1)
    socket.send(JSON.stringify({ type: 'auth_status', loggedIn: s.loggedIn,
      email: s.email, orgName: s.orgName, plan: s.subscriptionType, authMethod: s.authMethod }));
}
bridge.onAuthStatus = async (socket) => {
  try { sendAuthStatus(socket, await authStatus(await findClaudeBinary(), { env: augmentedEnv() })); }
  catch (e) { sendAuthStatus(socket, { loggedIn: null }); }
};
bridge.onSignIn = async (msg, socket) => {
  if (signInInFlight || activeSignIn) return;
  signInInFlight = true;
  let bin; try { bin = await findClaudeBinary(); }
  catch (e) {
    signInInFlight = false;
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: 'sign_in_done', ok: false, error: e.message }));
    return;
  }
  const mode = msg.mode === 'console' ? 'console' : 'claudeai';
  const env = augmentedEnv();
  activeSignIn = signIn(bin, mode, { env: env, onStarted: () => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'sign_in_started' }));
  }});
  const r = await activeSignIn.done;
  activeSignIn = null;
  signInInFlight = false;
  if (socket.readyState === 1) {
    socket.send(JSON.stringify({ type: 'sign_in_done', ok: r.ok, error: r.error }));
    if (r.ok && r.status) sendAuthStatus(socket, r.status);
    else sendAuthStatus(socket, await authStatus(bin, { env: env }));
  }
};
bridge.onSignOut = async (socket) => {
  let bin;
  try { bin = await findClaudeBinary(); }
  catch (e) { sendAuthStatus(socket, { loggedIn: null }); return; }
  const env = augmentedEnv();
  const r = await signOut(bin, { env: env });
  if (r.ok) sendAuthStatus(socket, { loggedIn: false });
  else sendAuthStatus(socket, await authStatus(bin, { env: env })); // logout failed → report real state
};
bridge.onCancelSignIn = () => { if (activeSignIn) { activeSignIn.cancel(); activeSignIn = null; } signInInFlight = false; };

var queue = new Queue(bridge);

startMcpServer(MCP_PORT, queue).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Gaffer: port ' + MCP_PORT + ' in use — daemon already running. Exiting.');
    process.exit(0);
  }
  console.error('Gaffer: failed to start MCP server', err);
  process.exit(1);
});

console.log(
  `Gaffer daemon: MCP on http://127.0.0.1:${MCP_PORT}/mcp, panel bridge on ws://127.0.0.1:${WS_PORT}`
);

// Dev auto-reload: on a dev install, watch our own sources and step aside when
// they change so the panel's reconnect boots a fresh daemon from the new code.
// Idle-gated (never mid-turn/sign-in) and settle-debounced (a branch switch =
// one reload, not a storm). End users (no repo) never enter this.
var DAEMON_DIR = dirname(fileURLToPath(import.meta.url));
var PANEL_DIR = pathJoin(DAEMON_DIR, '..');
if (isDevInstall(PANEL_DIR)) {
  var reloadBaseline = maxSourceMtime(DAEMON_DIR);
  var reloadLastMax = reloadBaseline;
  var reloadLastChangeAt = Date.now();
  var reloadArmed = false;
  console.log('Gaffer: dev auto-reload watching daemon sources');
  var reloadTimer = setInterval(() => {
    var cur = maxSourceMtime(DAEMON_DIR);
    if (cur > reloadLastMax) { reloadLastMax = cur; reloadLastChangeAt = Date.now(); reloadArmed = true; }
    if (!reloadArmed) return;
    var idle = !chatHandler.activeProcess && !signInInFlight && !activeSignIn;
    if (shouldReload({ baseline: reloadBaseline, currentMax: cur, lastChangeAt: reloadLastChangeAt, settleMs: 1500, idle: idle }, Date.now())) {
      clearInterval(reloadTimer);
      console.log('Gaffer: daemon sources changed — reloading');
      bridge.broadcast({ type: 'daemon_reloading', message: 'Reloading Gaffer for updated code…' });
      setTimeout(() => process.exit(0), 250); // let the notice flush, then let the panel relaunch us
    }
  }, 3000);
  if (reloadTimer.unref) reloadTimer.unref();
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nGaffer: shutting down');
  chatHandler.cancel();
  bridge.stop();
  process.exit(0);
});
