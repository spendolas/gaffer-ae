/*
 * SafeMarkdown: renders chat markdown to HTML that is safe to assign to
 * innerHTML. Text from the model, from project files and from saved chat
 * history is treated as data, never as markup.
 *
 * Two independent layers:
 *   1. A marked instance whose renderer never emits raw HTML (every html token,
 *      block or inline, becomes escaped text) and builds links/images/code
 *      itself with checked URLs.
 *   2. A strict filter over the finished HTML (sanitizeHtml): only a fixed set
 *      of elements and attributes survive, URLs are re-checked, anything that
 *      does not parse as a well-formed allowed tag is turned into visible text.
 *
 * sanitizeHtml is also used for HTML the panel stores itself (reply quotes).
 *
 * Browser: window.SafeMarkdown (needs the global `marked` loaded first).
 * Tests / Node: module.exports (loads ./marked.min.js).
 * ES5 on purpose, like the rest of the panel.
 */
(function (root, factory) {
  var markedLib = (root && root.marked) || null;
  if (!markedLib && typeof require === 'function') {
    try { markedLib = require('./marked.min.js'); } catch (e) { markedLib = null; }
  }
  var api = factory(markedLib);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SafeMarkdown = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function (markedLib) {
  'use strict';

  // ---- escaping ----
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // marked has already escaped alt/title text; only make sure nothing can end
  // the attribute or open a tag.
  function attrText(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- URL policy ----
  var DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+\/=]+$/;
  var SVG_ICON_RE = /^data:image\/svg\+xml;base64,[A-Za-z0-9+\/=]+$/;
  var SVG_ICON_MAX = 64 * 1024;
  var HTTP_RE = /^https?:\/\/[^\/?#\s%]/i;
  var MAILTO_RE = /^mailto:[^\s]+$/i;
  var MAX_URL = 8192;

  // Returns the URL to put in an attribute (not yet entity-escaped), or null
  // when the destination is not allowed. Anything that is not literally
  // http(s), mailto (links only) or a base64 raster image (images only) is
  // refused: javascript:, vbscript:, file:, protocol-relative, relative paths,
  // entity- or control-character-obfuscated schemes (those never match the
  // literal prefix after encoding).
  function cleanUrl(raw, isImage) {
    if (typeof raw !== 'string') return null;
    var u = raw.trim();
    if (!u) return null;
    if (isImage && DATA_IMAGE_RE.test(u)) return u;
    if (u.length > MAX_URL) return null;
    try { u = encodeURI(u).replace(/%25/g, '%'); } catch (e) { return null; }
    if (HTTP_RE.test(u)) return u;
    if (!isImage && MAILTO_RE.test(u)) return u;
    return null;
  }

  function isSafeImageDataUrl(s) {
    return typeof s === 'string' && DATA_IMAGE_RE.test(s);
  }

  // Remote (MCP server supplied) tile icons. Shown through an image mask, never
  // as inline markup. Must be a small base64 svg data URL.
  function safeSvgIconDataUrl(s) {
    if (typeof s !== 'string' || s.length > SVG_ICON_MAX) return null;
    return SVG_ICON_RE.test(s) ? s : null;
  }

  // The only URLs the click handler may hand to the system browser.
  var OPENABLE_RE = /^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/i;
  function externalUrlToOpen(u) {
    return (typeof u === 'string' && OPENABLE_RE.test(u)) ? u : null;
  }

  // ---- layer 1: marked ----
  var marker = null;
  function getMarked() {
    if (marker || !markedLib) return marker;
    var Ctor = markedLib.Marked;
    if (!Ctor) return null;
    marker = new Ctor({
      gfm: true,
      breaks: false,
      renderer: {
        // Raw HTML from the model is shown as text, never parsed.
        html: function (html, block) {
          var t = esc(html);
          return block ? '<p>' + t.replace(/\s+$/, '') + '</p>\n' : t;
        },
        link: function (href, title, text) {
          var u = cleanUrl(href, false);
          if (u === null) return text;
          var out = '<a href="' + esc(u) + '"';
          if (title) out += ' title="' + attrText(title) + '"';
          return out + ' rel="noopener noreferrer">' + text + '</a>';
        },
        image: function (href, title, text) {
          var u = cleanUrl(href, true);
          if (u === null) return text;
          var out = '<img src="' + esc(u) + '" alt="' + attrText(text) + '"';
          if (title) out += ' title="' + attrText(title) + '"';
          return out + '>';
        },
        code: function (code, infostring) {
          var lang = ((infostring || '').match(/^\S*/) || [''])[0];
          var body = esc(String(code).replace(/\n$/, '') + '\n');
          if (!/^[A-Za-z0-9_+#.\-]{1,32}$/.test(lang)) return '<pre><code>' + body + '</code></pre>\n';
          return '<pre><code class="language-' + lang + '">' + body + '</code></pre>\n';
        },
      },
    });
    return marker;
  }

  function prepare(text) {
    // Normalize whitespace: collapse 3+ newlines, strip blanks between list
    // items so marked produces tight lists (no <p> inside <li>).
    return String(text)
      .replace(/(\n[ \t]*){3,}/g, '\n\n')
      .replace(/^(\s*[-*+]\s+.*)\n\s*\n(?=\s*[-*+]\s)/gm, '$1\n')
      .replace(/^(\s*\d+\.\s+.*)\n\s*\n(?=\s*\d+\.\s)/gm, '$1\n')
      .trim();
  }

  // Marked output with the renderer-level protections only (tests exercise this
  // separately from the filter).
  function renderUnfiltered(text) {
    if (text == null) return '';
    var m = getMarked();
    if (!m) return esc(text);
    var html = m.parse(prepare(text));
    // GFM task-list items ship as <li><input type=checkbox> with no class.
    // Tag them so CSS can drop the redundant bullet: CEP Ch99 predates :has(),
    // so the checkbox child cannot be detected in the stylesheet alone.
    return html.replace(/<li>(\s*<input\b[^>]*type="checkbox")/g, '<li class="task-item">$1');
  }

  // ---- layer 2: allowlist filter over finished HTML ----
  var ALLOWED_TAGS = {
    p: 1, br: 1, strong: 1, em: 1, del: 1, code: 1, pre: 1, blockquote: 1,
    ul: 1, ol: 1, li: 1, a: 1, img: 1, table: 1, thead: 1, tbody: 1, tr: 1, th: 1, td: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, hr: 1, input: 1, span: 1, div: 1,
  };
  var VOID_TAGS = { br: 1, hr: 1, img: 1, input: 1 };
  var TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9\-]*(?:="[^"<>]*")?)*)\s*\/?>/y;
  var ATTR_RE = /\s+([a-zA-Z][a-zA-Z0-9\-]*)(?:="([^"<>]*)")?/g;

  // An attribute value is what the browser sees after one round of entity
  // decoding. Only &amp; is decoded here; any other entity in a URL attribute
  // means the value is not trusted (returns null).
  function plainUrlValue(v) {
    if (/&(?!amp;)/.test(v)) return null;
    return v.replace(/&amp;/g, '&');
  }

  function rebuildTag(tag, rawAttrs) {
    var attrs = {};
    var seen = {};
    var m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(rawAttrs))) {
      var name = m[1].toLowerCase();
      if (seen[name]) continue; // browsers keep the first one
      seen[name] = true;
      attrs[name] = m[2] === undefined ? '' : m[2];
    }
    var out = '<' + tag;
    if (tag === 'a') {
      if (attrs.href !== undefined) {
        var hv = plainUrlValue(attrs.href);
        var hu = hv === null ? null : cleanUrl(hv, false);
        if (hu !== null) out += ' href="' + esc(hu) + '"';
      }
      if (attrs.title !== undefined) out += ' title="' + attrText(attrs.title) + '"';
      out += ' rel="noopener noreferrer"';
    } else if (tag === 'img') {
      var sv = attrs.src === undefined ? null : plainUrlValue(attrs.src);
      var su = sv === null ? null : cleanUrl(sv, true);
      if (su === null) return null; // an image with no allowed source is dropped
      out += ' src="' + esc(su) + '"';
      if (attrs.alt !== undefined) out += ' alt="' + attrText(attrs.alt) + '"';
      if (attrs.title !== undefined) out += ' title="' + attrText(attrs.title) + '"';
    } else if (tag === 'input') {
      if (attrs.type !== 'checkbox') return null;
      if (attrs.checked !== undefined) out += ' checked=""';
      if (attrs.disabled !== undefined) out += ' disabled=""';
      out += ' type="checkbox"';
    } else if (tag === 'li') {
      if (attrs['class'] === 'task-item') out += ' class="task-item"';
    } else if (tag === 'code') {
      if (/^language-[A-Za-z0-9_+#.\-]{1,32}$/.test(attrs['class'] || '')) out += ' class="' + attrs['class'] + '"';
    } else if (tag === 'ol') {
      if (/^[0-9]{1,6}$/.test(attrs.start || '')) out += ' start="' + attrs.start + '"';
    } else if (tag === 'th' || tag === 'td') {
      if (/^(?:left|right|center)$/.test(attrs.align || '')) out += ' align="' + attrs.align + '"';
    }
    return out + '>';
  }

  function sanitizeHtml(input) {
    if (typeof input !== 'string') return '';
    var out = '';
    var i = 0;
    var n = input.length;
    while (i < n) {
      var lt = input.indexOf('<', i);
      if (lt === -1) { out += input.slice(i); break; }
      out += input.slice(i, lt);
      TAG_RE.lastIndex = lt;
      var m = TAG_RE.exec(input);
      var tag = m ? m[2].toLowerCase() : '';
      if (!m || !ALLOWED_TAGS[tag]) { out += '&lt;'; i = lt + 1; continue; }
      if (m[1]) {
        // closing tag: never carries attributes; void elements have none
        if (m[3].replace(/\s+/g, '') !== '') { out += '&lt;'; i = lt + 1; continue; }
        if (!VOID_TAGS[tag]) out += '</' + tag + '>';
      } else {
        var rebuilt = rebuildTag(tag, m[3]);
        if (rebuilt === null) { out += '&lt;'; i = lt + 1; continue; }
        out += rebuilt;
      }
      i = lt + m[0].length;
    }
    return out;
  }

  function render(text) {
    if (text == null) return '';
    try {
      return sanitizeHtml(renderUnfiltered(text));
    } catch (e) {
      return esc(text);
    }
  }

  // ---- click handling ----
  // One delegated handler. Chat content is untrusted, so a click on a link must
  // never navigate the panel frame (which has Node access): it is always
  // cancelled, and only http(s) destinations are handed to the system browser.
  function attachLinkHandler(rootEl, open) {
    function onClick(e) {
      var t = e && e.target;
      var a = t && typeof t.closest === 'function' ? t.closest('a[href]') : null;
      if (!a) return;
      e.preventDefault();
      var u = externalUrlToOpen(a.getAttribute('href'));
      if (u && typeof open === 'function') open(u);
    }
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('auxclick', onClick);
  }

  return {
    render: render,
    renderUnfiltered: renderUnfiltered,
    sanitizeHtml: sanitizeHtml,
    escapeHtml: esc,
    cleanUrl: cleanUrl,
    isSafeImageDataUrl: isSafeImageDataUrl,
    safeSvgIconDataUrl: safeSvgIconDataUrl,
    externalUrlToOpen: externalUrlToOpen,
    attachLinkHandler: attachLinkHandler,
  };
});
