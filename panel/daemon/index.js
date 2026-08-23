import { PanelBridge } from './panel-bridge.js';
import { Queue } from './queue.js';
import { startMcpServer } from './mcp-server.js';
import { ChatHandler, augmentedEnv } from './chat-handler.js';
import { authStatus, signIn, signOut } from './auth.js';
import { findClaudeBinary } from './claude-binary.js';

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
bridge.onListMcps = async (socket) => {
  // Panel asks for MCPs on load — ship the CLI-discovered model/effort
  // options on the same trigger.
  chatHandler.listModelOptions().then((opts) => {
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'models', models: opts.models, efforts: opts.efforts, versions: opts.versions }));
    }
  }).catch(() => {});
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nGaffer: shutting down');
  chatHandler.cancel();
  bridge.stop();
  process.exit(0);
});
