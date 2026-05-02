# Channels — Telegram, WhatsApp, IPC image sending

This file covers customizations to the channel layer. **Most of the v1 Telegram code is replaced by `/add-telegram` from `upstream/channels` in v2.** Only customizations *on top of* the upstream Telegram channel need to be reapplied.

## Reapply v2 base channels first

```bash
# In the worktree:
cd "$WORKTREE"
# Apply Telegram skill from upstream/channels branch
# (the /add-telegram skill in v2 reads from upstream/channels)
git fetch upstream channels
# Then run /add-telegram via Claude Code, or manually copy:
git checkout upstream/channels -- .claude/skills/add-telegram setup/add-telegram.sh setup/channels/telegram.ts setup/install-telegram.sh setup/pair-telegram.ts src/channels/telegram*.ts src/channels/telegram-*
git checkout upstream/channels -- .claude/skills/add-whatsapp setup/install-whatsapp.sh setup/whatsapp-auth.ts src/channels/whatsapp*.ts
```

(Better: invoke `/add-telegram` and `/add-whatsapp` via Claude Code in the worktree. The skill handles paths and conflicts.)

After v2 channels are in, the customizations below layer on top.

---

## C-1: Telegram /status command (queue status reporting)

**Intent:** When the user sends `/status` to the Telegram bot, reply with a list of currently active agents — what each is working on, whether queued, and pending task count.

**Files:** `src/group-queue.ts`, `src/index.ts`, `src/channels/telegram.ts` (v2's version)

**Detail tier:** Standard

**How to apply:**

1. **Status method** in `src/group-queue.ts` (in `GroupQueue` class):
   ```ts
   getStatus(): Array<{
     groupJid: string;
     containerName: string | null;
     idleWaiting: boolean;
     pendingMessages: boolean;
     pendingTasks: number;
   }> {
     const result = [];
     for (const [jid, state] of this.groups) {
       if (state.active) {
         result.push({
           groupJid: jid,
           containerName: state.containerName,
           idleWaiting: state.idleWaiting,
           pendingMessages: state.pendingMessages,
           pendingTasks: state.pendingTasks.length,
         });
       }
     }
     return result;
   }
   ```

2. **Wire into Telegram channel options** (`src/index.ts`):
   ```ts
   // when constructing Telegram channel
   getQueueStatus: () => queue.getStatus(),
   pipeToAgent: (groupJid, text) => queue.sendMessage(groupJid, text),
   ```

3. **Telegram /status handler** — v2's add-telegram likely has a different command-handler shape. Add a `/status` command that calls `getQueueStatus()` and formats the output. Refer to v2's existing `/chatid` and `/ping` handlers for the pattern.

**Risk:** v2's GroupQueue may not exist or may be replaced by the new agent-groups model. If so, adapt to v2's queue/task primitives — the *intent* (report active agent state) is what to preserve.

---

## C-2: Telegram-only mode

**Intent:** Run with Telegram only, skipping WhatsApp entirely. Useful when you don't want Baileys connecting and consuming session state.

**Files:** `src/config.ts`, `src/index.ts`, `.env` (runtime)

**Detail tier:** Standard

**How to apply:**

1. **Config export** (`src/config.ts`):
   ```ts
   export const TELEGRAM_ONLY =
     (process.env.TELEGRAM_ONLY || envConfig.TELEGRAM_ONLY) === 'true';
   ```
   Add `'TELEGRAM_ONLY'` to the keys passed to `readEnvFile()`.

2. **Skip WhatsApp init** (`src/index.ts`):
   ```ts
   if (!TELEGRAM_ONLY) {
     const whatsapp = new WhatsAppChannel(channelOpts);
     channels.push(whatsapp);
     await whatsapp.connect();
   }
   ```

3. **`.env`**: set `TELEGRAM_ONLY=true` to enable.

**Risk:** v2 manages channels via `/manage-channels` and the channel registry. Instead of forcing skip in code, the v2-native approach is to simply not run `/add-whatsapp`. If you go pure-v2-style, this customization may not be needed at all.

---

## C-3: WhatsApp media handling and persistence

**Intent:** When WhatsApp delivers an image/video/document, download the media to `groups/{folder}/media/`, store the path/mime in the messages DB, and pass `MediaAttachment[]` to the agent so it can analyze images, transcribe documents, etc.

**Files:** `src/channels/whatsapp.ts`, `src/types.ts`, `src/db.ts` (v2: in `src/db/`), `src/router.ts`

**Detail tier:** Non-standard

**How to apply:**

1. **MediaAttachment type** (`src/types.ts`):
   ```ts
   export interface MediaAttachment {
     type: 'image' | 'video' | 'document';
     mimeType: string;
     filePath: string;
     caption?: string;
   }
   ```
   Add to `NewMessage`: `media?: MediaAttachment[];`

2. **Database** — v2 splits `src/db.ts` into `src/db/` with migration files in `src/db/migrations/`. Add a new migration:
   ```sql
   ALTER TABLE messages ADD COLUMN media_json TEXT;
   ```
   Update message insert to include `media_json`, deserialize on read. Find the existing INSERT/SELECT in v2 (probably `src/db/messages.ts` or similar) and adapt.

3. **WhatsApp channel** (`src/channels/whatsapp.ts`):
   - Import: `{ downloadMediaMessage } from '@whiskeysockets/baileys'`
   - In `messages.upsert` handler, detect `msg.message?.imageMessage`, `videoMessage`, `documentMessage`
   - When `hasMedia && !isBotMessage`, call helper `downloadWAMedia(msg, groupFolder)` which:
     - Calls `downloadMediaMessage(msg, 'buffer', {})`
     - Determines `mediaType`, `mimeType`, file extension from baileys message
     - Saves to `path.join(GROUPS_DIR, groupFolder, 'media', `${Date.now()}_${randomSuffix}${ext}`)`
     - Returns `MediaAttachment`
   - Pass `media: [downloaded]` in the `onMessage()` call

4. **Router formatting** (`src/router.ts`, in `formatMessages`):
   ```ts
   if (m.media && m.media.length > 0) {
     inner += m.media
       .map((media) =>
         `\n<media type="${escapeXml(media.type)}" path="${escapeXml(media.filePath)}" mimeType="${escapeXml(media.mimeType)}"/>`
       )
       .join('');
   }
   ```

**Risk:** v2's WhatsApp code (post-`/add-whatsapp`) may already do some of this. Check what v2 ships before adding — only the gaps need filling.

---

## C-4: Telegram-side media (voice transcription, image/video/document downloads)

**Intent:** Mirror the WhatsApp media handling on Telegram — voice notes get transcribed via faster-whisper, images/videos/documents get downloaded into `groups/{folder}/media/`.

**Files:** `src/channels/telegram.ts` (v2's version)

**Detail tier:** Non-standard

**How to apply:**

The v2 `/add-telegram` skill ships baseline Telegram support. Verify whether it includes media handlers; if not, add to v2's `TelegramChannel`:

1. **Download helper:**
   ```ts
   async downloadMedia(fileId: string, groupFolder: string, extension: string): Promise<string> {
     const file = await this.bot.api.getFile(fileId);
     const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
     const buffer = Buffer.from(await (await fetch(url)).arrayBuffer());
     const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;
     const filePath = path.join(GROUPS_DIR, groupFolder, 'media', filename);
     await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
     await fs.promises.writeFile(filePath, buffer);
     return filePath;
   }
   ```

2. **Voice transcription:**
   ```ts
   async transcribeVoice(fileId: string): Promise<string> {
     const oggPath = await this.downloadMedia(fileId, 'tmp', 'ogg');
     const { stdout } = await execFileP('python3', ['scripts/transcribe.py', WHISPER_MODEL, oggPath]);
     return stdout.trim();
   }
   ```
   `WHISPER_MODEL` is read from `.env` (default e.g. `'medium'`).

3. **Handlers**:
   - `bot.on('message:voice', async (ctx) => { ... transcribe ... onMessage(...) })`
   - `bot.on('message:photo', async (ctx) => { download, build MediaAttachment, onMessage(...) })`
   - `bot.on('message:video', async (ctx) => { ... })`
   - `bot.on('message:document', async (ctx) => { ... })`
   Each delivers `MediaAttachment[]` via the `onMessage` callback.

**Dep:** Voice transcription requires `scripts/transcribe.py` (see `scripts-and-deps.md`).

**Risk:** v2 may have moved to a different transcription path (Whisper API, vendor-managed). Check before reimplementing — if v2 has a built-in transcription tool, use it.

---

## C-5: Telegram database migration — group classification

**Intent:** All Telegram chats (1:1 and groups) should be flagged `is_group = 1` so trigger patterns and sub-agent routing apply uniformly.

**Files:** `src/db.ts` (v2: `src/db/migrations/`)

**Detail tier:** Standard

**How to apply:**

In v2's migrations (find the appropriate migration file or add a new one), set:
```sql
UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%';
```

(Original was `is_group = 0` — this customization changed it to `1`.)

---

## C-6: IPC image sending with container-path translation

**Intent:** Allow agent containers to emit `type: 'image'` IPC messages with container paths (e.g. `/workspace/group/media/foo.png`); the host translates the container path to a host path, then routes to the channel's `sendImage()`.

This pairs with the `send_image` MCP tool in `container.md`.

**Files:** `src/ipc.ts`, `src/index.ts`, `src/types.ts`

**Detail tier:** Non-standard

**How to apply:**

1. **Channel interface** (`src/types.ts`):
   ```ts
   sendImage?(jid: string, imagePath: string, caption?: string): Promise<void>;
   ```

2. **IpcDeps interface** (`src/ipc.ts`):
   ```ts
   sendImage: (jid: string, imagePath: string, caption?: string) => Promise<void>;
   ```

3. **Path translation helper** (`src/ipc.ts`):
   ```ts
   function resolveContainerImagePath(containerPath: string, sourceGroup: string): string {
     if (containerPath.startsWith('/workspace/group/')) {
       return path.join(GROUPS_DIR, sourceGroup, containerPath.slice('/workspace/group/'.length));
     }
     if (containerPath.startsWith('/workspace/global/')) {
       return path.join(GROUPS_DIR, 'global', containerPath.slice('/workspace/global/'.length));
     }
     return containerPath;
   }
   ```

4. **IPC handler** (`src/ipc.ts`, in `startIpcWatcher`):
   In the same place that handles `type: 'message'`, add:
   ```ts
   else if (data.type === 'image' && data.chatJid && data.imagePath) {
     const targetGroup = await getRegisteredGroup(data.chatJid);
     if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
       const hostImagePath = resolveContainerImagePath(data.imagePath, sourceGroup);
       await deps.sendImage(data.chatJid, hostImagePath, data.caption);
       logger.info({ chatJid: data.chatJid, sourceGroup, imagePath: data.imagePath, hostImagePath }, 'IPC image sent');
     }
   }
   ```

5. **Wire deps** (`src/index.ts`, where IpcDeps is constructed):
   ```ts
   sendImage: (jid, imagePath, caption) => {
     const channel = findChannel(channels, jid);
     return channel.sendImage(jid, imagePath, caption);
   },
   ```

6. **Implement `sendImage()` on channels:**
   - **Telegram** (`src/channels/telegram.ts`): use `bot.api.sendPhoto(chatId, new InputFile(imagePath), { caption })`
   - **WhatsApp** (`src/channels/whatsapp.ts`): use Baileys `sendMessage(jid, { image: { url: imagePath }, caption })`

**Risk:** v2's IPC layer may live at different paths (`src/ipc/`?) and its event shape may differ. The intent is what to preserve: an `image` IPC event type with container-relative path translation and per-channel image-send method.
