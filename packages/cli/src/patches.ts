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

/**
 * Shared body for projecting routing + destinations into the HTTP mailbox.
 * Used by both spawnContainer (container-runner-meta) and wakeContainer
 * (wake-prepare-meta) so the two call sites cannot drift.
 */
function buildSyncSessionMetaBlock(opts: {
  indent: string;
  agentGroupIdExpr: string;
  sessionIdExpr: string;
  threadIdExpr: string;
}): string {
  const i = opts.indent;
  const { agentGroupIdExpr: ag, sessionIdExpr: sid, threadIdExpr: tid } = opts;
  return `${i}{
${i}  const transport = resolveSessionTransport({
${i}    agentGroupId: ${ag},
${i}    sessionId: ${sid},
${i}  });
${i}  // Project host routing/destinations into the HTTP mailbox store (not {}).
${i}  let meta: {
${i}    routing: {
${i}      channel_type: string | null;
${i}      platform_id: string | null;
${i}      thread_id: string | null;
${i}    };
${i}    destinations?: Array<{
${i}      name: string;
${i}      display_name: string | null;
${i}      type: 'channel' | 'agent';
${i}      channel_type: string | null;
${i}      platform_id: string | null;
${i}      agent_group_id: string | null;
${i}    }>;
${i}  } = {
${i}    routing: {
${i}      channel_type: null,
${i}      platform_id: null,
${i}      thread_id: ${tid},
${i}    },
${i}  };
${i}  try {
${i}    const { openInboundDb } = await import('./session-manager.js');
${i}    const db = openInboundDb(${ag}, ${sid});
${i}    try {
${i}      const row = db
${i}        .prepare(
${i}          'SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1',
${i}        )
${i}        .get() as
${i}        | {
${i}            channel_type: string | null;
${i}            platform_id: string | null;
${i}            thread_id: string | null;
${i}          }
${i}        | undefined;
${i}      if (row) meta.routing = row;
${i}      meta.destinations = db
${i}        .prepare(
${i}          'SELECT name, display_name, type, channel_type, platform_id, agent_group_id FROM destinations ORDER BY name',
${i}        )
${i}        .all() as NonNullable<typeof meta.destinations>;
${i}    } finally {
${i}      db.close();
${i}    }
${i}  } catch {
${i}    // Session DB may not exist yet; still sync thread_id from the Session row.
${i}  }
${i}  void transport.syncSessionMeta?.(
${i}    { agentGroupId: ${ag}, sessionId: ${sid} },
${i}    meta,
${i}  );
${i}}`;
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
    // Allow extra blank lines after `}` — uninstall used to leave an extra newline and
    // a strict exact-string anchor then blocked reinstall.
    const bodyEndMatch = content.match(
      /  updateSession\(sessionId, \{ last_active: new Date\(\)\.toISOString\(\) \}\);\r?\n\}\r?\n+(\/\*\*\r?\n \* If message content has attachments with base64 `data`, save them to\r?\n \* the session's inbox directory and replace with (?:`localPath`|file paths)\.)/,
    );
    if (!bodyEndMatch || bodyEndMatch.index === undefined) {
      throw new Error('Could not find writeSessionMessage body end anchor');
    }
    const bodyEnd = bodyEndMatch[0];
    const docblockStart = bodyEndMatch[1];

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

${docblockStart}`,
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
  // Normalize spacing so a later install can re-find the body-end anchor.
  content = content.replace(
    /(  updateSession\(sessionId, \{ last_active: new Date\(\)\.toISOString\(\) \}\);\r?\n\})\r?\n+(?=\/\*\*)/,
    '$1\n\n',
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
  const names = ['delivery-import', 'delivery-drain', 'delivery-outbox'];
  let content = source;
  // Upgrade prior patch that continued with inDb=null / type-asserted deliverMessage.
  if (
    content.includes(begin('delivery-drain')) &&
    (content.includes('inDb as Database.Database') || content.includes('inDb?.close()'))
  ) {
    content = uninstallDelivery(content);
  }
  // Upgrade installs that have drain/import but not the marked delivery-outbox,
  // or that still carry an unmarked consumeOutbox hotfix body.
  if (
    isFullyPatched(content, ['delivery-import', 'delivery-drain']) &&
    !content.includes(begin('delivery-outbox'))
  ) {
    content = uninstallDelivery(content);
  }
  if (isFullyPatched(content, names) && content.includes('consumeOutbox')) return content;

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

  content = scavengeUnmarkedDeliveryOutbox(content);
  if (!content.includes(begin('delivery-outbox'))) {
    content = replaceOnce(
      content,
      STOCK_DELIVERY_OUTBOX,
      marked('delivery-outbox', PATCHED_DELIVERY_OUTBOX),
      'delivery outbox attachment staging',
    );
  }

  return content;
}

/**
 * Locate the real `deliverMessage` declaration to splice `drainSession` before.
 * Fixtures (and some forks) also have an early single-line stub — never use the
 * first `indexOf('async function deliverMessage(')` match.
 */
function findDeliverMessageInsertIndex(content: string): number {
  // Prefer the typed host signature (multi-line params).
  const typed = content.search(
    /async function deliverMessage\(\s*\r?\n\s*msg:\s*\{/,
  );
  if (typed >= 0) return typed;
  // Fall back to the last declaration when only stubs/variants exist.
  const last = content.lastIndexOf('async function deliverMessage(');
  if (last >= 0) return last;
  return -1;
}

export function uninstallDelivery(source: string): string {
  let content = uninstallMarks(source, ['delivery-outbox', 'delivery-drain', 'delivery-import']);
  content = scavengeUnmarkedDeliveryOutbox(content);
  if (!content.includes('async function drainSession(session: Session): Promise<void>')) {
    const idx = findDeliverMessageInsertIndex(content);
    if (idx < 0) throw new Error('Could not restore drainSession: deliverMessage anchor missing');
    // Mark removal can leave extra blank lines where the drain block was —
    // normalize to a single blank line before the restored stock drain.
    const before = content.slice(0, idx).replace(/\n+$/, '\n\n');
    content = `${before}${STOCK_DRAIN_SESSION}\n\n${content.slice(idx)}`;
  }
  // Marked delivery-outbox removal deletes the whole block — put stock back.
  if (
    !content.includes('readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files')
  ) {
    const anchors = [
      '// @nanoclaw-hosthooks:delivery-transform:begin',
      '  const deliverContent =',
      '  const platformMsgId = await deliveryAdapter.deliver(',
      '  void files;',
    ];
    let inserted = false;
    for (const anchor of anchors) {
      const idx = content.indexOf(anchor);
      if (idx >= 0) {
        content = `${content.slice(0, idx)}${STOCK_DELIVERY_OUTBOX}\n${content.slice(idx)}`;
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      throw new Error('Could not restore stock delivery outbox after uninstall');
    }
  }
  return content;
}

/** Stock NanoClaw outbox read (filesystem mount only). */
export const STOCK_DELIVERY_OUTBOX = `  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;
`;

/** HTTP/loopback: consume staged mailbox bytes, then fall back to disk. */
export const PATCHED_DELIVERY_OUTBOX = `  // Read file attachments from outbox if the content declares files.
  // HTTP/loopback agents stage bytes on the host mailbox (no shared mount);
  // filesystem agents write under the session outbox dir. Prefer the transport
  // store, then fall back to disk for stock mounts.
  let files: OutboundFile[] | undefined;
  if (Array.isArray(content.files) && content.files.length > 0) {
    const transport = resolveSessionTransport({
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
    });
    const sessionRef = {
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
    };
    // Brief retry: MCP used to POST /outbound before /outbox; give staging a
    // moment so we don't deliver a declared attachment as text-only.
    let fromMailbox: OutboundFile[] = [];
    for (let attempt = 0; attempt < 5 && fromMailbox.length === 0; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 150));
      const staged = await Promise.resolve(transport.consumeOutbox(sessionRef, msg.id));
      fromMailbox = staged
        .filter(
          (f): f is { name: string; data: string } =>
            typeof f.name === 'string' &&
            f.name.length > 0 &&
            typeof f.data === 'string',
        )
        .map((f) => ({
          filename: f.name,
          data: Buffer.from(f.data, 'base64'),
        }));
    }
    files =
      fromMailbox.length > 0
        ? fromMailbox
        : readOutboxFiles(
            session.agent_group_id,
            session.id,
            msg.id,
            content.files as string[],
          );
    if (!files || files.length === 0) {
      log.warn('Outbound declared files but none were staged or on disk', {
        messageId: msg.id,
        sessionId: session.id,
        declared: content.files,
      });
    }
  }
`;

/**
 * Replace unmarked consumeOutbox attachment blocks (manual hotfixes) with stock
 * readOutboxFiles. No-op when the marked delivery-outbox block is present.
 */
export function scavengeUnmarkedDeliveryOutbox(source: string): string {
  if (source.includes(begin('delivery-outbox'))) return source;
  if (!source.includes('consumeOutbox')) {
    // Ensure stock block exists when someone deleted it entirely after a bad uninstall.
    return source;
  }
  // Match from the outbox comment through the end of the files if-block.
  const pattern =
    /  \/\/ Read file attachments from outbox if the content declares files\.\r?\n(?:  \/\/[^\n]*\r?\n)*  let files: OutboundFile\[\] \| undefined;\r?\n  if \(Array\.isArray\(content\.files\) && content\.files\.length > 0\) \{[\s\S]*?consumeOutbox[\s\S]*?\n  \}\r?\n/;
  const next = source.replace(pattern, STOCK_DELIVERY_OUTBOX);
  if (next === source) {
    throw new Error(
      'Could not scavenge unmarked delivery outbox (consumeOutbox present but pattern mismatch)',
    );
  }
  return next;
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

  // Stock writeSessionRouting must stay OUTSIDE the marker — uninstallMarks would
  // otherwise delete it (same failure mode as index delivery polls).
  if (!content.includes('writeSessionRouting(agentGroup.id, session.id);')) {
    if (!content.includes(spawnLog)) {
      throw new Error('Could not find container-runner writeSessionRouting or spawn log anchor');
    }
    content = replaceOnce(
      content,
      spawnLog,
      `  writeSessionRouting(agentGroup.id, session.id);\n\n${spawnLog}`,
      'container-runner restore writeSessionRouting',
    );
  }

  if (!content.includes(begin('container-runner-meta'))) {
    content = replaceOnce(
      content,
      `  writeSessionRouting(agentGroup.id, session.id);`,
      `  writeSessionRouting(agentGroup.id, session.id);
${marked(
  'container-runner-meta',
  buildSyncSessionMetaBlock({
    indent: '  ',
    agentGroupIdExpr: 'agentGroup.id',
    sessionIdExpr: 'session.id',
    threadIdExpr: 'session.thread_id ?? null',
  }),
)}`,
      'container-runner writeSessionRouting',
    );
  }

  // Process/other runtimes skip spawnContainer — project mailbox meta on every wake.
  // Slot comment is owned by agenthosts (must not use :begin/:end or the install
  // guard would see the empty slot as already installed and skip injection).
  const wakeMetaSlot = '    // @nanoclaw-sessionio:wake-prepare-meta-slot';
  if (content.includes(wakeMetaSlot) && !content.includes(begin('wake-prepare-meta'))) {
    content = replaceOnce(
      content,
      wakeMetaSlot,
      marked(
        'wake-prepare-meta',
        buildSyncSessionMetaBlock({
          indent: '    ',
          agentGroupIdExpr: 'session.agent_group_id',
          sessionIdExpr: 'session.id',
          threadIdExpr: 'session.thread_id ?? null',
        }),
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
  let next = uninstallMarks(source, [
    'container-runner-env',
    'container-runner-meta',
    'container-runner-docker-env-import',
    'container-runner-import',
  ]);
  // Restore the agenthosts-owned slot so a later sessionio install can re-inject.
  if (next.includes(begin('wake-prepare-meta'))) {
    next = next.replace(
      new RegExp(
        `^[ \\t]*${escapeRegExp(begin('wake-prepare-meta'))}\\r?\\n[\\s\\S]*?^[ \\t]*${escapeRegExp(end('wake-prepare-meta'))}\\r?\\n?`,
        'm',
      ),
      '    // @nanoclaw-sessionio:wake-prepare-meta-slot\n',
    );
  }
  // Older installs put writeSessionRouting inside container-runner-meta; restore it.
  const spawnLog =
    "  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });";
  if (
    !next.includes('writeSessionRouting(agentGroup.id, session.id);') &&
    next.includes(spawnLog)
  ) {
    next = next.replace(
      spawnLog,
      `  writeSessionRouting(agentGroup.id, session.id);\n\n${spawnLog}`,
    );
  }
  return next;
}

export function patchIndex(source: string): string {
  const names = ['index-boot'];
  if (isFullyPatched(source, names)) return source;

  const anchor = `  startActiveDeliveryPoll();
  startSweepDeliveryPoll();`;
  if (!source.includes(anchor)) {
    throw new Error('Could not find index.ts delivery poll boot anchor');
  }

  // Only sessionio boot lives inside the marker. Stock delivery poll starts must
  // stay outside — uninstallMarks would otherwise delete them and leave the host
  // logging "Delivery polls started" without ever calling the poll functions.
  return replaceOnce(
    source,
    anchor,
    `${marked(
      'index-boot',
      `  {
    const { startSessionio } = await import('./sessionio-boot.js');
    await startSessionio();
  }`,
    )}
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();`,
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

/** Marked MCP-child peer registration (send_file / sync outbound bridge). */
export function patchMcpToolsIndex(source: string): string {
  const names = ['mcp-register'];
  if (isFullyPatched(source, names)) return source;
  let content = scavengeUnmarkedMcpSessionioRegister(source);
  /* v8 ignore next — scavenge returns early when marked; isFullyPatched already handled that */
  if (content.includes(begin('mcp-register'))) return content;

  const firstImport = content.search(/^import /m);
  if (firstImport < 0) throw new Error('Could not find mcp-tools import anchor');
  const block = `${begin('mcp-register')}
// Sessionio peer registration is optional here: writeMessageOut gates on
// SESSIONIO_TRANSPORT via isRemotePeerMode(). Still register so peer-aware
// call sites (if any) work inside the MCP child process.
import { registerSessionioRunner } from '../sessionio/register.js';
registerSessionioRunner();
${end('mcp-register')}
`;
  return content.slice(0, firstImport) + block + content.slice(firstImport);
}

/**
 * Strip unmarked MCP registerSessionioRunner boots left by pre-marker installs.
 */
export function scavengeUnmarkedMcpSessionioRegister(source: string): string {
  if (source.includes(begin('mcp-register'))) return source;
  if (!source.includes("from '../sessionio/register.js'")) return source;
  const pattern =
    /(?:\/\/ Sessionio peer registration is optional here:[\s\S]*?\n)?import \{ registerSessionioRunner \} from '\.\.\/sessionio\/register\.js';\r?\nregisterSessionioRunner\(\);\r?\n+/;
  const next = source.replace(pattern, '');
  if (next === source) {
    throw new Error(
      'Could not scavenge unmarked mcp-tools registerSessionioRunner (present but pattern mismatch)',
    );
  }
  return next;
}

export function uninstallMcpToolsIndex(source: string): string {
  let content = uninstallMarks(source, ['mcp-register']);
  content = scavengeUnmarkedMcpSessionioRegister(content);
  return content;
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
    content = content.replace(/\bsessionioGetPendingMessages\(/g, 'getPendingMessages(');
    content = content.replace(/\bawait sessionioWriteMessageOut\(/g, 'writeMessageOut(');
    content = content.replace(/\bsessionioWriteMessageOut\(/g, 'writeMessageOut(');
    content = content.replace(/\bawait sessionioMarkProcessing\(/g, 'markProcessing(');
    content = content.replace(/\bsessionioMarkProcessing\(/g, 'markProcessing(');
    content = content.replace(/\bawait sessionioMarkCompleted\(/g, 'markCompleted(');
    content = content.replace(/\bsessionioMarkCompleted\(/g, 'markCompleted(');
    content = content.replace(/\bawait sessionioMarkScriptSkipped\(/g, 'markScriptSkipped(');
    content = content.replace(/\bsessionioMarkScriptSkipped\(/g, 'markScriptSkipped(');
    content = content.replace(/\bawait sessionioTouchHeartbeat\(/g, 'touchHeartbeat(');
    content = content.replace(/\bsessionioTouchHeartbeat\(/g, 'touchHeartbeat(');
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
  // Restore stock call sites. Match both `await sessionioX(` (normal install)
  // and bare `sessionioX(` / `return sessionioX(...).then(...)` leftovers from
  // partial uninstalls or hand-edited async wrappers.
  const wrappers: Array<[string, string]> = [
    ['sessionioGetPendingMessages', 'getPendingMessages'],
    ['sessionioWriteMessageOut', 'writeMessageOut'],
    ['sessionioMarkProcessing', 'markProcessing'],
    ['sessionioMarkCompleted', 'markCompleted'],
    ['sessionioMarkScriptSkipped', 'markScriptSkipped'],
    ['sessionioTouchHeartbeat', 'touchHeartbeat'],
  ];
  for (const [from, to] of wrappers) {
    content = content.replace(new RegExp(`\\bawait ${from}\\(`, 'g'), `${to}(`);
    content = content.replace(new RegExp(`\\b${from}\\(`, 'g'), `${to}(`);
  }
  content = content.replace(
    /return writeMessageOut\((\{[\s\S]*?\n  \})\)\.then\(\(\) => undefined\);/g,
    'writeMessageOut($1);',
  );
  return content;
}

const MESSAGES_OUT_PEER_HELPER = `function postOutboundSync(msg: WriteMessageOut): number {
  // Gate on transport env — MCP tools run in a child process that never
  // calls registerSessionioRunner(), so getSessionioPeer() is always null there.
  if (!isRemotePeerMode()) {
    throw new Error('postOutboundSync called without SESSIONIO_TRANSPORT=http|loopback');
  }
  let agentGroupId = '';
  try {
    agentGroupId = getConfig().agentGroupId;
  } catch {
    agentGroupId = '';
  }
  const session = sessionRefFromEnv(process.env, agentGroupId);
  const baseUrl = process.env.SESSIONIO_BASE_URL ?? '';
  const env = clearedProxyEnv(process.env);

  // Stage attachments FIRST. If we POST /outbound before /outbox, the host
  // delivery poll can consume the message with an empty mailbox and drop files.
  let filenames: string[] = [];
  try {
    const parsed = JSON.parse(msg.content) as { files?: unknown };
    filenames = Array.isArray(parsed.files)
      ? parsed.files.filter((f): f is string => typeof f === 'string')
      : [];
  } catch {
    // Malformed content — still allow text-only outbound below.
  }
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
      const outboxBody = JSON.stringify({ messageId: msg.id, files });
      const outboxArgs = buildOutboxSyncCurlArgs({
        baseUrl,
        agentGroupId: session.agentGroupId,
        sessionId: session.sessionId,
        token: process.env.SESSIONIO_HTTP_TOKEN,
        body: outboxBody,
      });
      const outboxProc = Bun.spawnSync(outboxArgs, {
        env,
        // Bun.spawnSync rejects string stdin ("stdio must be an array…"); bytes work.
        stdin: new TextEncoder().encode(outboxBody),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const outboxCode = Number(outboxProc.stdout.toString().trim());
      if (outboxProc.exitCode !== 0 || (outboxCode !== 200 && outboxCode !== 204)) {
        const err = outboxProc.stderr.toString().trim();
        throw new Error(
          \`sessionio stageOutbox failed: http=\${outboxCode} exit=\${outboxProc.exitCode} \${err}\`,
        );
      }
    }
  }

  const body = JSON.stringify(writeToOutboundWire(msg));
  const args = buildOutboundSyncCurlArgs({
    baseUrl,
    agentGroupId: session.agentGroupId,
    sessionId: session.sessionId,
    token: process.env.SESSIONIO_HTTP_TOKEN,
    body,
  });
  const proc = Bun.spawnSync(args, {
    env,
    stdin: new TextEncoder().encode(body),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = Number(proc.stdout.toString().trim());
  if (proc.exitCode !== 0 || (code !== 200 && code !== 204)) {
    const err = proc.stderr.toString().trim();
    throw new Error(\`sessionio postOutbound failed: http=\${code} exit=\${proc.exitCode} \${err}\`);
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
    source.includes('buildOutboxSyncCurlArgs') &&
    source.includes('isRemotePeerMode()') &&
    source.includes('TextEncoder().encode(outboxBody)') &&
    source.includes('TextEncoder().encode(body)')
  ) {
    return source;
  }

  // Upgrade marked helpers that still gate on getSessionioPeer (MCP child has no peer),
  // inline curl argv / -d body, or post outbound without staging outbox attachments first.
  let content = source;
  if (
    isFullyPatched(content, names) &&
    (!content.includes('buildOutboundSyncCurlArgs') ||
      !content.includes('buildOutboxSyncCurlArgs') ||
      !content.includes('isRemotePeerMode()') ||
      !content.includes('TextEncoder().encode(outboxBody)') ||
      !content.includes('TextEncoder().encode(body)'))
  ) {
    content = uninstallMessagesOut(content);
  }

  // Sandbox may already have an unmarked peer bridge that uses the shared helper.
  if (
    content.includes('function postOutboundSync(') &&
    content.includes('isRemotePeerMode()') &&
    content.includes('return postOutboundSync(msg)') &&
    content.includes('buildOutboundSyncCurlArgs') &&
    content.includes('buildOutboxSyncCurlArgs') &&
    content.includes('TextEncoder().encode(body)') &&
    !content.includes(begin('messages-out-peer'))
  ) {
    return content;
  }

  // Legacy unmarked bridges (getSessionioPeer / stageOutbox / missing outbox-first)
  // must be removed before we inject the marked helper — otherwise TS sees two
  // `function postOutboundSync` declarations in the same module.
  if (
    content.includes('function postOutboundSync(') &&
    !content.includes(begin('messages-out-helper'))
  ) {
    content = stripUnmarkedMessagesOutBridge(content);
  }

  if (!content.includes(begin('messages-out-import'))) {
    const firstImport = content.search(/^import /m);
    if (firstImport < 0) throw new Error('Could not find import anchor for messages-out-import');
    const block = `${begin('messages-out-import')}
import { isRemotePeerMode } from '../sessionio/register.js';
import { sessionRefFromEnv, writeToOutboundWire } from '../sessionio/mailbox.js';
import { buildOutboundSyncCurlArgs, buildOutboxSyncCurlArgs, clearedProxyEnv } from '../sessionio/outbound-sync.js';
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
  `  if (isRemotePeerMode()) {
    return postOutboundSync(msg);
  }`,
)}
  const outbound = getOutboundDb();`,
      'messages-out writeMessageOut peer gate',
    );
  }

  return content;
}

/**
 * Remove a hand-maintained (unmarked) postOutboundSync + peer gate so the
 * marked installer can re-inject without duplicate declarations.
 */
function stripUnmarkedMessagesOutBridge(source: string): string {
  let content = source;
  content = content.replace(
    /^[ \t]*if \((?:getSessionioPeer|isRemotePeerMode)\(\)\) \{\n[ \t]*return postOutboundSync\(msg\);\n[ \t]*\}\n?/gm,
    '',
  );

  const start = content.search(/^function postOutboundSync\(/m);
  /* v8 ignore next — gate-only leftovers after strip; callers require a function */
  if (start < 0) return content;
  const braceOpen = content.indexOf('{', start);
  /* v8 ignore next — malformed signatures without a body */
  if (braceOpen < 0) return content;
  let depth = 0;
  let i = braceOpen;
  for (; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  let end = i;
  while (content[end] === '\n') end += 1;
  return content.slice(0, start) + content.slice(end);
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
    path: 'container/agent-runner/src/mcp-tools/index.ts',
    transform: patchMcpToolsIndex,
    uninstall: uninstallMcpToolsIndex,
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
