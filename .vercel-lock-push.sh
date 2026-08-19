#!/bin/sh
set -eu
git diff -- package-lock.json > /tmp/lock.patch
node -e "const fs=require('fs'),z=require('zlib');const b=z.gzipSync(fs.readFileSync('/tmp/lock.patch'),{level:9}).toString('base64');console.log('PATCHGZ:'+b);console.log('PATCHGZ_END:'+b.length)"
exit 1
