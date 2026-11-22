// Faster drop-in for makefun-site 1.0.0: own implementation, same answers.
// Optimisations: per-build slug cache + ASCII fast path, hand-rolled HTML
// escaping (no per-char regex), direct Markdown rendering without token
// objects, manual front-matter scanning, array-joined template rendering.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const INCLUDE_DEPTH = 8;
const SLUG_MAX = 64;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = Object.hasOwn;

/* ---------------- text ---------------- */

function escapeHtml(text) {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ent = null;
    if (c === 38) ent = '&amp;';
    else if (c === 60) ent = '&lt;';
    else if (c === 62) ent = '&gt;';
    else if (c === 34) ent = '&quot;';
    else if (c === 39) ent = '&#39;';
    if (ent !== null) {
      out += text.slice(start, i) + ent;
      start = i + 1;
    }
  }
  return start === 0 ? text : out + text.slice(start);
}

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function wordsOf(text) {
  let n = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // whitespace: space \t \n \v \f \r plus the wider Unicode spaces
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// Per-build slug cache; created fresh inside run().
let slugCache = null;

function slugify(text) {
  const cached = slugCache.get(text);
  if (cached !== undefined) return cached;
  let out;
  // ASCII fast path: NFKD is identity and there are no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  if (ascii) {
    let s = '', gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = 0;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === 0) { if (s.length > 0) gap = true; continue; }
      if (gap) s += '-';
      gap = false;
      s += String.fromCharCode(keep);
    }
    out = s.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
    if (out === '') out = 'untitled';
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let s = '', gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = s.length > 0; continue; }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    s = s.slice(0, SLUG_MAX).replace(/-+$/, '');
    out = s === '' ? 'untitled' : s;
  }
  slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  // date is YYYY-MM-DD (validated upstream).
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/* ---------------- front matter ---------------- */

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // [
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function parseFrontMatter(text) {
  // First line must be exactly '---'.
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing '---' line.
  let pos = nl === -1 ? text.length : nl + 1;
  let close = -1, closeEnd = -1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') { close = pos; closeEnd = e === -1 ? text.length : e + 1; break; }
    if (e === -1) break;
    pos = e + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Lines between, numbered from 1 at the opening '---'.
  let lineNo = 1;
  pos = nl === -1 ? text.length : nl + 1;
  while (pos < close) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos, close) : text.slice(pos, e);
    lineNo++;
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) { // not blank, not '#'
      // LINE: /^([a-z_]+):(?: (.*))?$/
      let k = 0;
      while (k < line.length) { const c = line.charCodeAt(k); if ((c >= 97 && c <= 122) || c === 95) k++; else break; }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      // trailing spaces/tabs dropped
      let r = raw.length;
      while (r > 0 && (raw.charCodeAt(r - 1) === 32 || raw.charCodeAt(r - 1) === 9)) r--;
      raw = raw.slice(0, r);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (e === -1) break;
    pos = e + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

/* ---------------- Markdown ---------------- */

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  for (let k = j; k < line.length; k++) { const c = line.charCodeAt(k); if (c !== 32 && c !== 9) return null; }
  return line.slice(3, j);
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) { const c = line.charCodeAt(k); if (c !== 32 && c !== 9) return false; }
  return true;
}

// Returns {depth, text} or null. HEADING: /^(#{1,6})[ \t]+(.*?)[ \t]*$/
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35 && h < 6) h++;
  if (h === 0 || h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let a = h;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  if (a >= line.length) return null;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  const text = line.slice(a, b);
  if (text === '') return null;
  return { depth: h, text };
}

function isHR(line) {
  let b = line.length;
  while (b > 0 && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  const t = line.slice(0, b);
  return t === '---' || t === '***';
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

// CONTINUED: /^ {2,}\S/ — two or more spaces, then a non-whitespace char.
function continuedLine(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isSpaceCode(line.charCodeAt(j));
}

function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const code = s.charCodeAt(j);
    if (code === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (code !== 42) continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function inline(s, env, out) {
  let i = 0, start = 0;
  const n = s.length;
  while (i < n) {
    const code = s.charCodeAt(i);
    if (code === 92 && i + 1 < n && ESCAPABLE.has(s[i + 1])) { // backslash escape
      if (i > start) out.push(s.slice(start, i));
      const d = s[i + 1];
      out.push(d === '&' ? '&amp;' : d === '<' ? '&lt;' : d === '>' ? '&gt;' : d === '"' ? '&quot;' : d === "'" ? '&#39;' : d);
      i += 2; start = i;
      continue;
    }
    if (code === 96) { // ` code span
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1; start = i;
      } else i++;
      continue;
    }
    if (code === 42) { // * strong / emphasis
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<strong>'); inline(s.slice(i + 2, j), env, out); out.push('</strong>');
          i = j + 2; start = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<em>'); inline(s.slice(i + 1, j), env, out); out.push('</em>');
        i = j + 1; start = i;
      } else i++;
      continue;
    }
    if (code === 91) { // [ link
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inline(s.slice(i + 1, k), env, out);
        out.push('</a>');
        i = m + 1; start = i;
        continue;
      }
      i++;
      continue;
    }
    if (code === 38 || code === 60 || code === 62 || code === 34 || code === 39) {
      if (i > start) out.push(s.slice(start, i));
      out.push(code === 38 ? '&amp;' : code === 60 ? '&lt;' : code === 62 ? '&gt;' : code === 34 ? '&quot;' : '&#39;');
      i++; start = i;
      continue;
    }
    i++;
  }
  if (n > start) out.push(s.slice(start, n));
}

function inlineStr(s, env) {
  const out = [];
  inline(s, env, out);
  return out.join('');
}

function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      const parts = [];
      while (i < L && !fenceClose(lines[i])) { parts.push(escapeHtml(lines[i]), '\n'); i++; }
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${parts.join('')}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    // List?
    let ordered = false, startNum = 1, itemText = null;
    if ((line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32) {
      itemText = line.slice(2);
    } else {
      // ORDERED: /^(\d{1,9})\. (.*)$/
      let d = 0;
      while (d < line.length && d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d > 0 && d < line.length && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true; startNum = Number(line.slice(0, d)); itemText = line.slice(d + 2);
      }
    }
    if (itemText !== null) {
      const items = [[trimLine(itemText)]];
      i++;
      while (i < L) {
        const l = lines[i];
        let mText = null, mOrd = false, mStart = 1;
        if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          if (!ordered) mText = l.slice(2);
        } else {
          let d = 0;
          while (d < l.length && d < 9 && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d > 0 && d < l.length && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32 && ordered) { mOrd = true; mStart = Number(l.slice(0, d)); mText = l.slice(d + 2); }
        }
        if (mText !== null) { items.push([trimLine(mText)]); i++; }
        else if (continuedLine(l)) {
          items[items.length - 1].push(trimLine(l)); i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const it of items) parts.push('<li>', inlineStr(it.join('\n'), env), '</li>\n');
      parts.push(`</${tag}>\n`);
      blocks.push(parts.join(''));
      continue;
    }
    // Paragraph
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

/* ---------------- Templates ---------------- */

class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) { const c = src.charCodeAt(k); if (c !== 32 && c !== 9) { standalone = false; break; } }
    if (standalone) for (let k = end; k < lineEnd; k++) { const c = src.charCodeAt(k); if (c !== 32 && c !== 9) { standalone = false; break; } }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOfStr(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) { if (i > 0) s += ', '; s += textOfStr(v[i]); }
    return s;
  }
  return '';
}

function textOf(v, out) {
  if (typeof v === 'string') { out.push(v); return; }
  if (typeof v === 'number') { out.push(String(v)); return; }
  if (typeof v === 'boolean') { out.push(v ? 'true' : 'false'); return; }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { if (i > 0) out.push(', '); textOf(v[i], out); }
  }
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') { out.push(n.text); continue; }
    if (n.kind === 'var') { out.push(escapeHtml(textOfStr(lookup(scope, n.path)))); continue; }
    if (n.kind === 'raw') { textOf(lookup(scope, n.path), out); continue; }
    if (n.kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
      continue;
    }
    if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
        renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
      }
      continue;
    }
    // include
    const t = ctx.templates.get(n.name);
    if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
  }
}

/* ---------------- build ---------------- */

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of tNames) {
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  let sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }
  // front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) { if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; } }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  sources = kept;
  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  // collections
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const outArr = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); outArr.push(name); }
    }
    return outArr;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  // cards (cached per source; pageOf reuses the same card object)
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, c);
    return c;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) {
    const card = cardOf(s);
    const page = { ...card, slug: s.slug, content: s.html, toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })), newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  // report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
