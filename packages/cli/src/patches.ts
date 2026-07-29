export const SESSIONIO_MARKER = '@nanoclaw-sessionio';

const begin = (name: string): string => `// ${SESSIONIO_MARKER}:${name}:begin`;
const end = (name: string): string => `// ${SESSIONIO_MARKER}:${name}:end`;

export interface FileTransform {
  path: string;
  transform: (content: string) => string;
  uninstall: (content: string) => string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceOnce(content: string, search: string, replacement: string, label: string): string {
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`Could not find ${label} anchor`);
  /* v8 ignore next 3 */
  if (content.indexOf(search, first + search.length) >= 0) {
    throw new Error(`${label} anchor is ambiguous`);
  }
  return content.slice(0, first) + replacement + content.slice(first + search.length);
}

function installImport(
  content: string,
  modulePath: string,
  symbols: string[],
  name: string,
): string {
  if (content.includes(begin(name))) return content;
  const firstImport = content.search(/^import /m);
  if (firstImport < 0) throw new Error(`Could not find import anchor for ${name}`);
  const block = `${begin(name)}\nimport { ${symbols.join(', ')} } from '${modulePath}';\n${end(name)}\n`;
  return content.slice(0, firstImport) + block + content.slice(firstImport);
}

function removeMarkedBlock(content: string, name: string): string {
  const pattern = new RegExp(
    `^[ \\t]*${escapeRegExp(begin(name))}\\r?\\n[\\s\\S]*?^[ \\t]*${escapeRegExp(end(name))}\\r?\\n?`,
    'm',
  );
  const next = content.replace(pattern, '');
  /* v8 ignore next 3 */
  if (content.includes(begin(name)) && next === content) {
    throw new Error(`Corrupt sessionio block: ${name}`);
  }
  return next;
}

function marked(name: string, body: string): string {
  return `${begin(name)}\n${body}\n${end(name)}`;
}

function isFullyPatched(content: string, names: string[]): boolean {
  return names.every((name) => content.includes(begin(name)) && content.includes(end(name)));
}

function uninstallMarks(content: string, names: string[]): string {
  let next = content;
  for (const name of names) next = removeMarkedBlock(next, name);
  return next;
}

/** Rename stock writeSessionMessage → filesystemWriteSessionMessage and wrap with transport dispatch. */
export function patchSessionManager(source: string): string {
  const names = ['session-manager-import', 'session-manager-write'];
  if (isFullyPatched(source, names) && source.includes('filesystemWriteSessionMessage')) {
    return source;
  }

  let content = installImport(
    source,
    './sessionio.js',
    ['resolveSessionTransport'],
    'session-manager-import',
  );

  if (!content.includes('filesystemWriteSessionMessage')) {
    content = replaceOnce(
      content,
      'export function writeSessionMessage(',
      `export function filesystemWriteSessionMessage( // ${SESSIONIO_MARKER}:renamed-write`,
      'writeSessionMessage export',
    );

    // Real NanoClaw uses `localPath` in this docblock; keep a fallback for older fixtures.
    const bodyEndCandidates = [
      `  updateSession(sessionId, { last_active: new Date().toISOString() });
}

/**
 * If message content has attachments with base64 \`data\`, save them to
 * the session's inbox directory and replace with \`localPath\`.`,
      `  updateSession(sessionId, { last_active: new Date().toISOString() });
}

/**
 * If message content has attachments with base64 \`data\`, save them to
 * the session's inbox directory and replace with file paths.`,
    ];
    const bodyEnd = bodyEndCandidates.find((candidate) => content.includes(candidate));
    if (!bodyEnd) throw new Error('Could not find writeSessionMessage body end anchor');

    const writeWrapper = `${marked(
      'session-manager-write',
      `export function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: Parameters<typeof filesystemWriteSessionMessage>[2],
): void {
  const transport = resolveSessionTransport({ agentGroupId, sessionId });
  void transport.enqueueInbound({ agentGroupId, sessionId }, message);
  updateSession(sessionId, { last_active: new Date().toISOString() });
}`,
    )}`;

    content = replaceOnce(
      content,
      bodyEnd,
      `  updateSession(sessionId, { last_active: new Date().toISOString() });
}

${writeWrapper}

${bodyEnd.slice(bodyEnd.indexOf('/**'))}`,
      'writeSessionMessage body end',
    );
  }

  return content;
}

export function uninstallSessionManager(source: string): string {
  let content = uninstallMarks(source, ['session-manager-write', 'session-manager-import']);
  content = content.replace(
    new RegExp(
      `export function filesystemWriteSessionMessage\\( // ${escapeRegExp(SESSIONIO_MARKER)}:renamed-write`,
    ),
    'export function writeSessionMessage(',
  );
  return content;
}

const STOCK_DRAIN_SESSION = `async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);

        // Pause the typing indicator after a real user-facing message
        // lands on the user's screen, so the client has time to visually
        // clear the indicator before the next heartbeat tick brings it
        // back. Skip the pause for internal traffic (system actions,
        // agent-to-agent routing) — the user doesn't see those and
        // shouldn't get a gap in their typing indicator for them.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          deliveryAttempts.delete(msg.id);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}`;

const PATCHED_DRAIN_SESSION = `async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const transport = resolveSessionTransport({
    agentGroupId: agentGroup.id,
    sessionId: session.id,
  });
  const undelivered = await Promise.resolve(
    transport.pollOutbound({
      agentGroupId: agentGroup.id,
      sessionId: session.id,
    }),
  );
  if (undelivered.length === 0) return;

  let inDb: Database.Database;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
    migrateDeliveredTable(inDb);
  } catch (err) {
    // Match stock: without inbound DB we cannot deliver or record failures.
    log.warn('drainSession: inbound DB unavailable, deferring delivery', {
      sessionId: session.id,
      err,
    });
    return;
  }

  try {
    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        await Promise.resolve(
          transport.ackDelivered(
            { agentGroupId: agentGroup.id, sessionId: session.id },
            [msg.id],
            [platformMsgId ?? null],
          ),
        );
        deliveryAttempts.delete(msg.id);

        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          deliveryAttempts.delete(msg.id);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }
  } finally {
    inDb.close();
  }
}`;

export function patchDelivery(source: string): string {
  const names = ['delivery-import', 'delivery-drain'];
  let content = source;
  // Upgrade prior patch that continued with inDb=null / type-asserted deliverMessage.
  if (
    content.includes(begin('delivery-drain')) &&
    (content.includes('inDb as Database.Database') || content.includes('inDb?.close()'))
  ) {
    content = uninstallDelivery(content);
  }
  if (isFullyPatched(content, names)) return content;

  content = installImport(
    content,
    './sessionio.js',
    ['resolveSessionTransport'],
    'delivery-import',
  );

  content = replaceOnce(
    content,
    STOCK_DRAIN_SESSION,
    marked('delivery-drain', PATCHED_DRAIN_SESSION),
    'delivery drainSession',
  );

  return content;
}

export function uninstallDelivery(source: string): string {
  let content = uninstallMarks(source, ['delivery-drain', 'delivery-import']);
  if (!content.includes('async function drainSession(session: Session): Promise<void>')) {
    const anchor = 'async function deliverMessage(';
    const idx = content.indexOf(anchor);
    if (idx < 0) throw new Error('Could not restore drainSession: deliverMessage anchor missing');
    content = `${content.slice(0, idx)}${STOCK_DRAIN_SESSION}\n\n${content.slice(idx)}`;
  }
  return content;
}

export function patchHostSweep(source: string): string {
  let content = source;

  content = installImport(
    content,
    './sessionio.js',
    ['resolveSessionTransport'],
    'host-sweep-import',
  );

  if (!content.includes(begin('host-sweep-liveness'))) {
    content = replaceOnce(
      content,
      `function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}`,
      marked(
        'host-sweep-liveness',
        `function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const transport = resolveSessionTransport({ agentGroupId, sessionId });
  const liveness = transport.getLiveness({ agentGroupId, sessionId });
  if (liveness && typeof (liveness as { lastHeartbeatAt?: number }).lastHeartbeatAt === 'number') {
    return (liveness as { lastHeartbeatAt: number }).lastHeartbeatAt;
  }
  // getLiveness may be async for some transports; fall back to filesystem mtime.
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}`,
      ),
      'host-sweep heartbeatMtimeMs',
    );
  }

  if (!content.includes(begin('host-sweep-due'))) {
    content = replaceOnce(
      content,
      '    const dueCount = countDueMessages(inDb);',
      marked(
        'host-sweep-due',
        `    const sessionioTransport = resolveSessionTransport({
      agentGroupId: agentGroup.id,
      sessionId: session.id,
    });
    const dueCount = sessionioTransport.countDueInbound
      ? await Promise.resolve(
          sessionioTransport.countDueInbound({
            agentGroupId: agentGroup.id,
            sessionId: session.id,
          }),
        )
      : countDueMessages(inDb);`,
      ),
      'host-sweep dueCount',
    );
  }

  return content;
}

export function uninstallHostSweep(source: string): string {
  let content = source;
  const duePattern = new RegExp(
    `^[ \\t]*${escapeRegExp(begin('host-sweep-due'))}\\r?\\n[\\s\\S]*?^[ \\t]*${escapeRegExp(end('host-sweep-due'))}\\r?\\n?`,
    'm',
  );
  content = content.replace(duePattern, '    const dueCount = countDueMessages(inDb);\n');
  content = uninstallMarks(content, ['host-sweep-liveness', 'host-sweep-import']);
  if (!content.includes('function heartbeatMtimeMs')) {
    content += `
function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}
`;
  }
  return content;
}

export function patchContainerRunner(source: string): string {
  let content = source;
  // Upgrade stale env stubs (wrong insert point, missing docker -e, or no shared helper).
  // Old blocks wrapped the spawn log — uninstalling them can delete that log line.
  if (
    content.includes(begin('container-runner-env')) &&
    (!content.includes('injectSessionioContainerEnv') ||
      !content.includes("from './sessionio-docker-env.js'"))
  ) {
    content = uninstallMarks(content, ['container-runner-env']);
  }

  const spawnLog =
    "  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });";
  if (!content.includes(spawnLog)) {
    const argsClose = `  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );`;
    if (content.includes(argsClose)) {
      content = replaceOnce(
        content,
        argsClose,
        `${argsClose}\n\n${spawnLog}`,
        'container-runner restore spawn log',
      );
    }
  }

  content = installImport(
    content,
    './sessionio.js',
    ['resolveSessionTransport', 'resolveTransportName'],
    'container-runner-import',
  );

  if (!content.includes(begin('container-runner-docker-env-import'))) {
    content = installImport(
      content,
      './sessionio-docker-env.js',
      ['injectSessionioContainerEnv'],
      'container-runner-docker-env-import',
    );
  }

  if (
    content.includes(begin('container-runner-meta')) &&
    content.includes('void transport.syncSessionMeta?.(') &&
    content.includes('{},\n    );')
  ) {
    content = uninstallMarks(content, ['container-runner-meta']);
    // Marker wrapped writeSessionRouting — restore the stock call if removed.
    if (!content.includes('writeSessionRouting(agentGroup.id, session.id);')) {
      if (content.includes(spawnLog)) {
        content = content.replace(
          spawnLog,
          `  writeSessionRouting(agentGroup.id, session.id);\n\n${spawnLog}`,
        );
      }
    }
  }

  if (!content.includes(begin('container-runner-meta'))) {
    content = replaceOnce(
      content,
      `  writeSessionRouting(agentGroup.id, session.id);`,
      marked(
        'container-runner-meta',
        `  writeSessionRouting(agentGroup.id, session.id);
  {
    const transport = resolveSessionTransport({
      agentGroupId: agentGroup.id,
      sessionId: session.id,
    });
    // Project host routing/destinations into the HTTP mailbox store (not {}).
    let meta: {
      routing: {
        channel_type: string | null;
        platform_id: string | null;
        thread_id: string | null;
      };
      destinations?: Array<{
        name: string;
        display_name: string | null;
        type: 'channel' | 'agent';
        channel_type: string | null;
        platform_id: string | null;
        agent_group_id: string | null;
      }>;
    } = {
      routing: {
        channel_type: null,
        platform_id: null,
        thread_id: session.thread_id ?? null,
      },
    };
    try {
      const { openInboundDb } = await import('./session-manager.js');
      const db = openInboundDb(agentGroup.id, session.id);
      try {
        const row = db
          .prepare(
            'SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1',
          )
          .get() as
          | {
              channel_type: string | null;
              platform_id: string | null;
              thread_id: string | null;
            }
          | undefined;
        if (row) meta.routing = row;
        meta.destinations = db
          .prepare(
            'SELECT name, display_name, type, channel_type, platform_id, agent_group_id FROM destinations ORDER BY name',
          )
          .all() as NonNullable<typeof meta.destinations>;
      } finally {
        db.close();
      }
    } catch {
      // Session DB may not exist yet; still sync thread_id from the Session row.
    }
    void transport.syncSessionMeta?.(
      { agentGroupId: agentGroup.id, sessionId: session.id },
      meta,
    );
  }`,
      ),
      'container-runner writeSessionRouting',
    );
  }

  // Process/other runtimes skip spawnContainer — project mailbox meta on every wake.
  const wakeMetaAnchor =
    '    // @nanoclaw-sessionio:wake-prepare-meta:begin\n    // @nanoclaw-sessionio:wake-prepare-meta:end';
  if (
    content.includes(wakeMetaAnchor) &&
    !content.includes(begin('wake-prepare-meta'))
  ) {
    content = replaceOnce(
      content,
      wakeMetaAnchor,
      marked(
        'wake-prepare-meta',
        `    {
      const transport = resolveSessionTransport({
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
      });
      let meta: {
        routing: {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        };
        destinations?: Array<{
          name: string;
          display_name: string | null;
          type: 'channel' | 'agent';
          channel_type: string | null;
          platform_id: string | null;
          agent_group_id: string | null;
        }>;
      } = {
        routing: {
          channel_type: null,
          platform_id: null,
          thread_id: session.thread_id ?? null,
        },
      };
      try {
        const { openInboundDb } = await import('./session-manager.js');
        const db = openInboundDb(session.agent_group_id, session.id);
        try {
          const row = db
            .prepare(
              'SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1',
            )
            .get() as
            | {
                channel_type: string | null;
                platform_id: string | null;
                thread_id: string | null;
              }
            | undefined;
          if (row) meta.routing = row;
          meta.destinations = db
            .prepare(
              'SELECT name, display_name, type, channel_type, platform_id, agent_group_id FROM destinations ORDER BY name',
            )
            .all() as NonNullable<typeof meta.destinations>;
        } finally {
          db.close();
        }
      } catch {
        // Session DB may not exist yet; still sync thread_id from the Session row.
      }
      void transport.syncSessionMeta?.(
        { agentGroupId: session.agent_group_id, sessionId: session.id },
        meta,
      );
    }`,
      ),
      'container-runner wake-prepare-meta',
    );
  }

  // Inject SESSIONIO_* into docker args so the agent peer can reach the host mailbox.
  // Keep the spawn log OUTSIDE the marker so uninstall cannot eat it again.
  if (!content.includes(begin('container-runner-env')) && content.includes(spawnLog)) {
    content = replaceOnce(
      content,
      spawnLog,
      `${marked(
        'container-runner-env',
        `  // Sessionio: inject peer env into the container when using http/loopback.
  // Must insert BEFORE the image name (--entrypoint … IMAGE -c …); appending
  // would pass -e flags as bash args and they would never become container env.
  if (resolveTransportName({ agentGroupId: agentGroup.id, sessionId: session.id }) === 'http') {
    injectSessionioContainerEnv(args, {
      transport: process.env.SESSIONIO_TRANSPORT ?? 'http',
      baseUrl: process.env.SESSIONIO_BASE_URL,
      token: process.env.SESSIONIO_HTTP_TOKEN,
      sessionId: session.id,
      agentGroupId: agentGroup.id,
      hostNoProxy: process.env.NO_PROXY,
    });
  }`,
      )}\n${spawnLog}`,
      'container-runner spawn log',
    );
  }

  return content;
}

export function uninstallContainerRunner(source: string): string {
  return uninstallMarks(source, [
    'container-runner-env',
    'container-runner-meta',
    'wake-prepare-meta',
    'container-runner-docker-env-import',
    'container-runner-import',
  ]);
}

export function patchIndex(source: string): string {
  const names = ['index-boot'];
  if (isFullyPatched(source, names)) return source;

  const anchor = `  startActiveDeliveryPoll();
  startSweepDeliveryPoll();`;
  if (!source.includes(anchor)) {
    throw new Error('Could not find index.ts delivery poll boot anchor');
  }

  return replaceOnce(
    source,
    anchor,
    marked(
      'index-boot',
      `  {
    const { startSessionio } = await import('./sessionio-boot.js');
    await startSessionio();
  }
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();`,
    ),
    'index delivery poll boot',
  );
}

export function uninstallIndex(source: string): string {
  return uninstallMarks(source, ['index-boot']);
}

export function patchRunnerIndex(source: string): string {
  const names = ['runner-register'];
  if (isFullyPatched(source, names)) return source;

  const firstImport = source.search(/^import /m);
  if (firstImport < 0) throw new Error('Could not find runner index import anchor');
  if (source.includes(begin('runner-register'))) return source;

  const block = `${begin('runner-register')}
import { registerSessionioRunner } from './sessionio/register.js';
registerSessionioRunner();
${end('runner-register')}
`;
  return source.slice(0, firstImport) + block + source.slice(firstImport);
}

export function uninstallRunnerIndex(source: string): string {
  return uninstallMarks(source, ['runner-register']);
}

export function patchPollLoop(source: string): string {
  let content = source;
  // Upgrade stub that only declared __sessionioPeer without wiring IO,
  // or that eagerly captured the peer before registerSessionioRunner(),
  // or that lacked stageOutbox/getMeta wiring.
  if (
    content.includes(begin('poll-loop-peer')) &&
    (!content.includes('sessionioGetPendingMessages') ||
      content.includes('const __sessionioPeer = getSessionioPeer()') ||
      !content.includes('stageOutbox') ||
      !content.includes('getMeta'))
  ) {
    content = uninstallMarks(content, ['poll-loop-peer', 'poll-loop-peer-import']);
    // Restore call sites if uninstall left sessionio wrappers behind.
    content = content.replace(/\bawait sessionioGetPendingMessages\(/g, 'getPendingMessages(');
    content = content.replace(/\bawait sessionioWriteMessageOut\(/g, 'writeMessageOut(');
    content = content.replace(/\bawait sessionioMarkProcessing\(/g, 'markProcessing(');
    content = content.replace(/\bawait sessionioMarkCompleted\(/g, 'markCompleted(');
    content = content.replace(/\bawait sessionioMarkScriptSkipped\(/g, 'markScriptSkipped(');
    content = content.replace(/\bawait sessionioTouchHeartbeat\(/g, 'touchHeartbeat(');
    content = content.replace(
      /\(await getPendingMessages\(([^)]*)\)\)\.filter\(/g,
      'getPendingMessages($1).filter(',
    );
  }

  const names = ['poll-loop-peer'];
  if (
    isFullyPatched(content, names) &&
    content.includes('sessionioGetPendingMessages') &&
    content.includes('stageOutbox')
  ) {
    return content;
  }

  if (!content.includes(begin('poll-loop-peer-import'))) {
    const firstImport = content.search(/^import /m);
    if (firstImport < 0) throw new Error('Could not find import anchor for poll-loop-peer-import');
    const block = `${begin('poll-loop-peer-import')}
import fs from 'node:fs';
import path from 'node:path';
import { getSessionioPeer } from './sessionio/register.js';
import { inboundWireToRow, sessionRefFromEnv, writeToOutboundWire } from './sessionio/mailbox.js';
import { getConfig } from './config.js';
${end('poll-loop-peer-import')}
`;
    content = content.slice(0, firstImport) + block + content.slice(firstImport);
  }

  if (!content.includes(begin('poll-loop-peer'))) {
    const anchor = content.match(/^(export )?async function (poll|run|main)/m);
    if (anchor && anchor.index !== undefined) {
      content =
        content.slice(0, anchor.index) +
        marked(
          'poll-loop-peer',
          `// Lazily resolve peer — ESM import hoist runs this module before
// registerSessionioRunner() in index.ts, so a module-scope capture is always null.
function sessionioPeer() {
  return getSessionioPeer();
}

async function sessionioApplyHostMeta(
  peer: NonNullable<ReturnType<typeof getSessionioPeer>>,
  session: ReturnType<typeof sessionRefFromEnv>,
) {
  const meta = await peer.getMeta(session);
  try {
    const { getInboundDb } = await import('./db/connection.js');
    const db = getInboundDb();
    if (meta.routing) {
      db.prepare(
        \`INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
         VALUES (1, @channel_type, @platform_id, @thread_id)
         ON CONFLICT(id) DO UPDATE SET
           channel_type = excluded.channel_type,
           platform_id = excluded.platform_id,
           thread_id = excluded.thread_id\`,
      ).run(meta.routing);
    }
    if (meta.destinations) {
      const tx = db.transaction((rows: NonNullable<typeof meta.destinations>) => {
        db.prepare('DELETE FROM destinations').run();
        const stmt = db.prepare(
          \`INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
           VALUES (@name, @display_name, @type, @channel_type, @platform_id, @agent_group_id)\`,
        );
        for (const row of rows) stmt.run(row);
      });
      tx(meta.destinations);
    }
  } catch {
    // Local SQLite projection is best-effort (shared mount may already have routing).
  }
}

async function sessionioStageOutboxFiles(
  peer: NonNullable<ReturnType<typeof getSessionioPeer>>,
  session: ReturnType<typeof sessionRefFromEnv>,
  msg: { id: string; content: string },
) {
  let filenames: string[] = [];
  try {
    const parsed = JSON.parse(msg.content) as { files?: unknown };
    if (Array.isArray(parsed.files)) {
      filenames = parsed.files.filter((f): f is string => typeof f === 'string');
    }
  } catch {
    return;
  }
  if (filenames.length === 0) return;
  const outboxDir = path.join('/workspace/outbox', msg.id);
  const files: Array<{ name: string; data: string }> = [];
  for (const name of filenames) {
    const filePath = path.join(outboxDir, name);
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        files.push({ name, data: fs.readFileSync(filePath).toString('base64') });
      }
    } catch {
      // skip unreadable attachment
    }
  }
  if (files.length > 0) {
    await peer.stageOutbox(session, msg.id, files);
  }
}

async function sessionioGetPendingMessages(isFirstPoll = false) {
  const peer = sessionioPeer();
  if (!peer) return getPendingMessages(isFirstPoll);
  const session = sessionRefFromEnv(process.env, getConfig().agentGroupId);
  if (isFirstPoll) {
    try {
      await sessionioApplyHostMeta(peer, session);
    } catch {
      // Meta refresh must not block inbound poll.
    }
  }
  const limit = getConfig().maxMessagesPerPrompt;
  const messages = await peer.pollInbound(session, { limit, isFirstPoll });
  return messages.map(inboundWireToRow);
}

async function sessionioWriteMessageOut(msg: Parameters<typeof writeMessageOut>[0]) {
  const peer = sessionioPeer();
  if (!peer) return writeMessageOut(msg);
  const session = sessionRefFromEnv(process.env, getConfig().agentGroupId);
  await peer.postOutbound(session, writeToOutboundWire(msg));
  await sessionioStageOutboxFiles(peer, session, msg);
  return 0;
}

async function sessionioMarkProcessing(ids: string[]) {
  const peer = sessionioPeer();
  if (!peer) {
    markProcessing(ids);
    return;
  }
  if (ids.length === 0) return;
  const claimedAt = new Date().toISOString();
  await peer.postAcks(
    sessionRefFromEnv(process.env, getConfig().agentGroupId),
    ids.map((id) => ({ message_id: id, status: 'processing', claimed_at: claimedAt })),
  );
}

async function sessionioMarkCompleted(ids: string[]) {
  const peer = sessionioPeer();
  if (!peer) {
    markCompleted(ids);
    return;
  }
  if (ids.length === 0) return;
  const claimedAt = new Date().toISOString();
  await peer.postAcks(
    sessionRefFromEnv(process.env, getConfig().agentGroupId),
    ids.map((id) => ({ message_id: id, status: 'completed', claimed_at: claimedAt })),
  );
}

async function sessionioMarkScriptSkipped(skips: Array<{ id: string; reason: string }>) {
  const peer = sessionioPeer();
  if (!peer) {
    markScriptSkipped(skips);
    return;
  }
  if (skips.length === 0) return;
  const claimedAt = new Date().toISOString();
  await peer.postAcks(
    sessionRefFromEnv(process.env, getConfig().agentGroupId),
    skips.map((s) => ({
      message_id: s.id,
      status: s.reason === 'error' ? 'script-skip:error' : 'completed',
      claimed_at: claimedAt,
    })),
  );
}

async function sessionioTouchHeartbeat() {
  const peer = sessionioPeer();
  if (!peer) {
    touchHeartbeat();
    return;
  }
  await peer.heartbeat(sessionRefFromEnv(process.env, getConfig().agentGroupId));
}`,
        ) +
        '\n' +
        content.slice(anchor.index);
    }
  }

  // Rewire stock SQLite call sites (only after helpers) to the peer-aware wrappers.
  const peerEnd = end('poll-loop-peer');
  const peerEndIdx = content.indexOf(peerEnd);
  if (peerEndIdx >= 0) {
    const head = content.slice(0, peerEndIdx + peerEnd.length);
    let tail = content.slice(peerEndIdx + peerEnd.length);
    if (!tail.includes('await sessionioGetPendingMessages(')) {
      tail = tail.replace(/\bgetPendingMessages\(/g, 'await sessionioGetPendingMessages(');
      tail = tail.replace(/\bwriteMessageOut\(/g, 'await sessionioWriteMessageOut(');
      tail = tail.replace(/\bmarkProcessing\(/g, 'await sessionioMarkProcessing(');
      tail = tail.replace(/\bmarkCompleted\(/g, 'await sessionioMarkCompleted(');
      tail = tail.replace(/\bmarkScriptSkipped\(/g, 'await sessionioMarkScriptSkipped(');
      tail = tail.replace(/\btouchHeartbeat\(/g, 'await sessionioTouchHeartbeat(');
    }
    // await binds looser than member access: (await fn()).filter(...)
    tail = tail.replace(
      /await sessionioGetPendingMessages\(([^)]*)\)\.filter\(/g,
      '(await sessionioGetPendingMessages($1)).filter(',
    );
    // Sync helpers that call writeMessageOut must become async under peer mode.
    // In stock NanoClaw these sit *after* runPollLoop (same region as the rewrites).
    if (!tail.includes('async function deliverErrorResult(')) {
      tail = tail.replace(/^function deliverErrorResult\(/m, 'async function deliverErrorResult(');
    }
    if (!tail.includes('export async function dispatchResultText(')) {
      tail = tail.replace(
        /^export function dispatchResultText\(/m,
        'export async function dispatchResultText(',
      );
    }
    if (!tail.includes('export async function autoAppendTaskLog(')) {
      tail = tail.replace(
        /^export function autoAppendTaskLog\(/m,
        'export async function autoAppendTaskLog(',
      );
    }
    if (!tail.includes('async function sendToDestination(')) {
      tail = tail.replace(/^function sendToDestination\(/m, 'async function sendToDestination(');
    }
    if (!tail.includes('await dispatchResultText(')) {
      // Only call sites — do not rewrite `function deliverErrorResult(` declarations.
      tail = tail.replace(
        /(?<!function )(?<!await )dispatchResultText\(/g,
        'await dispatchResultText(',
      );
      tail = tail.replace(
        /(?<!function )(?<!await )autoAppendTaskLog\(/g,
        'await autoAppendTaskLog(',
      );
      tail = tail.replace(
        /(?<!function )(?<!await )deliverErrorResult\(/g,
        'await deliverErrorResult(',
      );
      tail = tail.replace(
        /(?<!function )(?<!await )sendToDestination\(/g,
        'await sendToDestination(',
      );
    }
    content = head + tail;
  }

  return content;
}

export function uninstallPollLoop(source: string): string {
  let content = uninstallMarks(source, ['poll-loop-peer', 'poll-loop-peer-import']);
  content = content.replace(/\bawait sessionioGetPendingMessages\(/g, 'getPendingMessages(');
  content = content.replace(/\bawait sessionioWriteMessageOut\(/g, 'writeMessageOut(');
  content = content.replace(/\bawait sessionioMarkProcessing\(/g, 'markProcessing(');
  content = content.replace(/\bawait sessionioMarkCompleted\(/g, 'markCompleted(');
  content = content.replace(/\bawait sessionioMarkScriptSkipped\(/g, 'markScriptSkipped(');
  content = content.replace(/\bawait sessionioTouchHeartbeat\(/g, 'touchHeartbeat(');
  return content;
}

const MESSAGES_OUT_PEER_HELPER = `function postOutboundSync(msg: WriteMessageOut): number {
  const peer = getSessionioPeer();
  if (!peer) {
    throw new Error('postOutboundSync called without sessionio peer');
  }
  let agentGroupId = '';
  try {
    agentGroupId = getConfig().agentGroupId;
  } catch {
    agentGroupId = '';
  }
  const session = sessionRefFromEnv(process.env, agentGroupId);
  const baseUrl = process.env.SESSIONIO_BASE_URL ?? '';
  const body = JSON.stringify(writeToOutboundWire(msg));
  const args = buildOutboundSyncCurlArgs({
    baseUrl,
    agentGroupId: session.agentGroupId,
    sessionId: session.sessionId,
    token: process.env.SESSIONIO_HTTP_TOKEN,
    body,
  });
  const env = clearedProxyEnv(process.env);
  const proc = Bun.spawnSync(args, {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = Number(proc.stdout.toString().trim());
  if (proc.exitCode !== 0 || (code !== 200 && code !== 204)) {
    const err = proc.stderr.toString().trim();
    throw new Error(\`sessionio postOutbound failed: http=\${code} exit=\${proc.exitCode} \${err}\`);
  }
  // Stage outbox attachments onto the HTTP mailbox (no shared mount required).
  try {
    const parsed = JSON.parse(msg.content) as { files?: unknown };
    const filenames = Array.isArray(parsed.files)
      ? parsed.files.filter((f): f is string => typeof f === 'string')
      : [];
    if (filenames.length > 0) {
      const fsSync = require('node:fs') as typeof import('node:fs');
      const files: Array<{ name: string; data: string }> = [];
      for (const name of filenames) {
        const filePath = \`/workspace/outbox/\${msg.id}/\${name}\`;
        try {
          if (fsSync.existsSync(filePath) && fsSync.statSync(filePath).isFile()) {
            files.push({ name, data: fsSync.readFileSync(filePath).toString('base64') });
          }
        } catch {
          // skip missing attachment
        }
      }
      if (files.length > 0) {
        void peer.stageOutbox(session, msg.id, files);
      }
    }
  } catch {
    // Attachment staging is best-effort on the sync curl bridge.
  }
  return 0;
}
`;

/** Route writeMessageOut through HTTP peer for MCP/agenttrace sync call sites. */
export function patchMessagesOut(source: string): string {
  const names = ['messages-out-import', 'messages-out-helper', 'messages-out-peer'];
  if (
    isFullyPatched(source, names) &&
    source.includes('buildOutboundSyncCurlArgs') &&
    source.includes('stageOutbox')
  ) {
    return source;
  }

  // Upgrade marked helpers that still inline curl argv (pre-outbound-sync helper),
  // or that post outbound without staging outbox attachments.
  let content = source;
  if (
    isFullyPatched(content, names) &&
    (!content.includes('buildOutboundSyncCurlArgs') || !content.includes('stageOutbox'))
  ) {
    content = uninstallMessagesOut(content);
  }

  // Sandbox may already have an unmarked peer bridge that uses the shared helper.
  if (
    content.includes('function postOutboundSync(') &&
    content.includes('getSessionioPeer()') &&
    content.includes('return postOutboundSync(msg)') &&
    content.includes('buildOutboundSyncCurlArgs') &&
    !content.includes(begin('messages-out-peer'))
  ) {
    return content;
  }

  if (!content.includes(begin('messages-out-import'))) {
    const firstImport = content.search(/^import /m);
    if (firstImport < 0) throw new Error('Could not find import anchor for messages-out-import');
    const block = `${begin('messages-out-import')}
import { getSessionioPeer } from '../sessionio/register.js';
import { sessionRefFromEnv, writeToOutboundWire } from '../sessionio/mailbox.js';
import { buildOutboundSyncCurlArgs, clearedProxyEnv } from '../sessionio/outbound-sync.js';
import { getConfig } from '../config.js';
${end('messages-out-import')}
`;
    content = content.slice(0, firstImport) + block + content.slice(firstImport);
  }

  if (!content.includes(begin('messages-out-helper'))) {
    const anchor = 'export function writeMessageOut(msg: WriteMessageOut): number {';
    if (!content.includes(anchor)) {
      throw new Error('Could not find writeMessageOut export anchor');
    }
    content = replaceOnce(
      content,
      anchor,
      `${marked('messages-out-helper', MESSAGES_OUT_PEER_HELPER)}\n\n${anchor}`,
      'messages-out writeMessageOut helper',
    );
  }

  if (!content.includes(begin('messages-out-peer'))) {
    const anchor = `export function writeMessageOut(msg: WriteMessageOut): number {
  const outbound = getOutboundDb();`;
    if (!content.includes(anchor)) {
      throw new Error('Could not find writeMessageOut body start anchor');
    }
    content = replaceOnce(
      content,
      anchor,
      `export function writeMessageOut(msg: WriteMessageOut): number {
${marked(
  'messages-out-peer',
  `  if (getSessionioPeer()) {
    return postOutboundSync(msg);
  }`,
)}
  const outbound = getOutboundDb();`,
      'messages-out writeMessageOut peer gate',
    );
  }

  return content;
}

export function uninstallMessagesOut(source: string): string {
  return uninstallMarks(source, [
    'messages-out-peer',
    'messages-out-helper',
    'messages-out-import',
  ]);
}

export const FILE_TRANSFORMS: FileTransform[] = [
  {
    path: 'src/session-manager.ts',
    transform: patchSessionManager,
    uninstall: uninstallSessionManager,
  },
  {
    path: 'src/delivery.ts',
    transform: patchDelivery,
    uninstall: (source) => {
      // Delivery uninstall cannot perfectly restore without stock; remove markers only.
      return uninstallDelivery(source);
    },
  },
  {
    path: 'src/host-sweep.ts',
    transform: patchHostSweep,
    uninstall: uninstallHostSweep,
  },
  {
    path: 'src/container-runner.ts',
    transform: patchContainerRunner,
    uninstall: uninstallContainerRunner,
  },
  {
    path: 'src/index.ts',
    transform: patchIndex,
    uninstall: uninstallIndex,
  },
  {
    path: 'container/agent-runner/src/index.ts',
    transform: patchRunnerIndex,
    uninstall: uninstallRunnerIndex,
  },
  {
    path: 'container/agent-runner/src/poll-loop.ts',
    transform: patchPollLoop,
    uninstall: uninstallPollLoop,
  },
  {
    path: 'container/agent-runner/src/db/messages-out.ts',
    transform: patchMessagesOut,
    uninstall: uninstallMessagesOut,
  },
];
