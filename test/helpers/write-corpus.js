'use strict';
// Writes the corpus to test/fixtures/corpus (run once after changing test/helpers/corpus.js):
//   node test/helpers/write-corpus.js
const fs = require('node:fs');
const path = require('node:path');
const C = require('./corpus');

const dir = path.join(__dirname, '..', 'fixtures', 'corpus');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
const files = C.build();
for (const f of files) fs.writeFileSync(path.join(dir, f.name), C.bytesOf(f));
process.stdout.write('wrote ' + files.length + ' files to ' + dir + '\n');
