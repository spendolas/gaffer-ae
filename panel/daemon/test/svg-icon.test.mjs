import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeSvgRootAttributes, normalizeSvgIconBuffer } from '../svg-icon.js';

// What the simple-icons CDN text looks like after the fill injection.
var BROKEN = '<svg fill="currentColor" fill="#0061D5" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Box</title><path d="M0 0h24v24H0z"/></svg>';

test('duplicate root attributes: the first one wins, as the HTML parser did', () => {
  var out = dedupeSvgRootAttributes(BROKEN);
  assert.equal(out, '<svg fill="currentColor" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Box</title><path d="M0 0h24v24H0z"/></svg>');
});

test('the result is well-formed: no attribute appears twice on the root tag', () => {
  var root = /<svg\b([^>]*)>/.exec(dedupeSvgRootAttributes(BROKEN))[1];
  var names = (root.match(/\s([a-z:-]+)=/gi) || []).map((s) => s.trim().toLowerCase());
  assert.equal(new Set(names).size, names.length);
});

test('a clean icon, one without a root tag, and attributes inside children are untouched', () => {
  var clean = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" fill-rule="evenodd" d="M0 0"/></svg>';
  assert.equal(dedupeSvgRootAttributes(clean), clean);
  assert.equal(dedupeSvgRootAttributes('not an svg'), 'not an svg');
  var kids = '<svg fill="currentColor" xmlns="x"><path fill="#111" fill="#222"/></svg>';
  assert.equal(dedupeSvgRootAttributes(kids), kids); // only the root tag is repaired
});

test('quotes and case: single-quoted and upper-case duplicates are caught', () => {
  assert.equal(dedupeSvgRootAttributes("<svg fill='a' FILL='b' xmlns='x'></svg>"), "<svg fill='a' xmlns='x'></svg>");
});

test('normalizeSvgIconBuffer returns the same buffer when nothing changes', () => {
  var b = Buffer.from('<svg xmlns="x"></svg>');
  assert.equal(normalizeSvgIconBuffer(b), b);
  assert.equal(normalizeSvgIconBuffer(Buffer.from(BROKEN)).toString().includes('#0061D5'), false);
});
