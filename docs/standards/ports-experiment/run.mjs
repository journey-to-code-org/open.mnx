// The ports experiment (plan/roadmap-4.0.md challenge 3): an agent ports registry components to
// three frameworks, a fix is applied to the source and the agent applies it to each port, and a
// second agent reviews each port against the source for behavioural differences.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const repo = '/home/claude/zubra';
const components = ['star-rating', 'toggle-switch', 'quantity-stepper'];
const frameworks = {
  react: 'a React 19 function component in TypeScript (.tsx), with props, an onXChange callback for each event, and no external dependencies',
  vue: 'a Vue 3 single-file component (.vue, <script setup lang="ts">), with props, emits and defineModel for the two-way prop, and no external dependencies',
  svelte: 'a Svelte 5 component (.svelte, runes), with $props() and $bindable for the two-way prop, and no external dependencies',
};
const ask = (prompt) => {
  const run = spawnSync('claude', ['-p'], { input: prompt, encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout;
};
const code = (text) => text.match(/```[a-z]*\n([\s\S]*?)```/)?.[1] ?? text;
const source = (name) => readFileSync(`${repo}/registry/components/${name}.zb`, 'utf8');
const stage = process.argv[2];
const log = [];
const record = (line) => { console.log(line); log.push(line); };

if (stage === 'port') {
  for (const name of components) {
    for (const [fw, what] of Object.entries(frameworks)) {
      const ext = { react: 'tsx', vue: 'vue', svelte: 'svelte' }[fw];
      const file = `ports/${fw}/${name}.${ext}`;
      mkdirSync(`ports/${fw}`, { recursive: true });
      if (existsSync(file)) continue;
      const t = Date.now();
      const out = ask(`Below is a web component written in the zubra format (HTML with {bindings}; the host tag declares the props with their defaults; "name:model" is a two-way prop that fires "<name>change"; "form-associated" means it is a form control; a top-level let is state). Port it faithfully to ${what}. Keep every prop, every event, the same accessibility (roles, aria attributes, keyboard behaviour), the same form behaviour where the framework allows it, and the same styles (as the component's own scoped styles). Answer with the file's contents only, in one code block.\n\n${source(name)}`);
      writeFileSync(file, code(out));
      record(`ported ${name} to ${fw}: ${code(out).split('\n').length} lines, ${Math.round((Date.now() - t) / 1000)}s`);
    }
  }
}

if (stage === 'review') {
  const after = process.argv[3] === 'after';
  for (const name of components) {
    for (const fw of Object.keys(frameworks)) {
      const ext = { react: 'tsx', vue: 'vue', svelte: 'svelte' }[fw];
      const port = readFileSync(`ports/${fw}/${name}.${ext}`, 'utf8');
      const src = after && existsSync(`fixed/${name}.zb`) ? readFileSync(`fixed/${name}.zb`, 'utf8') : source(name);
      const out = ask(`You are reviewing a port of a web component. The ORIGINAL is in the zubra format (HTML with {bindings}; the host tag declares the props with defaults; "name:model" is a two-way prop firing "<name>change" with the new value as detail; "form-associated" means a form control that submits its value under its name and resets with the form; "emit" fires a DOM CustomEvent). The PORT is a ${fw} component. List every BEHAVIOURAL difference between the port and the original: a prop missing, renamed or with a different default; an event missing, renamed or with a different payload; a keyboard, focus, role or aria difference; a form-submission or reset difference; a visual state missing. Ignore syntax, framework idiom, styling details and code organisation. Answer with a JSON array of short strings, one per difference, and [] if there are none. No prose.\n\n===== ORIGINAL =====\n${src}\n\n===== PORT =====\n${port}`);
      let items;
      try { items = JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] ?? '[]'); } catch { items = ['(unparseable review)']; }
      record(`${after ? 'after' : 'before'} ${name}/${fw}: ${items.length} difference(s)${items.length ? ': ' + items.join(' | ') : ''}`);
    }
  }
}

if (stage === 'fix') {
  // The fix, written as a diff description the way a maintainer would hand it to an agent.
  const fixes = JSON.parse(readFileSync('fixes.json', 'utf8'));
  for (const [name, { description, zubra }] of Object.entries(fixes)) {
    mkdirSync('fixed', { recursive: true });
    writeFileSync(`fixed/${name}.zb`, zubra);
    for (const fw of Object.keys(frameworks)) {
      const ext = { react: 'tsx', vue: 'vue', svelte: 'svelte' }[fw];
      const file = `ports/${fw}/${name}.${ext}`;
      const port = readFileSync(file, 'utf8');
      const t = Date.now();
      const out = ask(`A bug was fixed in the original web component (zubra format). Apply the same fix to this ${fw} port. The fix: ${description}\n\nThe original, after the fix:\n\n${zubra}\n\nThe port to fix:\n\n${port}\n\nAnswer with the whole fixed port file, in one code block, and nothing else.`);
      writeFileSync(file, code(out));
      record(`applied the ${name} fix to ${fw}: ${Math.round((Date.now() - t) / 1000)}s`);
    }
  }
}
writeFileSync(`log-${stage}${process.argv[3] ? '-' + process.argv[3] : ''}.txt`, log.join('\n') + '\n');
