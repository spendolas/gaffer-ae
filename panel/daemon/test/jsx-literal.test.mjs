import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsStr, jsNum, jsJson } from '../tools/jsx-literal.js';

// The literal must mean exactly the text that went in when a script engine
// reads it back, and must never contain a raw line terminator.
var LINE_TERMINATORS = /[\n\r\u2028\u2029]/;

var SAMPLES = [
  '',
  'plain',
  'He said "hi"',
  "it's",
  'back\\slash',
  'C:\\Users\\me\\x.png',
  'a\nb',
  'a\rb',
  'a\r\nb',
  'a\u2028b',
  'a\u2029b',
  'nul\u0000byte',
  'tab\there',
  '*/ x /*',
  '// not a comment',
  '${not a template}',
  '`tick`',
  '");system.callSystem("x");//',
  '\ud83d\ude00 emoji',
  '\ud800 lone surrogate',
  '{"already":"json"}',
  'x'.repeat(100000),
];

test('jsStr: output is one double-quoted literal with no raw line terminator', () => {
  SAMPLES.forEach(function (s) {
    var lit = jsStr(s);
    assert.ok(lit.startsWith('"') && lit.endsWith('"'), 'quoted: ' + JSON.stringify(s).slice(0, 40));
    assert.ok(!LINE_TERMINATORS.test(lit), 'no raw line terminator for ' + JSON.stringify(s).slice(0, 40));
  });
});

test('jsStr: evaluating the literal gives back the original text', () => {
  SAMPLES.forEach(function (s) {
    // eslint-disable-next-line no-new-func
    var back = new Function('return ' + jsStr(s) + ';')();
    // A lone surrogate is written as an escape and comes back unchanged.
    assert.equal(back, s);
  });
});

test('jsStr: U+2028 and U+2029 are written as escapes', () => {
  assert.equal(jsStr('a\u2028b'), '"a\\u2028b"');
  assert.equal(jsStr('a\u2029b'), '"a\\u2029b"');
});

test('jsStr: output stays within ES3 string literal syntax', () => {
  // ES3 allows \b \t \n \v \f \r \" \' \\ \xHH \uHHHH. JSON only ever emits a subset of those.
  SAMPLES.forEach(function (s) {
    var lit = jsStr(s);
    lit.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, function (all, esc) {
      assert.ok(/^(u[0-9a-fA-F]{4}|[bfnrt"\\])$/.test(esc), 'unexpected escape ' + all + ' in ' + lit.slice(0, 60));
      return all;
    });
  });
});

test('jsStr: matches JSON.stringify for ordinary text', () => {
  ['plain', 'with "quotes"', 'C:\\x', 'a\nb', 'tab\t'].forEach(function (s) {
    assert.equal(jsStr(s), JSON.stringify(s));
  });
});

test('jsStr: non-string values become text, never code', () => {
  assert.equal(jsStr(42), '"42"');
  assert.equal(jsStr(null), '"null"');
  assert.equal(jsStr(undefined), '"undefined"');
  assert.equal(jsStr({ toString: function () { return '");x("'; } }), '"\\");x(\\""');
});

test('jsNum: finite numbers become number literals', () => {
  assert.equal(jsNum(0), '0');
  assert.equal(jsNum(-0), '0');
  assert.equal(jsNum(12), '12');
  assert.equal(jsNum(-3.5), '-3.5');
  assert.equal(jsNum(1e21), '1e+21');
  assert.equal(jsNum(1e-7), '1e-7');
});

test('jsNum: rejects anything that is not a finite number', () => {
  [NaN, Infinity, -Infinity, '1', '1;x()', null, undefined, {}, [], true, 10n].forEach(function (v) {
    assert.throws(function () { jsNum(v); }, TypeError, 'rejects ' + String(typeof v === 'bigint' ? v + 'n' : v));
  });
});

test('jsJson: structured data stays on one line and reads back unchanged', () => {
  var value = { a: ['x\u2028y', 'p\u2029q', 'line\nbreak', '");f();//'], n: 1.5, t: true, z: null };
  var lit = jsJson(value);
  assert.ok(!LINE_TERMINATORS.test(lit));
  assert.deepEqual(new Function('return ' + lit + ';')(), value);
  assert.equal(jsJson(undefined), 'null');
  assert.equal(jsJson([1, 'a']), '[1,"a"]');
});
