// Prints a version's section of CHANGELOG.md, for its GitHub release:
//
//   node scripts/release-notes.mjs 5.2.0
//
// It fails when the section is missing or empty, so a release can't go out without its notes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) throw new Error('usage: node scripts/release-notes.mjs <version>');
const changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((line) => line.startsWith(`## ${version} `) || line === `## ${version}`);
if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
const notes = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
if (!notes) throw new Error(`CHANGELOG.md's "## ${version}" section is empty`);
console.log(notes);
