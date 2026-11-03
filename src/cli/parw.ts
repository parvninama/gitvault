import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeParw, encodeParw } from '../server/parw/format.ts';

const [cmd, input, output] = process.argv.slice(2);
if ((cmd !== 'encode' && cmd !== 'decode') || !input) {
  console.error('usage: parw:encode <file> [out.parw]  |  parw:decode <file.parw> [out]');
  process.exit(2);
}
try {
  const bytes = readFileSync(input);
  if (cmd === 'encode') {
    const out = encodeParw({ data: bytes, filename: basename(input) });
    const dest = output ?? input + '.parw';
    writeFileSync(dest, out);
    console.log(`${input}: ${bytes.length} -> ${out.length} bytes (${((1 - out.length / Math.max(bytes.length, 1)) * 100).toFixed(1)}% smaller) => ${dest}`);
  } else {
    const { data, metadata } = decodeParw(bytes);
    const dest = output ?? metadata.filename;
    writeFileSync(dest, data);
    console.log(`${input}: verified SHA-256 ${metadata.sha256}\n  restored ${data.length} bytes => ${dest}`);
  }
} catch (e) {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
}
