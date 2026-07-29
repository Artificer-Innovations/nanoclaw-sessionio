#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function copy(source, destination) {
  const target = path.join(root, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, source), target);
}

function copyDir(source, destination) {
  const from = path.join(root, source);
  const to = path.join(root, destination);
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // Keep conformance tests in skill resources; skip other unit tests.
    if (entry.name.endsWith('.test.ts') && !entry.name.includes('conformance')) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(path.relative(root, src), path.relative(root, dest));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      fs.copyFileSync(src, dest);
    }
  }
}

copy('packages/shared/src/warn-once.ts', 'packages/host/src/warn-once.ts');
copy('packages/shared/src/warn-once.ts', 'packages/runner/src/warn-once.ts');
copy('packages/shared/src/types.ts', 'packages/host/src/types.ts');
copy('packages/shared/src/types.ts', 'packages/runner/src/types.ts');

copyDir('packages/host/src', 'skills/add-sessionio/resources/host');
copyDir('packages/runner/src', 'skills/add-sessionio/resources/runner');

console.log('Synced sessionio resources');
