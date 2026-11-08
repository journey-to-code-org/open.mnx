// The code the landing page shows, produced here rather than typed in: the component is compiled
// at build time (so the HTML and the JavaScript are what `zubra compile` writes today), and the
// by-hand version is read out of the README, where it is kept and kept honest.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFile } from '../../../compiler/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const path = join(here, '../samples/copy-button.zb');

function compiled(options) {
  const response = compileFile(path, options);
  if (!response.ok) throw new Error(`landing page: compiling the sample failed:\n${response.error}`);
  return response.output.trim();
}

const readme = readFileSync(join(repo, 'README.md'), 'utf8');
const byHand = readme.match(/<summary>The same element written by hand[^<]*<\/summary>\s*```js\n([\s\S]*?)\n```/)?.[1];
if (!byHand) throw new Error('landing page: README.md has no "The same element written by hand" block to show');

const lines = (text) => text.split('\n').length;
const source = readFileSync(path, 'utf8').trim();

export default {
  source,
  html: compiled({ emit: 'html', props: { text: 'npm create zubra' } }),
  js: compiled({ emit: 'js' }),
  dts: compiled({ emit: 'dts' }),
  byHand,
  sourceLines: lines(source),
  byHandLines: lines(byHand),
};
