#!/bin/sh
set -eu
node - <<'NODE'
const fs = require('fs');
const z = require('zlib');
const b = z.gzipSync(fs.readFileSync('package-lock.json'), { level: 9 }).toString('base64');
const n = 6000;
for (let i = 0; i < b.length; i += n) {
  console.log(`LOCKCHUNK:${String(i / n).padStart(4, '0')}:${b.slice(i, i + n)}`);
}
console.log(`LOCKCHUNK_END:${b.length}:${Math.ceil(b.length / n)}`);
NODE
exit 1
