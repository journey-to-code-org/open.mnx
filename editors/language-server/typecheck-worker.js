#!/usr/bin/env node
// Runs one `zubra check --types` for the language server, in a process of its own so the editor
// never waits on `tsc`. Input (stdin, JSON): { module, file, text }: the project's
// @zubra/compiler/typecheck, the component and its unsaved text. The generated files go in a
// folder of their own (`.zubra-types/editor-<pid>`), so a check from the terminal can run too. Output (stdout, JSON): the diagnostics, or { error }.
import { pathToFileURL } from 'node:url';

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  try {
    const { module, file, text } = JSON.parse(input);
    const { checkTypes } = await import(pathToFileURL(module).href);
    const { diagnostics } = checkTypes([file], { folder: `editor-${process.pid}`, texts: text === undefined ? {} : { [file]: text } });
    process.stdout.write(JSON.stringify({ diagnostics }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }));
  }
});
