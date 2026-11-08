// The skills are documentation an agent works from, so what they show must be true:
// - every `.mnx` example in a skill compiles (and renders on the server where the skill says so);
// - the JSON request a skill shows is answered by `mnx request`;
// - the copies `npm create mnx` ships match the skills here;
// - `AGENTS.md` names every skill.
// `node --test skills/test/skills.test.js` (needs `cargo build --release`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const mnx = join(repo, 'target/release/mnx');
const skills = readdirSync(join(repo, 'skills')).filter((name) => existsSync(join(repo, 'skills', name, 'SKILL.md')));
const read = (skill) => readFileSync(join(repo, 'skills', skill, 'SKILL.md'), 'utf8');
const blocks = (text, lang) => [...text.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]);

test('every skill has frontmatter with a name matching its folder and a description', () => {
  assert.ok(skills.length >= 4);
  for (const skill of skills) {
    const head = read(skill).match(/^---\n([\s\S]*?)\n---/)?.[1];
    assert.ok(head, `${skill}: frontmatter`);
    assert.match(head, new RegExp(`^name: ${skill}$`, 'm'));
    assert.match(head, /^description: \S.{40,}/m);
  }
});

test('every .mnx example in the skills compiles, and renders on the server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnx-skills-'));
  let examples = 0;
  for (const skill of skills) {
    for (const [index, html] of blocks(read(skill), 'html').entries()) {
      if (!/<[a-z]+-[a-z-]+[\s>]/.test(html) || !/<\/[a-z]+-[a-z-]+>\s*$/.test(html)) continue; // not a component
      const file = join(dir, `${skill}-${index}.mnx`);
      writeFileSync(file, html);
      execFileSync(mnx, ['check', '--server', file], { encoding: 'utf8' });
      const output = execFileSync(mnx, ['compile', file], { encoding: 'utf8' });
      assert.match(output, /^<[a-z]+-[a-z-]+/, `${skill} example ${index} renders`);
      examples++;
    }
  }
  assert.ok(examples >= 1, 'at least one component example');
});

test('the request example in the CLI skill is answered', () => {
  const [json] = blocks(read('mnx-cli'), 'json');
  const request = JSON.parse(json);
  request.files[request.path] = '<price-tag cents={0}>\n  <span>${(cents / 100).toFixed(2)}</span>\n</price-tag>\n';
  const result = spawnSync(mnx, ['request'], { input: JSON.stringify(request), encoding: 'utf8' });
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true, response.error);
  assert.match(response.output, /\$1299\.00/);
});

test('the skills npm create mnx ships are the ones here', () => {
  for (const skill of ['mnx-component', 'mnx-consume']) {
    const shipped = join(repo, 'create/templates/shared/skills', skill, 'SKILL.md');
    assert.ok(existsSync(shipped), `${shipped} (run scripts/sync-skills.sh)`);
    assert.equal(readFileSync(shipped, 'utf8'), read(skill), `${skill}: create/templates/shared copy is stale (run scripts/sync-skills.sh)`);
  }
});

test('AGENTS.md names every skill', () => {
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  for (const skill of skills) assert.ok(agents.includes(`skills/${skill}/SKILL.md`), skill);
});
