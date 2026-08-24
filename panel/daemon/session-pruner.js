// Rewrites a Claude Code session transcript to shed replayed image payloads.
// Pure rewriter (pruneTranscriptLines) + safe file layer (added in Task 2).

import { readFileSync, writeFileSync, renameSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

  // Pass 2: collect every image block in chronological (file) order, tracking line index.
  var imgRefs = [];
  for (var j = 0; j < parsed.length; j++) {
    var o = parsed[j];
    if (!o || !o.message || !Array.isArray(o.message.content)) continue;
    for (var blk of o.message.content) {
      if (blk && blk.type === 'image') {
        imgRefs.push({ block: blk, path: null, lineIdx: j });
      } else if (blk && blk.type === 'tool_result' && Array.isArray(blk.content)) {
        for (var c of blk.content) {
          if (c && c.type === 'image') imgRefs.push({ block: c, path: pathById[blk.tool_use_id] || null, lineIdx: j });
        }
      }
    }
  }

  // Stub everything except the most-recent keepRecent; track which lines we touch.
  var cutoff = imgRefs.length - keepRecent;
  var stubbed = 0;
  var touched = {};
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
    touched[imgRefs[k].lineIdx] = true;
    stubbed++;
  }

  // Re-serialize: only stringify touched lines; untouched lines round-trip verbatim.
  var out = [];
  for (var m = 0; m < parsed.length; m++) {
    if (parsed[m] === null) {
      out.push(lines[m]);
    } else if (touched[m]) {
      out.push(JSON.stringify(parsed[m]));
    } else {
      out.push(lines[m]);
    }
  }
  return { lines: out, stubbed: stubbed, kept: Math.max(0, Math.min(keepRecent, imgRefs.length)), images: imgRefs.length };
}

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
