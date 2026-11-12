// Validation for every message the panel sends to the daemon (after the
// connection is authenticated). Strict shapes, unknown fields dropped, bounded
// sizes: the chat handler builds a command line and a system prompt from these
// fields, so nothing reaches it without passing a schema here first.
//
// Pure functions over plain objects, so the table lives in a unit test
// (test/bridge-messages.test.mjs). A rejection carries a short reason made of
// field paths and issue codes only, never message content, so it is safe to log.

import { z } from 'zod';

// ── Limits ──
// chat.message: 200 KB of text. A pasted image travels as a temp-file path in
// the message text, not as bytes, so this is the biggest field a legitimate
// message carries. Worst realistic content is multi-byte (3 UTF-8 bytes per
// character): 204,800 x 3 = 614,400 bytes plus about 2.5 KB of envelope, which
// stays under MAX_TYPED_BYTES with room for a second copy's worth of headroom.
export var MAX_CHAT_MESSAGE_CHARS = 204800;
export var MAX_TYPED_BYTES = 1024 * 1024;
// Before the proof verifies the only legitimate message is the ~200-byte auth.
// MAX_PREAUTH_BYTES is the application check; PREAUTH_MAX_PAYLOAD is the ws
// frame limit an unauthenticated socket gets, so an oversized frame is refused
// from its header instead of being buffered first. The bridge raises the frame
// limit once the proof verifies.
export var MAX_PREAUTH_BYTES = 2048;
export var PREAUTH_MAX_PAYLOAD = 4096;

var MAX_MCPS = 32;
// Connector and server names come from `claude mcp list` (claude.ai display
// names with &, ', parentheses or non-ASCII, plugin ids, user-chosen names), so
// the rule only excludes what could do harm downstream: a comma (the tool list
// separator), control characters, a leading dash (an option on a command
// line), and absurd lengths. The spawn layer matches names against the real
// server list on its own.
var NAME_RE = /^[^,\u0000-\u001f\u007f-\u009f\-][^,\u0000-\u001f\u007f-\u009f]{0,199}$/;
var MODEL_RE = /^[a-z0-9][a-z0-9._\-\[\]]{0,63}$/;
var AE_VERSION_RE = /^([0-9]+(\.[0-9]+){0,3}|unknown)$/; // 'unknown' is what the panel reports when AE hides its version
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
var MODEL_ALIAS_RE = /^(opus|sonnet|haiku|fable|mythos)(\[1m\])?$/;

var nameSchema = z.string().regex(NAME_RE);
var aeVersionSchema = z.string().regex(AE_VERSION_RE);

var chatSchema = z.object({
  type: z.literal('chat'),
  message: z.string().max(MAX_CHAT_MESSAGE_CHARS),
  sessionId: z.string().regex(UUID_RE).nullish(),
  model: z.string().regex(MODEL_RE).nullish(),
  effort: z.unknown().optional(), // unknown levels are dropped below, as the chat handler always did
  aeVersion: aeVersionSchema.nullish(),
  enabledMcps: z.array(nameSchema).max(MAX_MCPS).nullish(),
  newConversation: z.boolean().nullish(),
});

var bare = function (t) { return z.object({ type: z.literal(t) }); };

var SCHEMAS = {
  chat: chatSchema,
  register: z.object({
    type: z.literal('register'),
    aeVersion: aeVersionSchema.nullish(),
    projectPath: z.string().max(4096).nullish(),
  }),
  auth_mcp: z.object({
    type: z.literal('auth_mcp'),
    id: nameSchema.refine(function (s) { return s.charAt(0) !== '-'; }),
  }),
  sign_in: z.object({ type: z.literal('sign_in'), mode: z.enum(['claudeai', 'console']).nullish() }),
  set_share_usage_stats: z.object({ type: z.literal('set_share_usage_stats'), enabled: z.boolean() }),
  chat_cancel: bare('chat_cancel'),
  list_mcps: bare('list_mcps'),
  list_models: bare('list_models'),
  auth_status: bare('auth_status'),
  sign_out: bare('sign_out'),
  cancel_sign_in: bare('cancel_sign_in'),
  get_share_usage_stats: bare('get_share_usage_stats'),
  // Buttons in the (hidden) API-key part of Settings send these; the daemon has
  // no handler for them yet. Bare on purpose: anything else in them, a pasted
  // key included, is dropped at the door.
  api_connect: bare('api_connect'),
  api_disconnect: bare('api_disconnect'),
  api_add_key: bare('api_add_key'),
  api_forget: bare('api_forget'),
};

// The answer to a {id, code} request has no type field.
var jsxResponseSchema = z.object({
  id: z.string().min(1).max(64),
  ok: z.boolean().nullish(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  line: z.number().nullish(),
});

function reasonFrom(error) {
  var issue = error && error.issues && error.issues[0];
  if (!issue) return 'invalid message';
  var path = (issue.path || []).map(String).join('.') || '(message)';
  return path + ': ' + issue.code;
}

/**
 * Validate one parsed client message.
 *
 * ctx.isIssuedSession(id): true only for a session id this daemon issued. A
 * panel-supplied sessionId that is a well-formed UUID but not issued is
 * dropped (the turn then starts or resumes by the daemon's own rules), not
 * trusted. Without a ledger every id counts as unissued.
 *
 * Returns { ok: true, msg, droppedSessionId? } or { ok: false, reason }.
 */
export function validateClientMessage(raw, ctx) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '(message): not an object' };
  }
  var schema;
  if (raw.type === undefined) {
    schema = jsxResponseSchema;
  } else if (typeof raw.type === 'string' && Object.prototype.hasOwnProperty.call(SCHEMAS, raw.type)) {
    schema = SCHEMAS[raw.type];
  } else {
    return { ok: false, reason: 'type: unknown' };
  }
  var parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: reasonFrom(parsed.error) };

  var msg = parsed.data;
  var out = { ok: true, msg: msg };
  if (raw.type === 'chat' && msg.effort !== undefined && msg.effort !== null && EFFORTS.indexOf(msg.effort) === -1) {
    delete msg.effort;
  }
  if (raw.type === 'chat' && msg.sessionId != null) {
    var issued = !!(ctx && typeof ctx.isIssuedSession === 'function' && ctx.isIssuedSession(msg.sessionId));
    if (!issued) {
      delete msg.sessionId;
      out.droppedSessionId = true;
    }
  } else if (raw.type === 'chat') {
    delete msg.sessionId;
  }
  return out;
}

/**
 * What a panel is told when its chat message is refused (the socket stays
 * open; the panel needs a chat_error to stop showing a pending reply). Plain
 * wording, specific only for the two causes a user can fix.
 */
export function chatErrorText(reason) {
  var r = String(reason || '');
  if (r.indexOf('message: too_big') === 0 || r.indexOf('(message): too large') === 0) {
    return 'That message is too long to send. Shorten it or split it into parts.';
  }
  if (r.indexOf('enabledMcps: too_big') === 0) {
    return 'Too many connectors are switched on (the limit is ' + MAX_MCPS + '). Turn some off in Settings and try again.';
  }
  if (r.indexOf('enabledMcps') === 0) {
    return 'One of the enabled connectors has a name Gaffer cannot send. Turn connectors off in Settings and try again.';
  }
  return 'Gaffer could not send that message. Reload the panel and try again.';
}

/**
 * Is this model one the chat may be started with? An alias (opus, sonnet,
 * haiku, ...), an id in the live model list, or, while no live list has been
 * discovered yet, any claude- id (the pattern check already ran). Absent model
 * means "the default".
 */
export function isModelAllowed(model, liveCapabilities) {
  if (model == null) return true;
  var m = String(model);
  if (MODEL_ALIAS_RE.test(m)) return true;
  if (liveCapabilities && typeof liveCapabilities === 'object') {
    return Object.prototype.hasOwnProperty.call(liveCapabilities, m)
      || Object.prototype.hasOwnProperty.call(liveCapabilities, m.replace(/\[1m\]$/, ''));
  }
  return /^claude-[a-z0-9._\-\[\]]+$/.test(m);
}
