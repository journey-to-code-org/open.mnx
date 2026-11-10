// Keeps the "Zubra for … developers" pages honest: a code block on a page that says where it
// comes from (`<!-- snippet: examples/frameworks/vue-budget/src/App.vue#stepper -->`) must equal
// the marked region of that file, a file that CI builds and runs. The same module checks that a
// page's links resolve and that it has the sections every framework page has.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MARK = /zubra-snippet:(start|end)\s+([\w-]+)/;

/** Remove the indentation every non-blank line shares, and the blank lines at both ends. */
export function dedent(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length));
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0).replace(/\s+$/, '')).join('\n');
}

/** The marked regions of a source file: `name` → its lines, dedented. Markers may sit in any comment. */
export function regions(source, file = 'file') {
  const found = new Map();
  let open = null;
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const mark = line.match(MARK);
    if (mark) {
      const [, kind, name] = mark;
      if (kind === 'start') {
        if (open) throw new Error(`${file}: snippet "${open.name}" is still open at the start of "${name}"`);
        if (found.has(name)) throw new Error(`${file}: snippet "${name}" is defined twice`);
        open = { name, lines: [] };
      } else {
        if (!open || open.name !== name) throw new Error(`${file}: snippet end "${name}" without its start`);
        found.set(name, dedent(open.lines.join('\n')));
        open = null;
      }
    } else if (open) {
      open.lines.push(line);
    }
  }
  if (open) throw new Error(`${file}: snippet "${open.name}" is never closed`);
  return found;
}

/** The code blocks in a page that name their source: `{ path, name, code }`. */
export function pageSnippets(markdown) {
  const out = [];
  const pattern = /<!--\s*snippet:\s*([^\s#]+)#([\w-]+)\s*-->\s*\n```[^\n]*\n([\s\S]*?)\n```/g;
  for (const match of markdown.replace(/\r\n/g, '\n').matchAll(pattern)) {
    out.push({ path: match[1], name: match[2], code: dedent(match[3]) });
  }
  return out;
}

/** The problems with a page's snippets, as strings: a missing file, region, or a block that differs. */
export function snippetProblems(markdown, root, page = 'page') {
  const problems = [];
  const declared = (markdown.match(/<!--\s*snippet:/g) ?? []).length;
  const snippets = pageSnippets(markdown);
  if (snippets.length !== declared) {
    problems.push(`${page}: a "snippet:" comment isn't followed directly by a code block`);
  }
  for (const { path, name, code } of snippets) {
    const file = resolve(root, path);
    if (!existsSync(file)) {
      problems.push(`${page}: snippet source ${path} doesn't exist`);
      continue;
    }
    let region;
    try {
      region = regions(readFileSync(file, 'utf8'), path).get(name);
    } catch (error) {
      problems.push(`${page}: ${error.message}`);
      continue;
    }
    if (region === undefined) problems.push(`${page}: ${path} has no snippet "${name}"`);
    else if (region !== code) problems.push(`${page}: the block for ${path}#${name} differs from the file:\n--- file\n${region}\n--- page\n${code}`);
  }
  return problems;
}

/** Relative links (`](../x.md#heading)`) that don't point at a file. Links to http(s), mailto and anchors are skipped. */
export function brokenLinks(markdown, pageFile) {
  const broken = [];
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '');
  for (const match of withoutCode.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = join(dirname(pageFile), target.split('#')[0]);
    if (!existsSync(path)) broken.push(target);
  }
  return broken;
}

/**
 * What every framework page has, in this order: a title, a translation table, a section about using
 * a component from the framework's app, one about what you get, one about what doesn't cross
 * (linking the boundary page), and the survey question.
 */
export function shapeProblems(markdown, page = 'page') {
  const problems = [];
  const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  if (!/^# Zubra for .+ developers\s*$/m.test(markdown)) problems.push(`${page}: the title is "# Zubra for … developers"`);
  if (!/^\|.*\|\s*\n\|[-| :]+\|/m.test(markdown)) problems.push(`${page}: no translation table`);
  const wanted = [
    [/^Using /, 'a "## Using … in a … app" section'],
    [/^What you get/, 'a "## What you get…" section'],
    [/^What doesn't cross/, 'a "## What doesn\'t cross" section'],
  ];
  let from = 0;
  for (const [pattern, label] of wanted) {
    const at = headings.findIndex((heading, index) => index >= from && pattern.test(heading));
    if (at < 0) problems.push(`${page}: needs ${label}, after the previous one`);
    else from = at + 1;
  }
  if (!/what-crosses-the-boundary\.md/.test(markdown)) problems.push(`${page}: doesn't link what-crosses-the-boundary.md`);
  if (!/^\*\*Which framework do you use alongside Zubra/m.test(markdown)) problems.push(`${page}: doesn't end with the survey question`);
  return problems;
}

/** Every claim in "What you get" links the test or example behind it: a list item with no link is a problem. */
export function claimProblems(markdown, page = 'page') {
  const section = markdown.match(/^## What you get[^\n]*\n([\s\S]*?)(?=^## |\n\*\*Which framework|$(?![\s\S]))/m);
  if (!section) return [];
  const items = section[1].split('\n').filter((line) => /^[-*] /.test(line));
  const problems = items.filter((item) => !/\]\([^)]+\)/.test(item)).map((item) => `${page}: a claim without a link to its test or example: ${item.slice(0, 80)}`);
  if (!items.length) problems.push(`${page}: "What you get" has no claims`);
  return problems;
}
