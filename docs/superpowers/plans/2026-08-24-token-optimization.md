# Token Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut per-turn input tokens in Gaffer panel chat by stubbing replayed image payloads out of the resumed transcript, plus two isolated levers (prompt conciseness, an optional model downshift).

**Architecture:** A new daemon module rewrites the CLI's own session `.jsonl` in place — mutating heavy `image` blocks outside a recency window into light text pointers, keeping every other block and the file skeleton byte-for-byte. It runs after a turn's process closes (before the next `--resume`). A prompt directive reduces new image reads. An opt-in local heuristic downshifts the model on trivial turns.

**Tech Stack:** Node.js ESM (`panel/daemon`, `"type":"module"`), `node:test` + `node:assert` for tests, no new dependencies. Panel is browser JS (ES5-style `var`, no build step) persisting settings to `chat-history.json` and sending them per chat message over WebSocket.

**Spec:** `docs/superpowers/specs/2026-08-24-token-optimization-design.md`

## Global Constraints

- Daemon code is ESM (`import`/`export`), Node ≥ 18 (`node:test`, `AbortSignal.timeout` already used in-repo). Use `var` + `function` style to match `chat-handler.js`; no new npm dependencies.
- The pruner **must never throw** — any failure returns `null` and the turn proceeds untouched. Worst case is "nothing happened".
- **Line count is invariant.** A rewrite that changes the number of transcript lines, or produces a line that no longer parses as JSON, must be abandoned (paired `tool_use`/`tool_result` by `tool_use_id` — break one side and the API rejects the whole conversation).
- Locate transcripts by **scanning** `~/.claude/projects/*/<sessionId>.jsonl` — never derive the directory from `cwd` (undocumented encoding, breaks on the spaces in this repo's path).
- Panel JS files (`main.js`, `index.html`) are **not** bundled — edit the shipped source directly, ES5 idioms only (`var`, no arrow functions/template literals) to match surrounding code.
- Real serialized shape (enumerated from data): image block = `{type:'image', source:{type:'base64', media_type, data}}`, found inside a `tool_result` block's `content` **array** (`{tool_use_id, type:'tool_result', content:[...]}`). Path recoverable via `tool_use_id` → the assistant `tool_use` block's `input.file_path`.

---

## File Structure

- `panel/daemon/session-pruner.js` — **new.** Pure rewriter (`pruneTranscriptLines`) + safe file layer (`pruneSessionFile`, `findTranscript`).
- `panel/daemon/model-router.js` — **new.** Pure `chooseModel` heuristic.
- `panel/daemon/chat-handler.js` — **modify.** Call `pruneSessionFile` in `child.on('close')`; apply `chooseModel` when `msg.autoModel`.
- `panel/daemon/package.json` — **modify.** Add `test` script.
- `panel/daemon/test/` — **new dir.** `session-pruner.test.mjs`, `pruner-file.test.mjs`, `pruner-integration.test.mjs`, `model-router.test.mjs`.
- `panel/prompts/gaffer.md` — **modify.** Conciseness directive.
- `panel/index.html` — **modify.** `autoModel` toggle markup.
- `panel/main.js` — **modify.** `autoModel` var: persist, load, send, change-handler.

---

### Task 1: Pure transcript rewriter

**Files:**
- Create: `panel/daemon/session-pruner.js`
- Create: `panel/daemon/test/session-pruner.test.mjs`
- Modify: `panel/daemon/package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `pruneTranscriptLines(lines, opts)` where `lines: string[]` (raw JSONL lines, no trailing-newline empty element), `opts: {keepRecent?: number}` (default 6). Returns `{lines: string[], stubbed: number, kept: number, images: number}`. Output `lines.length === input lines.length` always. Mutates image blocks in place → `{type:'text', text}`, `tool_use_id` and all sibling blocks untouched. Never throws on malformed lines (passes them through verbatim).

- [ ] **Step 1: Add the test script to package.json**

Modify `panel/daemon/package.json` `scripts` to:

```json
  "scripts": {
    "start": "node index.js",
    "test": "node --test test/*.test.mjs"
  },
```

- [ ] **Step 2: Write the failing tests**

Create `panel/daemon/test/session-pruner.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneTranscriptLines } from '../session-pruner.js';

// Helpers to build realistic transcript lines.
function toolUseLine(id, path) {
  return JSON.stringify({ type: 'assistant', uuid: 'a-' + id, message: { role: 'assistant', content: [
    { type: 'tool_use', id, name: 'Read', input: { file_path: path } },
  ] } });
}
function imageResultLine(id, kb) {
  var data = 'A'.repeat(kb * 1024); // base64-ish filler
  return JSON.stringify({ type: 'user', uuid: 'u-' + id, toolUseResult: { note: 'bookkeeping' }, message: { role: 'user', content: [
    { tool_use_id: id, type: 'tool_result', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ] },
  ] } });
}

test('stubs image blocks in tool_result arrays outside the recency window', () => {
  var lines = [];
  for (var i = 0; i < 10; i++) { lines.push(toolUseLine('t' + i, '/tmp/f' + i + '.png')); lines.push(imageResultLine('t' + i, 20)); }
  var res = pruneTranscriptLines(lines, { keepRecent: 3 });
  assert.equal(res.images, 10);
  assert.equal(res.kept, 3);
  assert.equal(res.stubbed, 7);
  assert.equal(res.lines.length, lines.length); // line count invariant
});

test('stubbed block becomes a text pointer naming the path, image gone', () => {
  var lines = [toolUseLine('x1', '/tmp/frame.png'), imageResultLine('x1', 50)];
  var res = pruneTranscriptLines(lines, { keepRecent: 0 });
  var obj = JSON.parse(res.lines[1]);
  var block = obj.message.content[0].content[0];
  assert.equal(block.type, 'text');
  assert.equal(block.source, undefined);
  assert.match(block.text, /elided by Gaffer/);
  assert.match(block.text, /\/tmp\/frame\.png/);
  assert.equal(obj.message.content[0].tool_use_id, 'x1'); // pairing preserved
});

test('keeps the most recent K images byte-for-byte', () => {
  var lines = [toolUseLine('a', '/a.png'), imageResultLine('a', 20), toolUseLine('b', '/b.png'), imageResultLine('b', 20)];
  var res = pruneTranscriptLines(lines, { keepRecent: 1 });
  var kept = JSON.parse(res.lines[3]).message.content[0].content[0];
  assert.equal(kept.type, 'image'); // newest survives
  var stubbed = JSON.parse(res.lines[1]).message.content[0].content[0];
  assert.equal(stubbed.type, 'text');
});

test('non-image tool_results and text blocks are untouched', () => {
  var textLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
  var res = pruneTranscriptLines([textLine], { keepRecent: 0 });
  assert.equal(res.stubbed, 0);
  assert.equal(res.lines[0], textLine); // verbatim
});

test('malformed lines pass through verbatim', () => {
  var res = pruneTranscriptLines(['not json{{{', ''], { keepRecent: 0 });
  assert.equal(res.lines[0], 'not json{{{');
  assert.equal(res.lines[1], '');
  assert.equal(res.stubbed, 0);
});

test('bare inline image block is stubbed too', () => {
  var line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(20480) } }] } });
  var res = pruneTranscriptLines([line], { keepRecent: 0 });
  assert.equal(res.stubbed, 1);
  assert.equal(JSON.parse(res.lines[0]).message.content[0].type, 'text');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd panel/daemon && node --test test/session-pruner.test.mjs`
Expected: FAIL — `Cannot find module '../session-pruner.js'` / `pruneTranscriptLines is not a function`.

- [ ] **Step 4: Write the minimal implementation**

Create `panel/daemon/session-pruner.js`:

```js
// Rewrites a Claude Code session transcript to shed replayed image payloads.
// Pure rewriter (pruneTranscriptLines) + safe file layer (added in Task 2).

function byteLen(v) {
  return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
}

// lines: array of raw JSONL strings (no trailing empty element).
// opts.keepRecent: number of most-recent image blocks to leave byte-for-byte.
// Returns { lines, stubbed, kept, images }. Never throws on bad input.
export function pruneTranscriptLines(lines, opts) {
  opts = opts || {};
  var keepRecent = opts.keepRecent == null ? 6 : opts.keepRecent;

  // Pass 1: parse each line once; map tool_use_id -> Read file_path.
  var parsed = [];
  var pathById = {};
  for (var i = 0; i < lines.length; i++) {
    var obj = null;
    if (lines[i] && lines[i].trim()) { try { obj = JSON.parse(lines[i]); } catch (e) { obj = null; } }
    parsed.push(obj);
    if (obj && obj.message && Array.isArray(obj.message.content)) {
      for (var b of obj.message.content) {
        if (b && b.type === 'tool_use' && b.id) pathById[b.id] = (b.input && b.input.file_path) || null;
      }
    }
  }

  // Pass 2: collect every image block in chronological (file) order.
  var imgRefs = [];
  for (var j = 0; j < parsed.length; j++) {
    var o = parsed[j];
    if (!o || !o.message || !Array.isArray(o.message.content)) continue;
    for (var blk of o.message.content) {
      if (blk && blk.type === 'image') {
        imgRefs.push({ block: blk, path: null });
      } else if (blk && blk.type === 'tool_result' && Array.isArray(blk.content)) {
        for (var c of blk.content) {
          if (c && c.type === 'image') imgRefs.push({ block: c, path: pathById[blk.tool_use_id] || null });
        }
      }
    }
  }

  // Stub everything except the most-recent keepRecent.
  var cutoff = imgRefs.length - keepRecent;
  var stubbed = 0;
  for (var k = 0; k < imgRefs.length && k < cutoff; k++) {
    var img = imgRefs[k].block;
    var data = img.source && img.source.data ? img.source.data : '';
    var kb = Math.round(byteLen(data) / 1024) || 1;
    var mt = (img.source && img.source.media_type) || 'image';
    var where = imgRefs[k].path
      ? 'Read ' + imgRefs[k].path + ' again if you need it, or re-run captureFrame'
      : 'call the tool again if you need it';
    delete img.source;
    img.type = 'text';
    img.text = '[' + kb + ' KB ' + mt + ' elided by Gaffer — ' + where + ']';
    stubbed++;
  }

  // Re-serialize: changed objects re-stringified; unparsed lines verbatim.
  var out = [];
  for (var m = 0; m < parsed.length; m++) {
    out.push(parsed[m] === null ? lines[m] : JSON.stringify(parsed[m]));
  }
  return { lines: out, stubbed: stubbed, kept: Math.min(keepRecent, imgRefs.length), images: imgRefs.length };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd panel/daemon && node --test test/session-pruner.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add panel/daemon/session-pruner.js panel/daemon/test/session-pruner.test.mjs panel/daemon/package.json
git commit -m "feat(pruner): pure transcript rewriter — stub images outside recency window"
```

---

### Task 2: Safe file layer

**Files:**
- Modify: `panel/daemon/session-pruner.js` (append `findTranscript`, `pruneSessionFile`)
- Create: `panel/daemon/test/pruner-file.test.mjs`

**Interfaces:**
- Consumes: `pruneTranscriptLines` from Task 1.
- Produces: `findTranscript(sessionId)` → absolute path string or `null`. `pruneSessionFile(sessionId, opts)` where `opts: {floorBytes?: number (default 512*1024), keepRecent?: number, file?: string (override scan)}`. Returns the rewriter report `{lines,stubbed,kept,images}` on a successful write, or `null` (no-op / too small / not found / any failure). Writes `<file>.bak`, then temp + `rename`. Never throws.

- [ ] **Step 1: Write the failing tests**

Create `panel/daemon/test/pruner-file.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneSessionFile, findTranscript } from '../session-pruner.js';

function bigImageTranscript(sessionId, nImages) {
  var lines = [];
  for (var i = 0; i < nImages; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't' + i, name: 'Read', input: { file_path: '/tmp/f' + i + '.png' } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 't' + i, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(60 * 1024) } }] }] } }));
  }
  return lines.join('\n') + '\n';
}

test('rewrites a large file, writes .bak, result still valid JSONL', () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-prune-'));
  var file = join(dir, 'sess.jsonl');
  writeFileSync(file, bigImageTranscript('sess', 12));
  var before = statSync(file).size;
  var res = pruneSessionFile('sess', { file, keepRecent: 3 });
  assert.ok(res && res.stubbed === 9);
  assert.ok(existsSync(file + '.bak'));
  var after = statSync(file).size;
  assert.ok(after < before / 2); // most bytes gone
  for (var line of readFileSync(file, 'utf8').split('\n')) { if (line.trim()) JSON.parse(line); } // all parse
  assert.equal(readFileSync(file + '.bak', 'utf8').length, before); // bak is the original
});

test('skips files under the floor', () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-prune-'));
  var file = join(dir, 'small.jsonl');
  writeFileSync(file, JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
  assert.equal(pruneSessionFile('small', { file }), null);
  assert.equal(existsSync(file + '.bak'), false);
});

test('no-op when there is nothing to stub (returns null, no write)', () => {
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-prune-'));
  var file = join(dir, 'notext.jsonl');
  writeFileSync(file, (JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(600 * 1024) }] } }) + '\n'));
  assert.equal(pruneSessionFile('notext', { file, keepRecent: 0 }), null);
  assert.equal(existsSync(file + '.bak'), false);
});

test('missing file returns null, never throws', () => {
  assert.equal(pruneSessionFile('nope', { file: '/does/not/exist.jsonl' }), null);
});

test('findTranscript scans project dirs incl. spaced paths', () => {
  var home = mkdtempSync(join(tmpdir(), 'gaffer-home-'));
  var proj = join(home, '.claude', 'projects', '-Some-Path-With Space');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'uuid-123.jsonl'), '{}\n');
  var found = findTranscript('uuid-123', { home });
  assert.equal(found, join(proj, 'uuid-123.jsonl'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd panel/daemon && node --test test/pruner-file.test.mjs`
Expected: FAIL — `pruneSessionFile is not a function`.

- [ ] **Step 3: Append the implementation to session-pruner.js**

Add these imports at the top of `panel/daemon/session-pruner.js` (above `byteLen`):

```js
import { readFileSync, writeFileSync, renameSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
```

Append at the end of `panel/daemon/session-pruner.js`:

```js
// Scan ~/.claude/projects/*/<sessionId>.jsonl — session ids are UUIDs, so a
// filename match is unambiguous. opts.home overrides HOME (tests).
export function findTranscript(sessionId, opts) {
  opts = opts || {};
  if (!sessionId) return null;
  var base = join(opts.home || homedir(), '.claude', 'projects');
  var dirs;
  try { dirs = readdirSync(base); } catch (e) { return null; }
  for (var d of dirs) {
    var p = join(base, d, sessionId + '.jsonl');
    try { statSync(p); return p; } catch (e) { /* miss */ }
  }
  return null;
}

// Prune one session file in place. Never throws — any failure returns null and
// the caller proceeds untouched.
export function pruneSessionFile(sessionId, opts) {
  try {
    opts = opts || {};
    var FLOOR = opts.floorBytes == null ? 512 * 1024 : opts.floorBytes;
    var file = opts.file || findTranscript(sessionId, opts);
    if (!file) return null;
    var st;
    try { st = statSync(file); } catch (e) { return null; }
    if (st.size < FLOOR) return null;
    var raw;
    try { raw = readFileSync(file, 'utf8'); } catch (e) { return null; }

    var lines = raw.split('\n');
    var trailingNL = lines.length > 0 && lines[lines.length - 1] === '';
    var body = trailingNL ? lines.slice(0, -1) : lines;

    var res;
    try { res = pruneTranscriptLines(body, opts); } catch (e) { return null; }
    if (!res || !res.stubbed) return null;

    // Validate before swapping: line count invariant + every line still parses.
    if (res.lines.length !== body.length) return null;
    for (var i = 0; i < res.lines.length; i++) {
      var l = res.lines[i];
      if (!l || !l.trim()) continue;
      try { JSON.parse(l); } catch (e) { return null; }
    }

    var outText = res.lines.join('\n') + (trailingNL ? '\n' : '');
    try {
      writeFileSync(file + '.bak', raw);
      var tmp = file + '.tmp';
      writeFileSync(tmp, outText);
      renameSync(tmp, file);
    } catch (e) { return null; }

    console.log('[prune] ' + sessionId + ' ' + Math.round(st.size / 1024) + 'KB -> '
      + Math.round(Buffer.byteLength(outText, 'utf8') / 1024) + 'KB | imgs stubbed '
      + res.stubbed + ' kept ' + res.kept);
    return res;
  } catch (e) {
    return null; // absolute backstop — the pruner must never take down a turn
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd panel/daemon && node --test test/pruner-file.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add panel/daemon/session-pruner.js panel/daemon/test/pruner-file.test.mjs
git commit -m "feat(pruner): safe file layer — scan-locate, floor, validate, bak+rename"
```

---

### Task 3: Wire the pruner into the chat lifecycle

**Files:**
- Modify: `panel/daemon/chat-handler.js` (import + call in `child.on('close')`)
- Create: `panel/daemon/test/pruner-integration.test.mjs`

**Interfaces:**
- Consumes: `pruneSessionFile` from Task 2.
- Produces: no new exports. Side effect: after a turn's process closes and `chat_done` is sent, if `this.sessionId` is set and no compaction is in flight, the session file is pruned.

- [ ] **Step 1: Write the failing integration test**

Create `panel/daemon/test/pruner-integration.test.mjs`. This exercises the file layer end-to-end on a realistic fixture and asserts the resumed-transcript invariants the CLI depends on (pairing intact, still valid JSONL, images gone):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneSessionFile } from '../session-pruner.js';

test('resumed transcript stays API-valid after prune: pairing intact, images gone', () => {
  var lines = [];
  // 8 capture->read image cycles, interleaved with agent text (must survive).
  for (var i = 0; i < 8; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'checking frame ' + i }, { type: 'tool_use', id: 'r' + i, name: 'Read', input: { file_path: '/tmp/frame' + i + '.png' } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'r' + i, type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(80 * 1024) } }] }] } }));
  }
  var dir = mkdtempSync(join(tmpdir(), 'gaffer-int-'));
  var file = join(dir, 'sess.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');

  var res = pruneSessionFile('sess', { file, keepRecent: 2 });
  assert.equal(res.stubbed, 6);

  var out = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  // Every tool_result still has its matching tool_use id (pairing preserved).
  var useIds = new Set(), resultIds = new Set();
  for (var o of out) for (var b of o.message.content) {
    if (b.type === 'tool_use') useIds.add(b.id);
    if (b.type === 'tool_result') resultIds.add(b.tool_use_id);
  }
  for (var id of resultIds) assert.ok(useIds.has(id), 'result ' + id + ' still paired');
  // Agent text blocks all survive.
  var texts = out.flatMap(o => o.message.content).filter(b => b.type === 'text' && /checking frame/.test(b.text));
  assert.equal(texts.length, 8);
  // Only 2 images remain inline.
  var imgs = out.flatMap(o => o.message.content).flatMap(b => Array.isArray(b.content) ? b.content : []).filter(c => c.type === 'image');
  assert.equal(imgs.length, 2);
});
```

- [ ] **Step 2: Run the test to verify it passes** (it uses only Task 2 code)

Run: `cd panel/daemon && node --test test/pruner-integration.test.mjs`
Expected: PASS (1 test). (This test guards the invariants; the wiring in Steps 3–4 has no separate automated test — verified by the manual smoke in Step 5.)

- [ ] **Step 3: Add the import to chat-handler.js**

In `panel/daemon/chat-handler.js`, add after the existing import block (near line 8):

```js
import { pruneSessionFile } from './session-pruner.js';
```

- [ ] **Step 4: Call the pruner after the turn closes**

In `panel/daemon/chat-handler.js`, inside `child.on('close')`, locate the compaction block near the end:

```js
      if (this.sessionId && this.lastInputTokens >= COMPACT_THRESHOLD_TOKENS && !this.compacting) {
        this._compactSession(socket);
      }
```

Insert immediately **before** it:

```js
      // Shed replayed image payloads from the persisted transcript before the
      // next --resume. Safe window: this turn's process has exited. Skipped
      // while a background compaction holds the session. Never throws.
      if (this.sessionId && !this.compacting) {
        pruneSessionFile(this.sessionId);
      }
```

- [ ] **Step 5: Manual smoke — prune a real session copy**

Run (copies a real large session to a temp path and prunes the copy, leaving the original untouched):

```bash
cd panel/daemon && node -e "import('./session-pruner.js').then(m=>{const{execSync}=require('node:child_process');const src=execSync(`ls -S ~/.claude/projects/*panel-daemon/*.jsonl | head -1`).toString().trim();const dst='/tmp/gaffer-smoke.jsonl';require('node:fs').copyFileSync(src,dst);console.log('report:',m.pruneSessionFile('gaffer-smoke',{file:dst}));})"
```

Expected: a `[prune] … KB -> … KB | imgs stubbed N kept 6` log with a large reduction, and `report:` showing `stubbed > 0`. Confirm `/tmp/gaffer-smoke.jsonl` is still valid JSONL:

```bash
node -e "for(const l of require('node:fs').readFileSync('/tmp/gaffer-smoke.jsonl','utf8').split('\n')){if(l.trim())JSON.parse(l)}console.log('all lines parse OK')"
```

- [ ] **Step 6: Commit**

```bash
git add panel/daemon/chat-handler.js panel/daemon/test/pruner-integration.test.mjs
git commit -m "feat(pruner): run after each turn closes; integration test for resume invariants"
```

---

### Task 4: Prompt conciseness directive

**Files:**
- Modify: `panel/prompts/gaffer.md` (extend the `## Output` section)

**Interfaces:** none (prompt text only).

- [ ] **Step 1: Extend the Output section**

In `panel/prompts/gaffer.md`, the `## Output` section currently reads:

```markdown
## Output

- One sentence before acting, describing what you're about to do.
- After the task, summarize what changed.
- If blocked, say so and explain why.
```

Replace it with:

```markdown
## Output

- One sentence before acting, describing what you're about to do.
- After the task, summarize what changed.
- If blocked, say so and explain why.
- Be concise. Don't narrate every intermediate step or restate tool
  output the user can already see.
- Don't re-Read an image (frame capture, reference PNG) you have already
  read in this conversation — you still have it. Read it again only if the
  file changed or a previous read was elided with a "[… elided by Gaffer …]"
  pointer and you genuinely need to see it again.
```

- [ ] **Step 2: Commit**

```bash
git add panel/prompts/gaffer.md
git commit -m "feat(prompt): conciseness + don't re-Read images already in context"
```

---

### Task 5: Model-downshift heuristic + daemon wiring

**Files:**
- Create: `panel/daemon/model-router.js`
- Create: `panel/daemon/test/model-router.test.mjs`
- Modify: `panel/daemon/chat-handler.js` (apply when `msg.autoModel`)

**Interfaces:**
- Consumes: nothing.
- Produces: `chooseModel(message, requested)` where `message: string`, `requested: {model: string, effort?: string}`. Returns `{model: string, effort: string|undefined}`. Only ever downshifts to `'haiku'` on trivial turns; never upshifts; returns `requested` unchanged for pinned ids (`claude-*`) or `[1m]` models or any non-trivial message.

- [ ] **Step 1: Write the failing tests**

Create `panel/daemon/test/model-router.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel } from '../model-router.js';

test('downshifts a short non-build question to haiku', () => {
  assert.equal(chooseModel('what did you do?', { model: 'opus' }).model, 'haiku');
  assert.equal(chooseModel('thanks!', { model: 'opus' }).model, 'haiku');
});

test('does NOT downshift build/expression tasks', () => {
  assert.equal(chooseModel('add a wiggle to the selected layer', { model: 'opus' }).model, 'opus');
  assert.equal(chooseModel('write an expression that loops the position', { model: 'opus' }).model, 'opus');
  assert.equal(chooseModel('animate the logo scaling in with overshoot', { model: 'opus' }).model, 'opus');
});

test('does not downshift long/detailed messages even without build verbs', () => {
  var long = 'here is a lot of context '.repeat(20);
  assert.equal(chooseModel(long, { model: 'opus' }).model, 'opus');
});

test('never touches pinned ids or 1m variants', () => {
  assert.equal(chooseModel('hi', { model: 'claude-opus-4-8' }).model, 'claude-opus-4-8');
  assert.equal(chooseModel('hi', { model: 'opus[1m]' }).model, 'opus[1m]');
});

test('never upshifts — haiku stays haiku', () => {
  assert.equal(chooseModel('add a wiggle', { model: 'haiku' }).model, 'haiku');
});

test('messages containing code fences or tool mentions are not trivial', () => {
  assert.equal(chooseModel('why did ```var x``` fail?', { model: 'opus' }).model, 'opus');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd panel/daemon && node --test test/model-router.test.mjs`
Expected: FAIL — `Cannot find module '../model-router.js'`.

- [ ] **Step 3: Write the implementation**

Create `panel/daemon/model-router.js`:

```js
// Conservative model downshift for the optional autoModel toggle. Only ever
// picks a CHEAPER model on clearly-trivial turns; never upshifts, never
// overrides a pinned version id or a [1m] context variant. A bad downshift
// makes the user redo work (costing more), so the trivial test is narrow.
var HEAVY = /\b(build|create|animate|add|make|expression|keyframe|rig|wiggle|precomp|composition|import|render|effect|shape|mask|morph|transition|loop|stagger|parent|null|track|stabilize|export)\b/i;

export function chooseModel(message, requested) {
  requested = requested || {};
  var model = requested.model || 'opus';
  var effort = requested.effort;

  // Leave pinned ids and 1M-context variants exactly as requested.
  if (model.indexOf('claude-') === 0 || /\[1m\]/.test(model)) return { model: model, effort: effort };

  var text = String(message || '').trim();
  var trivial = text.length > 0 && text.length <= 200 && !HEAVY.test(text) && !/```|mcp__/.test(text);

  if (trivial && model !== 'haiku') {
    return { model: 'haiku', effort: effort };
  }
  return { model: model, effort: effort };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd panel/daemon && node --test test/model-router.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire it into chat-handler.js (guarded by msg.autoModel)**

In `panel/daemon/chat-handler.js`, add the import after the Task 3 import:

```js
import { chooseModel } from './model-router.js';
```

Then locate this existing block (near line 316):

```js
    var model = msg.model || 'opus';
    // Context-window variant: 1M suffix, passed through for ANY model
```

Insert immediately **after** the `var model = msg.model || 'opus';` line:

```js
    var effort = msg.effort;
    // Optional, off by default: on trivial turns pick a cheaper model. Never
    // upshifts, never overrides a pinned id / 1m variant. Logged so the effect
    // can be measured before this lever earns its keep.
    if (msg.autoModel && msg.variant !== '1m') {
      var picked = chooseModel(msg.message, { model: model, effort: effort });
      if (picked.model !== model) console.log('[automodel] downshift ' + model + ' -> ' + picked.model);
      model = picked.model;
      effort = picked.effort;
    }
```

Then change the effort push a few lines below — replace:

```js
    var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (msg.effort && EFFORTS.indexOf(msg.effort) !== -1) args.push('--effort', msg.effort);
```

with (use the local `effort`, which autoModel may have adjusted):

```js
    var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (effort && EFFORTS.indexOf(effort) !== -1) args.push('--effort', effort);
```

- [ ] **Step 6: Run the full daemon test suite**

Run: `cd panel/daemon && npm test`
Expected: PASS — all four test files (session-pruner, pruner-file, pruner-integration, model-router) green.

- [ ] **Step 7: Commit**

```bash
git add panel/daemon/model-router.js panel/daemon/test/model-router.test.mjs panel/daemon/chat-handler.js
git commit -m "feat(automodel): conservative downshift heuristic, wired behind msg.autoModel"
```

---

### Task 6: Panel toggle for autoModel

**Files:**
- Modify: `panel/index.html` (toggle markup)
- Modify: `panel/main.js` (var, persist, load, change-handler, send)

**Interfaces:**
- Consumes: `msg.autoModel` read by chat-handler (Task 5).
- Produces: panel sends `autoModel: <boolean>` in both the settings-persist blob and the chat send message.

- [ ] **Step 1: Add the toggle markup**

In `panel/index.html`, find the `autoCheckUpdates` toggle (lines 1151–1154) inside the `<div class="activity-settings">` block; the caption is plain text inside the label, no wrapper class:

```html
      <label class="toggle-label">
        <input type="checkbox" id="autoCheckUpdates">
        <span class="toggle"><span class="knob"></span></span>
        Auto-check updates
      </label>
      <button id="checkNowBtn" class="text-btn">Check now</button>
```

Insert the new toggle **between** the `autoCheckUpdates` label's closing `</label>` and the `#checkNowBtn` button, mirroring the exact structure (plain-text caption):

```html
      <label class="toggle-label" title="On trivial questions, use a lighter model to save tokens">
        <input type="checkbox" id="autoModel">
        <span class="toggle"><span class="knob"></span></span>
        Auto-lighten
      </label>
```

- [ ] **Step 2: Add the variable and element handle**

In `panel/main.js`, near the other setting vars (line ~51 `var autoCheckUpdates = true;`), add:

```js
  var autoModel = false; // off by default; persisted in chat-history.json
```

Near the other element handles (line ~31 `var autoCheckEl = document.getElementById('autoCheckUpdates');`), add:

```js
  var autoModelEl = document.getElementById('autoModel');
```

- [ ] **Step 3: Persist + load + change-handler**

In `panel/main.js`, in the settings-persist object (the `JSON.stringify({ ... })` near line 484, alongside `autoCheckUpdates: autoCheckUpdates,`), add:

```js
      autoModel: autoModel,
```

In the `applyData` loader — right after the `autoCheckUpdates` restore block (line ~535–537, which does `autoCheckUpdates = data.autoCheckUpdates; autoCheckEl.checked = autoCheckUpdates;`), add:

```js
        if (typeof data.autoModel === 'boolean') {
          autoModel = data.autoModel;
          if (autoModelEl) autoModelEl.checked = autoModel;
        }
```

The `autoCheckUpdates` change handler is at `panel/main.js:2232`:

```js
  autoCheckEl.addEventListener('change', function () {
    autoCheckUpdates = autoCheckEl.checked;
    saveChat();
  });
```

Add the mirror handler immediately after it (persist with the same `saveChat()`):

```js
  if (autoModelEl) {
    autoModelEl.addEventListener('change', function () {
      autoModel = autoModelEl.checked;
      saveChat();
    });
  }
```

- [ ] **Step 4: Send it with the chat message**

In `panel/main.js`, in the chat send `ws.send(JSON.stringify({ ... }))` (near line 987, where `enabledMcps: enabledMcps,` is sent), add:

```js
      autoModel: autoModel,
```

- [ ] **Step 5: Manual verification in the panel**

Reload the panel in AE. Open settings, confirm the new toggle renders and its state survives a panel reload (persisted). With it **on**, send a trivial message ("what did you do?") and confirm the daemon log shows `[automodel] downshift opus -> haiku`; with it **off**, confirm no such line. (Daemon log: `/tmp/gaffer-daemon.log`.)

- [ ] **Step 6: Commit**

```bash
git add panel/index.html panel/main.js
git commit -m "feat(automodel): panel toggle — persist, load, send autoModel"
```

---

## Verification (whole branch)

- [ ] `cd panel/daemon && npm test` — all four test files green.
- [ ] Manual smoke (Task 3 Step 5) shows a real session shrinking with valid JSONL out.
- [ ] Panel toggle (Task 6 Step 5) persists and drives the daemon log line.
- [ ] Re-run the Phase 0 analyzer against a freshly-pruned session copy and confirm API-bound dropped ~85% (`analyze-session.mjs` in scratchpad).
- [ ] Bump `panel/version.json` + `CHANGELOG.md` entry (per repo release process) — do this at merge time, not per-task.

## Notes for the executor

- **Do not** touch the `assistant:thinking` blocks — they are the cheap-keep category that makes multi-turn continuity work; stubbing them was explicitly rejected (see spec §Rejected).
- **Do not** move frame captures to a stable cache dir in this branch — the stub text already names both recovery routes (re-Read / re-captureFrame). Stable-cache is a noted follow-up.
- The pruner rewrites the CLI's own session file. Everything about the file layer exists to make the worst case "nothing happened" — if you find yourself removing a guard to make a test pass, the test is wrong, not the guard.
```
