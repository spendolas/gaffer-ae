// Brand icons reach the panel as data: URLs and are drawn as image masks, so
// they must be well-formed XML. The simple-icons CDN text gets an extra
// fill="currentColor" prepended to its root tag, which already carries a
// fill: duplicate attributes are fine as inline HTML (the first wins) but an
// SVG used as an image fails to decode, and the icon disappears.
//
// Keep the FIRST occurrence of each attribute on the root <svg> tag, which is
// exactly what the HTML parser did, so the icon looks the same as before.

// The text comes from a remote server, and the attribute scan below is
// quadratic on a long run of spaces (60 KB of them took about 5 s), so an
// oversized root tag is left alone: such an icon simply fails to load.
export var MAX_ROOT_ATTRS = 2048;
export var MAX_ICON_BYTES = 64 * 1024; // the panel refuses anything larger anyway

export function dedupeSvgRootAttributes(svgText) {
  var text = String(svgText);
  var m = /<svg\b([^>]*)>/i.exec(text);
  if (!m) return text;
  var attrs = m[1];
  if (attrs.length > MAX_ROOT_ATTRS) return text;
  var seen = Object.create(null);
  var out = attrs.replace(/\s+([^\s=\/>"']+)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g, function (all, name) {
    var key = name.toLowerCase();
    if (seen[key]) return '';
    seen[key] = true;
    return all;
  });
  if (out === attrs) return text;
  return text.slice(0, m.index) + '<svg' + out + '>' + text.slice(m.index + m[0].length);
}

export function normalizeSvgIconBuffer(buf) {
  if (buf.length > MAX_ICON_BYTES) return buf;
  var text = buf.toString('utf8');
  var fixed = dedupeSvgRootAttributes(text);
  return fixed === text ? buf : Buffer.from(fixed, 'utf8');
}
