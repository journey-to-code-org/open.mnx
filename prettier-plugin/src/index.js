// prettier-plugin-zubra: Prettier for .zb components.
//
// The template is laid out by `zubra fmt` (the compiler's formatter), at the same line width: the
// plugin's default `printWidth` for `.zb` files is `zubra fmt`'s 100, not Prettier's 80, so a file
// Prettier has formatted passes `zubra fmt --check`. Set `printWidth` yourself and it applies to
// both the template and the bodies; give `zubra fmt` the same `--width`. The bodies of the component's <script> and <style> are Prettier's:
// JavaScript or TypeScript (`lang="ts"`), CSS, SCSS and Less, with your Prettier configuration,
// indented one level inside their tag. A body that doesn't parse is left as written, and so is one
// in a language Prettier has no parser for. `embeddedLanguageFormatting: "off"` leaves every body
// as written.
//
// How: each top-level body is swapped for a placeholder, `zubra fmt` lays out the rest, and each
// placeholder is replaced by the body's Prettier doc (`embed`), so the bodies are formatted with
// the Prettier already running, and template literals inside them are never re-indented.
import { format as zubraFormat } from '@zubra/compiler';
import { doc } from 'prettier';

const { hardline, indent, join, literalline } = doc.builders;

export const languages = [
  {
    name: 'Zubra',
    parsers: ['zubra'],
    extensions: ['.zb'],
    vscodeLanguageIds: ['zubra'],
  },
];

const PLACEHOLDER = (index) => `__ZUBRA_BODY_${index}__`;
const IGNORED = /^[\ufeff\s]*<!--\s*zubra-fmt-ignore\s*-->/;

/** `zubra fmt`'s line width, so the two agree at their defaults. */
export const PRINT_WIDTH = 100;

/** The parser Prettier should use for a body, or null to leave it as written. */
export function parserFor(tag, attributes) {
  const attribute = (name) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes);
  const value = (name) => {
    const match = attribute(name);
    return (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
  };
  const lang = value('lang');
  if (tag === 'script') {
    const type = value('type');
    if (type === 'application/json' || type === 'importmap' || type === 'application/ld+json') return 'json';
    if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) return null;
    if (lang === 'ts' || lang === 'typescript' || lang === 'tsx') return 'typescript';
    if (!lang || lang === 'js' || lang === 'javascript' || lang === 'jsx') return 'babel';
    return null;
  }
  if (!lang || lang === 'css') return 'css';
  if (lang === 'scss') return 'scss';
  if (lang === 'less') return 'less';
  return null;
}

/**
 * The top-level <script> and <style> blocks, before the host tag: where their bodies are, and the
 * parser for each. (Anything after the host tag is template, which `zubra fmt` keeps as written.)
 */
export function bodies(text) {
  const found = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) break;
      at += end + 3;
      continue;
    }
    const open = /^<(script|style)(\s[^>]*)?>/i.exec(rest);
    if (open) {
      const tag = open[1].toLowerCase();
      const bodyStart = at + open[0].length;
      const close = text.toLowerCase().indexOf(`</${tag}`, bodyStart);
      if (close < 0) break;
      found.push({ tag, start: bodyStart, end: close, parser: parserFor(tag, open[2] ?? '') });
      at = close;
      continue;
    }
    if (rest.startsWith('<') && /^<[a-z]/i.test(rest)) break; // the host tag: the template
    at += 1;
  }
  return found;
}

export const parsers = {
  zubra: {
    astFormat: 'zubra',
    locStart: () => 0,
    locEnd: (node) => node.text?.length ?? 0,
    parse(text, options) {
      const source = text.replace(/\r\n?/g, '\n');
      // A file that opts out of `zubra fmt` (its first content is `<!-- zubra-fmt-ignore -->`) is
      // left as written, bodies included.
      if (IGNORED.test(source)) return { type: 'root', text: source, children: [{ type: 'markup', text: source }] };
      // Swap each body Prettier will format for a placeholder, so `zubra fmt` can lay out the rest.
      const formatting = options.embeddedLanguageFormatting !== 'off';
      const blocks = formatting ? bodies(source).filter((block) => block.parser && source.slice(block.start, block.end).trim()) : [];
      let masked = '';
      let from = 0;
      blocks.forEach((block, index) => {
        masked += source.slice(from, block.start) + PLACEHOLDER(index);
        from = block.end;
      });
      masked += source.slice(from);
      let laidOut;
      try {
        laidOut = zubraFormat(masked, {
          indentWidth: options.tabWidth,
          useTabs: options.useTabs,
          printWidth: options.printWidth,
        });
      } catch (error) {
        // The compiler's error: the file doesn't parse.
        throw Object.assign(new SyntaxError(error.message), { loc: error.line ? { start: { line: error.line, column: error.column ?? 1 } } : undefined });
      }
      // The placeholders' places in the result.
      const children = [];
      let cursor = 0;
      blocks.forEach((block, index) => {
        const marker = PLACEHOLDER(index);
        const at = laidOut.indexOf(marker, cursor);
        children.push({ type: 'markup', text: laidOut.slice(cursor, at) });
        children.push({ type: 'body', parser: block.parser, source: source.slice(block.start, block.end) });
        cursor = at + marker.length;
      });
      children.push({ type: 'markup', text: laidOut.slice(cursor) });
      return { type: 'root', text: laidOut, children };
    },
  },
};

const lines = (text) => join(literalline, text.split('\n'));

export const printers = {
  zubra: {
    print(path, options, print) {
      const node = path.node;
      switch (node.type) {
        case 'root':
          return path.map(print, 'children');
        case 'markup':
          return lines(node.text);
        default:
          // A body Prettier couldn't format (it didn't parse): as it was written.
          return lines(node.source);
      }
    },
    embed(path) {
      const node = path.node;
      if (node.type !== 'body') return undefined;
      return async (textToDoc) => {
        const formatted = await textToDoc(node.source, { parser: node.parser });
        return [indent([hardline, formatted]), hardline];
      };
    },
  },
};

export const options = {};
export const defaultOptions = { printWidth: PRINT_WIDTH };
export default { languages, parsers, printers, options, defaultOptions };
