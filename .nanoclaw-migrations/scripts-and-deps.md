# Scripts and dependencies

## S-1: scripts/register-sonya.ts

**Intent:** One-time script that registers the Sonya sub-agent on the Telegram chat and ensures Sam has the right model. Re-running the script updates models without losing other registration fields.

**Files:** `scripts/register-sonya.ts`

**Detail tier:** Non-standard

**How to apply:**

Create `scripts/register-sonya.ts`:

```ts
import { initDatabase, setRegisteredGroup, getRegisteredGroup } from '../src/db.js';

initDatabase();

const sonyaJid = 'tg:190301535#sonya';
const existing = getRegisteredGroup(sonyaJid);
if (existing) {
  setRegisteredGroup(sonyaJid, {
    ...existing,
    model: 'claude-opus-4-6',
  });
  console.log(`Updated Sonya at ${sonyaJid} with model: claude-opus-4-6`);
} else {
  setRegisteredGroup(sonyaJid, {
    name: 'Sonya',
    folder: 'sonya',
    trigger: '^@Sonya\\b',
    added_at: new Date().toISOString(),
    requiresTrigger: true,
    model: 'claude-opus-4-6',
    assistantName: 'Sonya',
  });
  console.log(`Registered Sonya at ${sonyaJid}`);
}

const samJid = 'tg:190301535';
const sam = getRegisteredGroup(samJid);
if (sam) {
  setRegisteredGroup(samJid, {
    ...sam,
    model: 'claude-sonnet-4-6',
  });
  console.log(`Updated Sam at ${samJid} with model: claude-sonnet-4-6`);
} else {
  console.log(`Sam not registered at ${samJid} — register Sam first`);
}
```

Run: `npx tsx scripts/register-sonya.ts` (or `pnpm tsx scripts/register-sonya.ts` in v2).

**v2 caveat:** v2's entity model uses different tables (`agent_groups`, `messaging_groups`, `messaging_group_agents`). The `setRegisteredGroup` API may not exist or may have a different shape. **Adapt the script to v2's primitives** — the intent is to register Sonya with Opus and Sam with Sonnet on the chat `tg:190301535`, with Sonya triggered by `@Sonya`.

Depends on R-2 (per-group model overrides) being in place.

---

## S-2: scripts/transcribe.py

**Intent:** Local CLI for transcribing audio with faster-whisper. Used by the Telegram channel for voice-note transcription.

**Files:** `scripts/transcribe.py`

**Detail tier:** Non-standard

**How to apply:**

Create `scripts/transcribe.py`:

```python
"""Transcribe an audio file using faster-whisper. Prints text to stdout."""
import sys
from faster_whisper import WhisperModel

if len(sys.argv) < 3:
    print("Usage: transcribe.py <model> <audio_file>", file=sys.stderr)
    sys.exit(1)

model_name = sys.argv[1]
audio_file = sys.argv[2]

model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio_file, beam_size=5)
print(" ".join(seg.text.strip() for seg in segments))
```

Install dep on host (not via package.json):
```bash
pip install faster-whisper
```

Or, if you'd rather use the upstream `/use-local-whisper` skill (whisper.cpp instead of faster-whisper), apply that skill instead. faster-whisper was simpler at install time.

Required env: `WHISPER_MODEL=medium` (or `small`, `large-v3`, etc.) in `.env`.

---

## S-3: New npm/pnpm dependencies

**Intent:** Track which packages your customizations introduced beyond the upstream baseline.

**Files:** `package.json`

**Detail tier:** Standard

**How to apply:**

Verify these are present in the v2 worktree's package.json (most should arrive via `/add-telegram` and `/add-whatsapp`); add any that are missing:

| Package | Why | v2 path |
|---|---|---|
| `grammy@^1.39.3` | Telegram bot framework | Likely shipped by `/add-telegram` |
| `@whiskeysockets/baileys@^7.0.0-rc.9` | WhatsApp backend | Likely shipped by `/add-whatsapp` |
| `qrcode@^1.5.4`, `qrcode-terminal@^0.12.0` | WhatsApp QR pairing | Shipped with whatsapp |
| `pino@^9.6.0`, `pino-pretty@^13.0.0` | Logging | v2 replaced pino with built-in logger — check first; only add if needed |
| `yaml@^2.8.2` | YAML config parsing | Add if you actually use YAML configs |
| `zod@^4.3.6` | Schema validation | Often present in v2 already |
| `@vitest/coverage-v8@^4.0.18` | Test coverage | dev-only, optional |

For each missing dep, run `pnpm add <pkg>` (or `pnpm add -D <pkg>` for dev deps).

**Important:** v2 uses `pnpm`, not `npm`. Use `pnpm install`, `pnpm add`, etc.

---

## S-4: .env.example additions

**Intent:** Document the new env vars introduced by these customizations so future setups know what to fill in.

**Files:** `.env.example`

**Detail tier:** Standard

**How to apply:**

Append to `.env.example`:

```
# Telegram bot (from BotFather)
TELEGRAM_BOT_TOKEN=
# Set to "true" to disable WhatsApp and run Telegram-only
TELEGRAM_ONLY=
# Whisper model name for voice transcription (e.g. "small", "medium", "large-v3")
WHISPER_MODEL=
# Optional: per-instance Claude model override
CLAUDE_MODEL=claude-sonnet-4-6
```

`.env` itself is never touched by the migration — it's user data.
