# Routing — Virtual JID, model overrides, isMain

This file covers the multi-agent routing customizations: virtual JIDs (sub-agents on the same chat), per-group model overrides, and the `isMain` flag refactor.

**v2 caveat:** v2 introduced its own multi-agent model (separate `agent_groups` and `messaging_groups` tables, `messaging_group_agents` linkage, three isolation levels). Some of these v1 customizations may already be supported natively in v2 — **read v2's `docs/architecture.md` and `docs/isolation-model.md` before reimplementing**. Where v2 has a native feature, use it instead of porting v1 code.

---

## R-1: isMain flag (replaces MAIN_GROUP_FOLDER)

**Intent:** Make any group the "main" admin group via a per-group `isMain` boolean instead of hard-coding via `MAIN_GROUP_FOLDER` env var. This enables a flexible setup where the admin role can move between groups.

**v2 status:** Likely SUPERSEDED by v2's user-level privilege model ("the old 'main channel = admin' concept is retired"). **Do not port this customization.** Map your existing main group to v2's owner/admin role via the new entity model.

**Action:** During v2 onboarding, ensure your Telegram chat (`tg:190301535`) is registered with owner/admin privilege in the new entity model. The `isMain` flag is no longer the right primitive.

---

## R-2: Per-group model overrides

**Intent:** Each registered group can override the Claude model (e.g. Sonya uses Opus, Sam uses Sonnet). The model is read from the registered group, passed into the container as `CLAUDE_MODEL`, and consumed by the agent-runner.

**Files:** `src/types.ts`, `src/db.ts` (v2: `src/db/migrations/`), `src/index.ts`, `src/container-runner.ts`, `container/agent-runner/src/index.ts`

**Detail tier:** Standard

**How to apply:**

1. **RegisteredGroup type** (`src/types.ts`, or v2's equivalent):
   ```ts
   model?: string;           // e.g. 'claude-sonnet-4-6'
   assistantName?: string;   // override ASSISTANT_NAME for this group
   ```

2. **DB migration** (v2: add to `src/db/migrations/`):
   ```sql
   ALTER TABLE registered_groups ADD COLUMN model TEXT;
   ALTER TABLE registered_groups ADD COLUMN assistant_name TEXT;
   ```
   In v2 the table may be `agent_groups` or similar — adapt to v2's schema.

3. **DB getters/setters**: include `model` and `assistant_name` in INSERT/UPDATE; map to/from `model` and `assistantName` properties on read.

4. **Pass into container** (`src/container-runner.ts`):
   - Add `model?: string` to `ContainerInput` interface.
   - In `buildContainerArgs()`, if `input.model` is set:
     ```ts
     args.push('-e', `CLAUDE_MODEL=${input.model}`);
     ```
   - Propagate from caller: `runContainerAgent({ ..., model: group.model })`.

5. **Agent-runner reads model** (`container/agent-runner/src/index.ts`):
   - `const model = containerInput.model || process.env.CLAUDE_MODEL || undefined;`
   - Pass to SDK: `query({ prompt: stream, options: { model, ...} })`.
   - If undefined, falls through to SDK default.

6. **Assistant name passing** (`src/index.ts`):
   - In message-loop, when computing the bot name to look up message cursors:
     ```ts
     const botName = registeredGroups[chatJid]?.assistantName || ASSISTANT_NAME;
     ```
   - Use `botName` in `getLastBotMessageTimestamp(chatJid, botName)` and `getMessagesSince(chatJid, since, botName)`.

**Risk:** v2's container-runner may already accept a `model` config. If it does, just wire registered-group → container input. The schema additions are still needed unless v2's `agent_groups` already has model fields (check `src/db/migrations/`).

---

## R-3: Virtual JID system (sub-agents on the same chat)

**Intent:** Run multiple agent personas (Sam + Sonya) on the *same* Telegram chat, distinguished by trigger patterns. Each persona has its own JID with the form `{baseJid}#{name}`. The DB stores messages under the base JID; routing dispatches to whichever persona's trigger matched.

**v2 status:** Possibly SUPERSEDED by v2's three-level isolation (`session_mode: 'agent-shared'` lets channels merge into one shared session). **Read v2's isolation-model docs first.** If v2 covers this, use the native primitive. Otherwise port v1's virtual JIDs.

**Files (v1 reference):** `src/virtual-jid.ts` (new file), `src/virtual-jid.test.ts` (new file), `src/index.ts`, `src/router.ts`, `src/config.ts`

**Detail tier:** Non-standard (only if porting v1 code)

**How to apply (v1-style fallback if v2 doesn't cover it):**

1. **Utilities** (`src/virtual-jid.ts`):
   ```ts
   export function baseJid(jid: string): string {
     const idx = jid.indexOf('#');
     return idx === -1 ? jid : jid.slice(0, idx);
   }
   export function isVirtualJid(jid: string): boolean {
     return jid.includes('#');
   }
   ```

2. **Message deduplication** (`src/index.ts`, in `startMessageLoop`):
   - Collect all registered JIDs (primary + virtual).
   - Dedupe by `baseJid`: `const baseJids = [...new Set(allJids.map(baseJid))];`
   - Query DB using base JIDs only — DB stores under base JID, never virtual.

3. **Sub-agent routing** (`src/index.ts`):
   - For each base JID with new messages:
     ```ts
     const registrations = allJids.filter((jid) => baseJid(jid) === baseChatJid);
     // Check virtual JIDs first for trigger match
     const virtualMatch = registrations.find((jid) => {
       if (!isVirtualJid(jid)) return false;
       const reg = registeredGroups[jid];
       return reg?.trigger && new RegExp(reg.trigger, 'i').test(messageText);
     });
     if (virtualMatch) {
       routeToAgent(virtualMatch, registeredGroups[virtualMatch], baseChatJid, groupMessages);
     } else {
       // Fall through to primary
       const primary = registrations.find((jid) => !isVirtualJid(jid));
       routeToAgent(primary, registeredGroups[primary], baseChatJid, groupMessages);
     }
     ```

4. **Channel routing** (`src/router.ts`, `findChannel`, `routeOutbound`):
   - Channels only own base JIDs. Look up via `baseJid(jid)` everywhere.
   - When sending, pass `baseJid(jid)` to the channel.

5. **DB queries** (`src/db.ts`):
   - All chat-related queries normalize input via `baseJid(chatJid)`.

6. **Bot timestamp recovery**:
   - Each agent has its own cursor: use `group.assistantName || ASSISTANT_NAME` to find the right timestamp per agent.

**Concrete example from current setup:**
- Primary: `tg:190301535` → Sam (Sonnet 4.6)
- Virtual: `tg:190301535#sonya` → Sonya (Opus 4.6, trigger `^@Sonya\b`)

A Telegram message in chat `tg:190301535` is matched against Sonya's trigger first; if `@Sonya` mentioned, routed to Sonya container; otherwise Sam handles it.

---

## R-4: Routing test coverage (Telegram)

**Intent:** Test suite covers Telegram chat patterns and group discovery alongside WhatsApp.

**Files:** `src/routing.test.ts`

**Detail tier:** Standard

**How to apply:**

In v2's equivalent test file, ensure the following cases are covered:

- Telegram JID pattern detection: `'tg:123456789'.startsWith('tg:')` is `true`.
- Telegram group JID: `'tg:-1001234567890'.startsWith('tg:')` is `true`.
- `getAvailableGroups()` (or v2's equivalent) includes Telegram chats, ordered by activity.
- Registered Telegram chats marked `isRegistered: true`.
- Mixed test data: WhatsApp + Telegram chats in group discovery tests.

(Tests are user-authored — adapt to whatever the v2 routing/groups API looks like.)
