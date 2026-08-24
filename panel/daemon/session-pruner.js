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
