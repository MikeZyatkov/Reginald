# Behavior content (copy as-is)

These four files are user-authored content (system documentation and agent personas). They are **not code** — copy verbatim into the upgraded worktree.

The data directories (`groups/main/conversations/`, `groups/main/data/`, `groups/main/media/`, etc.) are **conversation history and runtime state** — they remain in place, untouched by the migration. The migration only swaps code; data persists across the swap.

---

## B-1: docs/PERSONAL-OS.md

**Intent:** Architecture and first-principles document for the Personal OS — explains the two-repo model (Reginald for infrastructure, my-workspace for knowledge), the L0–L3 hierarchical memory layers, CLAUDE.md file conventions, and how projects/pulse/intake interact.

**Files:** `docs/PERSONAL-OS.md`

**How to apply:** Copy from main tree to worktree.
```bash
cp docs/PERSONAL-OS.md "$WORKTREE/docs/PERSONAL-OS.md"
```

**Size:** ~147 lines (5.5 KB)

**Why preserve:** This is the design specification for how the entire personal-AI setup works. It belongs in source control with the code that implements it.

---

## B-2: groups/global/CLAUDE.md

**Intent:** Sam's core agent persona — capabilities, communication norms, channel-specific formatting (Slack/WhatsApp/Telegram/Discord), memory usage rules. Loaded by every agent group.

**Files:** `groups/global/CLAUDE.md`

**How to apply:** Copy from main tree.
```bash
cp groups/global/CLAUDE.md "$WORKTREE/groups/global/CLAUDE.md"
```

**Size:** ~115 lines (4.7 KB)

**Why preserve:** This *is* Sam's identity. Without it the agent loses its persona, communication style, and channel-formatting knowledge.

---

## B-3: groups/main/CLAUDE.md

**Intent:** Sam's expanded persona for the main admin group. Extends global with admin privileges: workspace startup tasks (qmd symlink, git config, workspace CLAUDE.md loading), container mount knowledge, group management commands.

**Files:** `groups/main/CLAUDE.md`

**How to apply:** Copy from main tree.
```bash
cp groups/main/CLAUDE.md "$WORKTREE/groups/main/CLAUDE.md"
```

**Size:** ~259 lines (10.8 KB)

**Why preserve:** This is the admin context that lets Sam manage groups, register channels, and self-improve.

**v2 caveat:** v2's "main group = admin" concept is retired. The admin instructions in this file are still valid as *behavior* (what Sam can do as the owner), but if you later wire admin privilege via the new entity model instead of "main", review this file to remove references that no longer apply.

---

## B-4: groups/sonya/CLAUDE.md

**Intent:** Sonya sub-agent persona — defines her as a Telegram-triggered assistant (`@Sonya`), with formatting tailored to Telegram (no heading markup, plain bold/italic/bullets).

**Files:** `groups/sonya/CLAUDE.md`

**How to apply:** Copy from main tree.
```bash
cp groups/sonya/CLAUDE.md "$WORKTREE/groups/sonya/CLAUDE.md"
```

**Size:** ~48 lines (1.9 KB)

---

## B-5: Conversation/data preservation

The following directories are user runtime data and stay in the main tree, not the worktree:

- `groups/main/conversations/` — chat history (44 subdirectories last seen)
- `groups/main/data/`
- `groups/main/media/` — downloaded WhatsApp/Telegram media
- `groups/main/.ssh/` — group-scoped SSH keys (sensitive!)
- `groups/sonya/logs/`
- `data/sessions/` — agent session state (DBs, .claude config)
- `data/ipc/` — IPC scratch
- `store/` — global store

These persist across the migration because the swap (Phase 2.8) preserves the working tree's data directories — the migration only replaces code paths.

**Sanity check after migration:** Run `ls -la groups/main/conversations | wc -l` before and after the swap. Counts must match.
