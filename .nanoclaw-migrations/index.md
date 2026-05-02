# NanoClaw Migration Guide — Reginald (v1.2.x → v2.0.x)

Generated: 2026-05-02T07:53:52Z
Base (last sync with upstream): `3608f052`
HEAD at generation: `94a3046`
Upstream HEAD at generation: `f8c3d02` (v2.0.14)

This guide captures the customizations in the Reginald fork so they can be reapplied on a clean checkout of upstream `main` (v2.0+). It replaces a merge-based upgrade because v2 is a major restructuring (new entity model, two-DB session split, channels relocated to `channels` branch, Apple Container made opt-in).

## Tier

**Tier 3 (Complex)** — 502 upstream commits, 14 user commits, 29 changed files, 5,780 insertions / 695 deletions across src/, container/, scripts/, docs/, and group memory.

## Migration Plan

Order matters. Apply in stages, validating after each.

### Stage 0: Worktree + base setup

1. Worktree: `git worktree add .upgrade-worktree upstream/main --detach`
2. Install deps with v2's package manager (**pnpm**, not npm — v2 ships `pnpm-lock.yaml`).
3. `pnpm run build` — verify clean baseline before touching anything.

### Stage 1: Reapply skills (channels + container)

Channels in v2 live on `upstream/channels` branch (per BREAKING change). Apply via `/add-<channel>` skills, which copy from that branch into the trunk worktree:

- `/add-telegram` (your primary channel — high priority)
- `/add-whatsapp` (secondary; you also have one custom feature on top — see `channels.md`)
- `/convert-to-apple-container` (you're on Apple Container, must reapply — opt-in in v2)

Validate: `pnpm run build` should still pass.

### Stage 2: Foundation customizations (types + DB)

Apply first because most other code depends on them:

1. RegisteredGroup schema additions (`model`, `assistantName`) — see `routing.md`
2. Database migrations (media_json, reply_to_sender_name, registered_groups columns) — see `routing.md` and `channels.md`
3. MediaAttachment type — see `channels.md`

### Stage 3: Routing & multi-agent

- Virtual JID system (sub-agent routing) — see `routing.md`
- isMain flag (replaces MAIN_GROUP_FOLDER) — see `routing.md`
- Per-group model overrides — see `routing.md`

### Stage 4: Container infrastructure

- Apple Container .env injection fallback — see `container.md`
- Main group rw mount + personal workspace mounts — see `container.md`
- send_image MCP tool in agent-runner — see `container.md`
- Per-agent CLAUDE_MODEL injection — see `container.md`
- Memory limit (4GB) — see `container.md`

### Stage 5: Channel-specific features

- Telegram: voice transcription, media downloads, /status command — see `channels.md`
- WhatsApp: media handling and persistence (overlay on top of v2's add-whatsapp) — see `channels.md`
- IPC image sending with container-path translation — see `channels.md`

### Stage 6: Scripts & deps

- `scripts/register-sonya.ts` — see `scripts-and-deps.md`
- `scripts/transcribe.py` — see `scripts-and-deps.md`
- npm/pnpm deps (grammy, @vitest/coverage-v8) — see `scripts-and-deps.md`

### Stage 7: Behavior content (copy as-is)

- `docs/PERSONAL-OS.md`
- `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md`, `groups/sonya/CLAUDE.md`
- See `behavior.md`

### Stage 8: Validation

- `pnpm run build && pnpm test`
- Live smoke test from worktree (Phase 2.7 in skill).
- Swap into main tree.

## Applied Skills (to reapply in v2)

Channels — apply from `upstream/channels` via `/add-<channel>`:
- **add-telegram** — primary channel, heavy customization on top
- **add-whatsapp** — secondary channel, media-handling customization on top

Container runtime — apply from `upstream/skill/apple-container`:
- **convert-to-apple-container**

Operational skills — already on trunk (no action needed): `setup`, `debug`, `customize`, `update-nanoclaw`, `update-skills`, `init`, `claw`, `qodo-pr-resolver`, `get-qodo-rules`, etc.

Other feature skills you have installed but **don't reapply unless you actually use them** (avoid bloat — v1 had many we never customized): `add-discord`, `add-emacs`, `add-gmail`, `add-image-vision`, `add-macos-statusbar`, `add-pdf-reader`, `add-reactions`, `add-slack`, `add-compact`, `add-ollama-tool`, `add-parallel`, `add-telegram-swarm`, `add-voice-transcription`, `channel-formatting`, `init-onecli`, `use-local-whisper`, `use-native-credential-proxy`, `x-integration`. **Decide skill-by-skill at install time.**

## Skill Interactions / Conflicts

1. **Telegram + send_image (container.md ↔ channels.md)** — The send_image MCP tool in agent-runner emits an IPC `type: 'image'` event. The host's IPC handler (channels.md) translates the container path to host path and delegates to the channel's `sendImage()`. Both pieces are interdependent; reapply container.md item *before* channels.md IPC handler.

2. **Virtual JID + isMain (routing.md)** — Both live in `src/index.ts` startup loop. Apply isMain refactor first, then layer virtual JID on top.

3. **Apple Container + .env injection (container.md)** — Apple Container path is the *reason* .env injection exists (OneCLI gateway not reachable from Apple Container's bridge network). Both must be applied together.

4. **WhatsApp media + MediaAttachment type (channels.md)** — The type definition must exist before the media handler imports it. Apply types first.

5. **Per-group model + container CLAUDE_MODEL injection (routing.md ↔ container.md)** — Host-side schema/db change in routing.md; container env injection in container.md. Both required for end-to-end model override.

## Section files

- [channels.md](channels.md) — Telegram, WhatsApp, IPC image sending
- [routing.md](routing.md) — Virtual JID, model overrides, isMain
- [container.md](container.md) — Apple Container, runtime mounts, agent-runner, send_image MCP
- [scripts-and-deps.md](scripts-and-deps.md) — register-sonya, transcribe, npm deps
- [behavior.md](behavior.md) — docs/PERSONAL-OS.md, group CLAUDE.md files

## Risk areas (manual review needed)

These customizations touch files heavily reworked by upstream — expect the v2 file structure to look different than v1's, requiring adaptation rather than direct copy:

- **`src/index.ts`** — v2 introduced new entity model, agent-groups split, three-level isolation. The startup loop and routing in routing.md will likely need to be re-expressed in v2's idioms.
- **`src/db.ts`** — v2 split into `src/db/` directory with migration files. Our schema additions need to become new migration files in v2's directory.
- **`src/container-runner.ts`** — v2's container model differs (two-DB session split). Mount setup and OneCLI fallback may need reworking.
- **`src/router.ts`** — v2 has different routing layer.

These risks are flagged inline in each section file as well.
