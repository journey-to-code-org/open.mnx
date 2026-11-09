// The extension as a .zip for the Chrome Web Store and Firefox Add-ons: what the browser loads,
// with manifest.json at the root (no tests, README or package.json). Node only, no `zip` program,
// so it works the same on Windows, macOS and Linux:
//
//   npm run pack                      → ../zubra-devtools-<version>.zip
//   npm run pack -- --out some/where.zip
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEFT_OUT = new Set(['test', 'scripts', 'node_modules', 'package.json', 'package-lock.json', 'README.md']);

/** The files the extension is made of, as zip paths (forward slashes), sorted. */
export function files(dir = root) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    if (LEFT_OUT.has(name) || name.startsWith('.') || name.endsWith('.zip')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...files(path));
    else found.push(relative(root, path).split(sep).join('/'));
  }
  return found;
}

/** A zip archive of `entries` ({ name, data }), deflated, with a fixed date so builds repeat. */
export function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  // 1980-01-01 00:00, the earliest DOS date: the same bytes for the same files.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const path = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header
    header.writeUInt16LE(20, 4); // version needed: 2.0
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(deflated.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(path.length, 26);
    local.push(header, path, deflated);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); // central directory record
    record.writeUInt16LE(20, 4); // made by: 2.0
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(deflated.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(path.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, path);
    offset += header.length + path.length + deflated.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const at = process.argv.indexOf('--out');
  const out = at > 0 ? resolve(process.argv[at + 1]) : resolve(root, '..', `zubra-devtools-${version}.zip`);
  const names = files();
  writeFileSync(out, zip(names.map((name) => ({ name, data: readFileSync(join(root, name)) }))));
  console.log(`zubra-devtools ${version}: ${names.length} files → ${relative(process.cwd(), out) || out}`);
}
