import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const examples = join(dirname(fileURLToPath(import.meta.url)), '..');
export const repo = join(examples, '../..');
