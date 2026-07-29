import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { FILE_TRANSFORMS } from './patches.js';
import {
  ENV_KEYS,
  findNanoclawRoot,
  HOST_COPY_RULES,
  hostResourcesDir,
  readPackageVersion,
  rewriteHostResource,
  RUNNER_COPY_RULES,
  runnerResourcesDir,
  skillDir,
} from './paths.js';

interface PendingWrite {
  path: string;
  content: Buffer;
  previous: Buffer | null;
  mode: number | undefined;
}

export interface InstallResult {
  root: string;
  changed: string[];
  unchanged: string[];
  version: string;
  skillPath: string;
}

export function runInstall(root?: string): InstallResult {
  const nanoclawRoot = root ?? findNanoclawRoot();
  console.log(`Detected NanoClaw root: ${nanoclawRoot}`);
  const pending: PendingWrite[] = [];
  const unchanged: string[] = [];

  for (const file of FILE_TRANSFORMS) {
    const absolutePath = path.join(nanoclawRoot, file.path);
    if (!fs.existsSync(absolutePath)) throw new Error(`Missing required host file: ${file.path}`);
    const source = fs.readFileSync(absolutePath, 'utf8');
    const next = file.transform(source);
    stageIfChanged(pending, unchanged, absolutePath, file.path, Buffer.from(next));
  }

  stageResources(pending, unchanged, nanoclawRoot, hostResourcesDir(), HOST_COPY_RULES, true);
  stageResources(pending, unchanged, nanoclawRoot, runnerResourcesDir(), RUNNER_COPY_RULES, false);
  scaffoldEnvKeys(pending, unchanged, nanoclawRoot);
  commitWrites(pending);

  const skillPath = syncSkillToFork(nanoclawRoot);
  return {
    root: nanoclawRoot,
    changed: pending.map((write) => path.relative(nanoclawRoot, write.path)),
    unchanged,
    version: readPackageVersion(),
    skillPath,
  };
}

export function runUpgrade(root?: string): InstallResult {
  return runInstall(root);
}

export function runVerify(root?: string): { root: string; ok: boolean; issues: string[] } {
  const nanoclawRoot = root ?? findNanoclawRoot();
  const issues: string[] = [];

  for (const file of FILE_TRANSFORMS) {
    const absolutePath = path.join(nanoclawRoot, file.path);
    if (!fs.existsSync(absolutePath)) {
      issues.push(`missing ${file.path}`);
      continue;
    }
    const source = fs.readFileSync(absolutePath, 'utf8');
    try {
      if (file.transform(source) !== source) {
        issues.push(`${file.path} missing sessionio call sites`);
      }
    } catch (error) {
      issues.push(
        `${file.path} has invalid sessionio call sites: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  for (const rule of [...HOST_COPY_RULES, ...RUNNER_COPY_RULES]) {
    if (!fs.existsSync(path.join(nanoclawRoot, rule.dest))) issues.push(`missing ${rule.dest}`);
  }
  return { root: nanoclawRoot, ok: issues.length === 0, issues };
}

export function runUninstall(root?: string): {
  root: string;
  changed: string[];
  removed: string[];
} {
  const nanoclawRoot = root ?? findNanoclawRoot();
  const pending: PendingWrite[] = [];
  const unchanged: string[] = [];

  for (const file of FILE_TRANSFORMS) {
    const absolutePath = path.join(nanoclawRoot, file.path);
    if (!fs.existsSync(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, 'utf8');
    const next = file.uninstall(source);
    stageIfChanged(pending, unchanged, absolutePath, file.path, Buffer.from(next));
  }
  commitWrites(pending);

  const removed: string[] = [];
  for (const rule of [...HOST_COPY_RULES, ...RUNNER_COPY_RULES]) {
    const target = path.join(nanoclawRoot, rule.dest);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      removed.push(rule.dest);
    }
  }
  const installedSkill = path.join(nanoclawRoot, '.claude/skills/add-sessionio');
  if (fs.existsSync(installedSkill)) {
    fs.rmSync(installedSkill, { recursive: true, force: true });
    removed.push('.claude/skills/add-sessionio');
  }
  return {
    root: nanoclawRoot,
    changed: pending.map((write) => path.relative(nanoclawRoot, write.path)),
    removed,
  };
}

export function syncSkillToFork(nanoclawRoot: string, source: string = skillDir()): string {
  const destination = path.join(nanoclawRoot, '.claude/skills/add-sessionio');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  copyDirectory(source, destination);
  return destination;
}

export function printInstallNextSteps(
  result: InstallResult,
  options: { upgraded?: boolean } = {},
): void {
  console.log(
    `${options.upgraded ? 'Upgraded' : 'Installed'} nanoclaw-sessionio@${result.version} into ${result.root}`,
  );
  console.log(
    `Changed ${result.changed.length} files; ${result.unchanged.length} already current.`,
  );
  console.log(`Synced skill → ${result.skillPath}`);
  console.log('\nNext steps:');
  console.log('  1. pnpm run build');
  console.log('  2. ./container/build.sh   # runner peer lives in the container image');
  console.log('  3. pnpm exec nanoclaw-sessionio verify');
  console.log('  4. Restart the NanoClaw host service.');
  console.log('  Default transport is filesystem (zero behavior change).');
  console.log('  For local Docker HTTP: SESSIONIO_TRANSPORT=loopback (alias of http) in .env');
  console.log('  For remote agents: SESSIONIO_TRANSPORT=http + reachable SESSIONIO_BASE_URL');
  console.log('  See QUICKSTART.md for env var details.');
}

function scaffoldEnvKeys(pending: PendingWrite[], unchanged: string[], root: string): void {
  const envPath = path.join(root, '.env');
  const examplePath = path.join(root, '.env.example');
  for (const target of [envPath, examplePath]) {
    if (!fs.existsSync(target) && target === envPath) continue;
    if (!fs.existsSync(target)) continue;
    let content = fs.readFileSync(target, 'utf8');
    const original = content;
    if (!content.includes('SESSIONIO_TRANSPORT')) {
      content +=
        '\n# nanoclaw-sessionio — mailbox transport\n' +
        '# filesystem (default) | http (remote/no shared mount) | loopback (= http alias)\n' +
        'SESSIONIO_TRANSPORT=filesystem\n' +
        '# For http/loopback: host listens on HTTP_HOST:PORT; agent dials BASE_URL\n' +
        '# SESSIONIO_HTTP_HOST=0.0.0.0\n' +
        '# SESSIONIO_HTTP_PORT=18765\n' +
        '# SESSIONIO_BASE_URL=http://host.docker.internal:18765\n' +
        '# SESSIONIO_HTTP_TOKEN=\n';
    }
    for (const key of ENV_KEYS) {
      void key;
    }
    if (content !== original) {
      stageIfChanged(pending, unchanged, target, path.relative(root, target), Buffer.from(content));
    } else {
      unchanged.push(path.relative(root, target));
    }
  }
}

/** @internal Exported for unit tests — do not call from installer CLI paths. */
export function stageResourcesForTests(
  resourcesDir: string,
  rules: { source: string; dest: string }[] = HOST_COPY_RULES,
): void {
  stageResources([], [], '/tmp/sessionio-unused-root', resourcesDir, rules, false);
}

function stageResources(
  pending: PendingWrite[],
  unchanged: string[],
  root: string,
  resources: string,
  rules: { source: string; dest: string }[],
  rewriteHost: boolean,
): void {
  for (const rule of rules) {
    const source = path.join(resources, rule.source);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing bundled resource: ${rule.source}. Run pnpm run build.`);
    }
    let content = fs.readFileSync(source);
    if (rewriteHost) {
      content = Buffer.from(rewriteHostResource(rule.source, content.toString('utf8')));
    }
    stageIfChanged(pending, unchanged, path.join(root, rule.dest), rule.dest, content);
  }
}

function stageIfChanged(
  pending: PendingWrite[],
  unchanged: string[],
  absolutePath: string,
  relativePath: string,
  content: Buffer,
): void {
  const exists = fs.existsSync(absolutePath);
  const previous = exists ? fs.readFileSync(absolutePath) : null;
  if (previous?.equals(content)) {
    unchanged.push(relativePath);
    return;
  }
  pending.push({
    path: absolutePath,
    content,
    previous,
    mode: exists ? fs.statSync(absolutePath).mode : undefined,
  });
}

function commitWrites(writes: PendingWrite[]): void {
  const committed: PendingWrite[] = [];
  try {
    for (const write of writes) {
      atomicWrite(write.path, write.content, write.mode);
      committed.push(write);
    }
    /* v8 ignore next 8 */
  } catch (error) {
    for (const write of committed.reverse()) {
      if (write.previous === null) fs.rmSync(write.path, { force: true });
      else atomicWrite(write.path, write.previous, write.mode);
    }
    throw error;
  }
}

function atomicWrite(target: string, content: Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.sessionio-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, mode === undefined ? undefined : { mode });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function copyDirectory(source: string, destination: string): void {
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) fs.rmSync(destination, { force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(destination)) {
    fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}
