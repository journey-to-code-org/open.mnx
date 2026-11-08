// A small syntax highlighter for the playground: a .zb file (HTML with <script> and <style>, and
// {expressions} in the markup), plain JavaScript (the compiled module, typings, the manifest) and
// CSS. It returns HTML spans classed tok-c (comment), tok-s (string), tok-k (keyword), tok-n
// (number), tok-t (tag), tok-a (attribute) and tok-p (CSS property). No dependencies, no network:
// the playground is a static page.
const escape = (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const span = (kind, text) => `<span class="tok-${kind}">${escape(text)}</span>`;

const KEYWORDS = 'let|const|var|function|async|await|return|if|else|for|while|do|switch|case|break|continue|import|from|export|default|new|true|false|null|undefined|class|extends|try|catch|finally|throw|of|in|typeof|instanceof|void|declare|type|interface|as';
const JS = new RegExp(`(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))|("(?:[^"\\\\\\n]|\\\\.)*"?|'(?:[^'\\\\\\n]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\.)*\`?)|(\\b(?:${KEYWORDS})\\b)|(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)`, 'g');
const CSS = /(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(@[\w-]+)|([\w-]+(?=\s*:(?!:)))|(#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|s|ms|vh|vw|fr|deg)?\b)/g;

function scan(text, pattern, kinds) {
  let out = '';
  let last = 0;
  pattern.lastIndex = 0;
  for (let match; (match = pattern.exec(text)); ) {
    if (!match[0]) { pattern.lastIndex++; continue; }
    out += escape(text.slice(last, match.index));
    out += span(kinds[match.findIndex((group, at) => at > 0 && group !== undefined) - 1], match[0]);
    last = match.index + match[0].length;
  }
  return out + escape(text.slice(last));
}

export const js = (text) => scan(text, JS, ['c', 's', 'k', 'n']);
export const css = (text) => scan(text, CSS, ['c', 's', 'k', 'p', 'n']);

/** The end of a {…} that starts at `at`, skipping strings, so braces inside them don't count. */
function closing(text, at) {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'" || char === '`') {
      for (i++; i < text.length && text[i] !== char; i++) if (text[i] === '\\') i++;
    } else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}

const expression = (text, at) => {
  const end = closing(text, at);
  return [`{${js(text.slice(at + 1, text[end - 1] === '}' ? end - 1 : end))}${text[end - 1] === '}' ? '}' : ''}`, end];
};

/** HTML as .zb is written: comments, tags and attributes, {expressions}, and <script> and <style> bodies. */
export function markup(text) {
  const tag = /<\/?[A-Za-z][\w:.-]*/y;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      const stop = end < 0 ? text.length : end + 3;
      out += span('c', text.slice(i, stop));
      i = stop;
    } else if (text[i] === '{') {
      const [html, end] = expression(text, i);
      out += html;
      i = end;
    } else if (text[i] === '<' && (tag.lastIndex = i, tag.test(text))) {
      const name = text.slice(i, tag.lastIndex);
      out += `${escape(name[1] === '/' ? '</' : '<')}${span('t', name.replace(/^<\/?/, ''))}`;
      i = tag.lastIndex;
      // Attributes up to the tag's end.
      while (i < text.length && text[i] !== '>') {
        const rest = text.slice(i);
        let m;
        if (text[i] === '{') { const [html, end] = expression(text, i); out += html; i = end; }
        else if ((m = /^(?:"[^"]*"?|'[^']*'?)/.exec(rest))) { out += span('s', m[0]); i += m[0].length; }
        else if ((m = /^[^\s=>/{"']+/.exec(rest))) { out += span('a', m[0]); i += m[0].length; }
        else { out += escape(text[i]); i++; }
      }
      if (i < text.length) { out += '&gt;'; i++; }
      const raw = /^<(script|style)$/i.exec(name)?.[1].toLowerCase();
      if (raw) {
        const end = text.toLowerCase().indexOf(`</${raw}`, i);
        const stop = end < 0 ? text.length : end;
        out += (raw === 'script' ? js : css)(text.slice(i, stop));
        i = stop;
      }
    } else {
      let stop = i + 1;
      while (stop < text.length && text[stop] !== '<' && text[stop] !== '{') stop++;
      out += escape(text.slice(i, stop));
      i = stop;
    }
  }
  return out;
}

export const highlight = (text, language) => ({ zb: markup, html: markup, js, css })[language]?.(text) ?? escape(text);
