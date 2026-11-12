/**
 * jsx-literal.js - the one way the daemon writes a value into a generated
 * ExtendScript source.
 *
 * Rule: a value coming from a tool argument, a Figma layer or any other data
 * is only ever written into a script as a literal made here. Never concatenate
 * it, never put it in a comment.
 *
 *   jsStr(s)  a double-quoted string literal. Output is plain ASCII-safe
 *             JSON string syntax with every line terminator written as an
 *             escape (backslash-n, backslash-r, and the two Unicode line and
 *             paragraph separators), so the literal always stays on
 *             one line and means exactly the text that went in, whichever line
 *             terminator rules the script engine uses.
 *   jsJson(v) a JSON value (array, object, string, number, null) written the
 *             same way, for data that is already structured.
 *   jsNum(n)  a number literal. Anything that is not a finite number throws, so
 *             NaN, Infinity, strings and objects never reach a script.
 *
 * Output is ES3-safe (JSON string and number syntax only).
 */

export function jsStr(s) {
  return JSON.stringify(String(s))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function jsNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError('Expected a finite number, got ' + (typeof n === 'number' ? String(n) : typeof n));
  }
  return String(n);
}

export function jsJson(v) {
  var text = JSON.stringify(v);
  if (text === undefined) text = 'null';
  return text.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
