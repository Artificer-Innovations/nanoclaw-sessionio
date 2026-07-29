#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'dist/cli/bin.js',
  'api-contract.md',
  'skills/add-sessionio/SKILL.md',
  'skills/add-sessionio/REMOVE.md',
  'skills/add-sessionio/resources/host/sessionio.ts',
  'skills/add-sessionio/resources/runner/peer.ts',
];
const missing = required.filter((relativePath) => !fs.existsSync(path.join(root, relativePath)));
if (missing.length > 0) {
  console.error(`Missing publish artifacts: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('Publish entry OK');
