/**
 * Convert v1 Claude SDK transcripts (`.jsonl`) into v2 `conversations/*.md`.
 *
 * The upstream `migrate-from-v1` flow does NOT carry over conversation
 * history. v1's `store/messages.db` only persisted the user side (every
 * row has `is_from_me=0`); the bot's replies live only in the SDK
 * transcripts at `data/sessions/<folder>/.claude/projects/-workspace-group/*.jsonl`.
 *
 * Output matches the format produced by `formatTranscriptMarkdown` in
 * `container/agent-runner/src/providers/claude.ts` so it slots into the same
 * `conversations/` system the running agent already maintains via PreCompact.
 *
 * Mapping: each v1 group folder name (e.g. `main`, `sonya`) maps 1:1 to a v2
 * group folder under `groups/<folder>/conversations/`. Files that already
 * exist are skipped — re-running is safe.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-v1-history.ts \
 *     --v1-root ~/nanoclaw-backups/pre-v2-migration-20260502-091539 \
 *     [--groups-dir groups]   # default: ./groups
 *     [--dry-run]
 *
 * Run AFTER `bash nanoclaw.sh` (which invokes the v1 migrator + populates
 * `groups/<folder>/`). The script refuses to write into a group folder that
 * doesn't exist on the v2 side.
 */
import fs from 'fs';
import path from 'path';

interface CliArgs {
  v1Root: string;
  groupsDir: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let v1Root = '';
  let groupsDir = path.resolve(process.cwd(), 'groups');
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--v1-root') v1Root = path.resolve(expandHome(argv[++i] ?? ''));
    else if (a === '--groups-dir') groupsDir = path.resolve(expandHome(argv[++i] ?? ''));
    else if (a === '--dry-run') dryRun = true;
    else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  if (!v1Root) {
    console.error('Missing required --v1-root <path>');
    printUsage();
    process.exit(2);
  }
  return { v1Root, groupsDir, dryRun };
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(process.env.HOME ?? '', p.slice(2));
  return p;
}

function printUsage(): void {
  console.error(
    'Usage: pnpm exec tsx scripts/backfill-v1-history.ts --v1-root <path> [--groups-dir <path>] [--dry-run]',
  );
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface SessionTranscript {
  sessionId: string;
  startedAt: string | null;
  messages: ParsedMessage[];
}

/**
 * Strip v1's `<messages><message sender="X" time="Y">…</message></messages>`
 * wrapper that the v1 host injected around every user prompt. We keep just
 * the inner text so the archived transcript reads naturally.
 */
function unwrapV1User(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<messages>')) return text;
  const out: string[] = [];
  const re = /<message\b[^>]*>([\s\S]*?)<\/message>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    out.push(m[1].trim());
  }
  return out.length > 0 ? out.join('\n\n') : text;
}

function parseTranscript(jsonlPath: string): SessionTranscript | null {
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const messages: ParsedMessage[] = [];
  let sessionId = path.basename(jsonlPath, '.jsonl');
  let startedAt: string | null = null;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      sessionId?: string;
      timestamp?: string;
      message?: {
        role?: string;
        content?: unknown;
      };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.sessionId) sessionId = entry.sessionId;
    if (!startedAt && entry.timestamp) startedAt = entry.timestamp;

    if (entry.type === 'user' && entry.message?.content !== undefined) {
      const raw =
        typeof entry.message.content === 'string'
          ? entry.message.content
          : Array.isArray(entry.message.content)
            ? entry.message.content
                .map((c: { text?: string }) => c?.text ?? '')
                .join('')
            : '';
      const text = unwrapV1User(raw).trim();
      if (text) messages.push({ role: 'user', content: text, timestamp: entry.timestamp });
    } else if (entry.type === 'assistant' && entry.message?.content !== undefined) {
      const arr = Array.isArray(entry.message.content) ? entry.message.content : [];
      const text = arr
        .filter((c: { type?: string }) => c?.type === 'text')
        .map((c: { text?: string }) => c?.text ?? '')
        .join('')
        .trim();
      if (text) messages.push({ role: 'assistant', content: text, timestamp: entry.timestamp });
    }
  }

  return messages.length > 0 ? { sessionId, startedAt, messages } : null;
}

/**
 * Mirrors `formatTranscriptMarkdown` in claude.ts so the produced files are
 * indistinguishable from ones the agent itself archives via PreCompact.
 */
function formatMarkdown(transcript: SessionTranscript): string {
  const startStr = transcript.startedAt
    ? new Date(transcript.startedAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : 'unknown';
  const lines: string[] = [
    `# v1 conversation ${transcript.sessionId}`,
    '',
    `Started: ${startStr}`,
    `Source: v1 SDK transcript (imported by scripts/backfill-v1-history.ts)`,
    '',
    '---',
    '',
  ];
  for (const msg of transcript.messages) {
    const sender = msg.role === 'user' ? 'User' : 'Assistant';
    const body = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '…' : msg.content;
    lines.push(`**${sender}**: ${body}`, '');
  }
  return lines.join('\n');
}

interface PerFolderStats {
  folder: string;
  totalJsonl: number;
  written: number;
  skipped: number;
  empty: number;
}

function processFolder(args: {
  v1Root: string;
  v1Folder: string;
  v2GroupDir: string;
  dryRun: boolean;
}): PerFolderStats {
  const stats: PerFolderStats = {
    folder: args.v1Folder,
    totalJsonl: 0,
    written: 0,
    skipped: 0,
    empty: 0,
  };

  const projectsDir = path.join(
    args.v1Root,
    'data',
    'sessions',
    args.v1Folder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  if (!fs.existsSync(projectsDir)) {
    console.warn(`  ⚠ no transcripts at ${projectsDir} — skipping`);
    return stats;
  }

  const conversationsDir = path.join(args.v2GroupDir, 'conversations');
  if (!args.dryRun) fs.mkdirSync(conversationsDir, { recursive: true });

  const files = fs
    .readdirSync(projectsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(projectsDir, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

  stats.totalJsonl = files.length;

  for (const jsonlPath of files) {
    const sessionId = path.basename(jsonlPath, '.jsonl');
    const outName = `v1-${sessionId}.md`;
    const outPath = path.join(conversationsDir, outName);
    if (fs.existsSync(outPath)) {
      stats.skipped += 1;
      continue;
    }
    const transcript = parseTranscript(jsonlPath);
    if (!transcript) {
      stats.empty += 1;
      continue;
    }
    if (args.dryRun) {
      console.log(`  [dry-run] would write ${outPath} (${transcript.messages.length} msgs)`);
    } else {
      fs.writeFileSync(outPath, formatMarkdown(transcript));
    }
    stats.written += 1;
  }

  return stats;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.v1Root)) {
    console.error(`v1 root not found: ${args.v1Root}`);
    process.exit(1);
  }
  if (!fs.existsSync(args.groupsDir)) {
    console.error(`v2 groups dir not found: ${args.groupsDir} — run the migrator first.`);
    process.exit(1);
  }

  const v1SessionsDir = path.join(args.v1Root, 'data', 'sessions');
  if (!fs.existsSync(v1SessionsDir)) {
    console.error(`v1 sessions dir not found: ${v1SessionsDir}`);
    process.exit(1);
  }

  const v1Folders = fs
    .readdirSync(v1SessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log(`v1 root:    ${args.v1Root}`);
  console.log(`v2 groups:  ${args.groupsDir}`);
  console.log(`mode:       ${args.dryRun ? 'dry-run' : 'write'}`);
  console.log(`v1 folders: ${v1Folders.join(', ') || '(none)'}`);
  console.log('');

  const allStats: PerFolderStats[] = [];

  for (const v1Folder of v1Folders) {
    const v2GroupDir = path.join(args.groupsDir, v1Folder);
    console.log(`▸ ${v1Folder}`);
    if (!fs.existsSync(v2GroupDir)) {
      console.log(`  skipping — no matching v2 folder at ${v2GroupDir}`);
      continue;
    }
    const stats = processFolder({
      v1Root: args.v1Root,
      v1Folder,
      v2GroupDir,
      dryRun: args.dryRun,
    });
    allStats.push(stats);
    console.log(
      `  ${stats.totalJsonl} transcripts → ${stats.written} written, ${stats.skipped} skipped (already converted), ${stats.empty} empty`,
    );
  }

  console.log('');
  console.log('Summary:');
  let totalWritten = 0;
  let totalSkipped = 0;
  for (const s of allStats) {
    totalWritten += s.written;
    totalSkipped += s.skipped;
    console.log(`  ${s.folder.padEnd(20)} written=${s.written} skipped=${s.skipped} empty=${s.empty}`);
  }
  console.log(`  total written: ${totalWritten}`);
  console.log(`  total skipped: ${totalSkipped}`);
  if (args.dryRun) {
    console.log('  (dry-run — no files actually written)');
  }
}

main();
