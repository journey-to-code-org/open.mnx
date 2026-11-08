// The page's own components, written in Zubra and compiled here at build time: the HTML goes into
// the page (so it is there before any script runs) and the JavaScript is shipped as landing/copy-button.js.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFile } from '../../../compiler/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, '../components/copy-button.zb');

function compiled(options) {
  const response = compileFile(path, options);
  if (!response.ok) throw new Error(`landing page: compiling copy-button.zb failed:\n${response.error}`);
  return response.output;
}

export default {
  copyButton: {
    html: compiled({ emit: 'html', props: { text: 'npm create zubra@latest' } }).trim(),
    js: compiled({ emit: 'js' }),
  },
};
