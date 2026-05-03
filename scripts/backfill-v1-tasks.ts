/**
 * Port v1 scheduled_tasks (active only) into v2 messages_in for a target
 * agent group. Companion to backfill-v1-history.ts — this one handles the
 * cron jobs the upstream migrator would have ported, but only when the
 * full migrator runs against a v1 install. Useful when v2 was set up via
 * the fresh/Advanced flow (no migrator) and the user wants the v1 cron
 * tasks back without re-running the whole migration.
 *
 * Translates v1 prompt paths to v2 layout:
 *   /workspace/group/                → /workspace/agent/
 *   /workspace/mike-personal-workspace/ → /workspace/extra/my-workspace/
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-v1-tasks.ts \
 *     --v1-db ~/nanoclaw-backups/pre-v2-migration-20260502-091539/store/messages.db \
 *     --target-folder dm-with-mike \
 *     --channel telegram \
 *     --platform-id telegram:190301535
 *     [--dry-run]
 */
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { getMessagingGroupByPlatform } from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import { openInboundDb, resolveSession } from '../src/session-manager.js';

interface V1Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  last_run: string | null;
  status: string;
  context_mode: string | null;
  script: string | null;
}

interface CliArgs {
  v1Db: string;
  targetFolder: string;
  channelType: string;
  platformId: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--v1-db') args.v1Db = expandHome(argv[++i] ?? '');
    else if (a === '--target-folder') args.targetFolder = argv[++i];
    else if (a === '--channel') args.channelType = argv[++i];
    else if (a === '--platform-id') args.platformId = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    }
  }
  for (const k of ['v1Db', 'targetFolder', 'channelType', 'platformId'] as const) {
    if (!args[k]) {
      console.error(`Missing required --${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`);
      printUsage();
      process.exit(2);
    }
  }
  return args as CliArgs;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(process.env.HOME ?? '', p.slice(2));
  return p;
}

function printUsage(): void {
  console.error(
    'Usage: tsx scripts/backfill-v1-tasks.ts --v1-db <path> --target-folder <folder> --channel <type> --platform-id <id> [--dry-run]',
  );
}

/** v2 path-layout translation for prompts written against v1 paths. */
function translatePaths(prompt: string): string {
  return prompt
    .replaceAll('/workspace/mike-personal-workspace/', '/workspace/extra/my-workspace/')
    .replaceAll('/workspace/group/', '/workspace/agent/');
}

function toRecurrenceAndProcessAfter(t: V1Task): { processAfter: string; recurrence: string | null } | null {
  const now = new Date().toISOString();
  if (t.schedule_type === 'cron') {
    const fields = t.schedule_value.trim().split(/\s+/).length;
    if (fields < 5 || fields > 6) return null;
    return { processAfter: t.next_run || now, recurrence: t.schedule_value.trim() };
  }
  if (t.schedule_type === 'once' || t.schedule_type === 'at') {
    return { processAfter: t.next_run || t.schedule_value || now, recurrence: null };
  }
  return null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const v1 = new Database(args.v1Db, { readonly: true, fileMustExist: true });
  const tasks = v1.prepare("SELECT * FROM scheduled_tasks WHERE status = 'active'").all() as V1Task[];
  v1.close();
  console.log(`Found ${tasks.length} active task(s) in v1.`);

  const v2Path = path.join(DATA_DIR, 'v2.db');
  const v2 = initDb(v2Path);
  runMigrations(v2);

  const ag = getAgentGroupByFolder(args.targetFolder);
  if (!ag) {
    console.error(`No agent group with folder "${args.targetFolder}" — aborting.`);
    process.exit(1);
  }
  const mg = getMessagingGroupByPlatform(args.channelType, args.platformId);
  if (!mg) {
    console.error(`No messaging group for ${args.channelType} / ${args.platformId} — aborting.`);
    process.exit(1);
  }

  const { session } = resolveSession(ag.id, mg.id, null, 'shared');

  let migrated = 0;
  let skippedExists = 0;
  let skippedShape = 0;

  const inbox = openInboundDb(ag.id, session.id);
  try {
    for (const t of tasks) {
      const sched = toRecurrenceAndProcessAfter(t);
      if (!sched) {
        console.log(`  skip (bad shape): ${t.id} type=${t.schedule_type} value=${t.schedule_value}`);
        skippedShape++;
        continue;
      }
      const existing = inbox.prepare("SELECT id FROM messages_in WHERE id = ? AND kind = 'task'").get(t.id) as
        | { id: string }
        | undefined;
      if (existing) {
        console.log(`  skip (already migrated): ${t.id}`);
        skippedExists++;
        continue;
      }

      const translatedPrompt = translatePaths(t.prompt);
      const content = JSON.stringify({
        prompt: translatedPrompt,
        script: t.script ?? null,
        migrated_from_v1: { original_id: t.id, original_folder: t.group_folder, schedule: t.schedule_value },
      });

      console.log(
        `  ${args.dryRun ? '[dry] ' : ''}migrate ${t.id} cron="${sched.recurrence}" nextRun=${sched.processAfter}`,
      );
      if (!args.dryRun) {
        insertTask(inbox, {
          id: t.id,
          processAfter: sched.processAfter,
          recurrence: sched.recurrence,
          platformId: args.platformId,
          channelType: args.channelType,
          threadId: null,
          content,
        });
      }
      migrated++;
    }
  } finally {
    inbox.close();
  }

  closeDb();

  console.log('');
  console.log(`Summary: migrated=${migrated} skipped(exists)=${skippedExists} skipped(shape)=${skippedShape}`);
  if (args.dryRun) console.log('(dry-run — no rows actually inserted)');
}

main();
