#!/usr/bin/env node
/**
 * Fixture install → verify → uninstall smoke (stock anchors).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binUrl = pathToFileURL(path.join(root, 'dist/cli/bin.js')).href;

if (!fs.existsSync(path.join(root, 'dist/cli/bin.js'))) {
  console.error('Missing dist/cli/bin.js — run pnpm run build first');
  process.exit(1);
}

const { runInstall, runUninstall, runVerify } = await import(
  binUrl.replace(/bin\.js$/, 'install.js')
);
const {
  STOCK_SESSION_MANAGER,
  STOCK_DELIVERY,
  STOCK_HOST_SWEEP,
  STOCK_CONTAINER_RUNNER,
  STOCK_INDEX,
  STOCK_RUNNER_INDEX,
  STOCK_POLL_LOOP,
} = await import(pathToFileURL(path.join(root, 'dist/cli/test-fixtures.js')).href);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionio-integration-'));
const files = {
  'src/session-manager.ts': STOCK_SESSION_MANAGER,
  'src/delivery.ts': STOCK_DELIVERY,
  'src/host-sweep.ts': STOCK_HOST_SWEEP,
  'src/container-runner.ts': STOCK_CONTAINER_RUNNER,
  'src/index.ts': STOCK_INDEX,
  'container/agent-runner/src/index.ts': STOCK_RUNNER_INDEX,
  'container/agent-runner/src/poll-loop.ts': STOCK_POLL_LOOP,
  '.env.example': 'FOO=1\n',
};

try {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(fixture, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  runInstall(fixture);
  const verify = runVerify(fixture);
  if (!verify.ok) {
    console.error(verify.issues);
    process.exit(1);
  }
  runUninstall(fixture);
  console.log('Integration OK');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
