import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN, WHISPER_MODEL } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  MediaAttachment,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { baseJid } from '../virtual-jid.js';

const execFileAsync = promisify(execFile);

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getQueueStatus?: () => Array<{ groupJid: string; containerName: string | null; idleWaiting: boolean; pendingMessages: boolean; pendingTasks: number }>;
  pipeToAgent?: (groupJid: string, text: string) => boolean;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private whisperEnabled = false;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    if (WHISPER_MODEL) {
      this.whisperEnabled = true;
      logger.info({ model: WHISPER_MODEL }, 'Local faster-whisper transcription enabled');
    } else {
      logger.info('WHISPER_MODEL not set — voice messages will not be transcribed');
    }
  }

  /**
   * Download a Telegram file and transcribe it using local faster-whisper (Python).
   * Flow: download OGG → run scripts/transcribe.py → return text.
   * Returns the transcribed text, or null on failure.
   */
  private async transcribeVoice(fileId: string): Promise<string | null> {
    if (!this.whisperEnabled || !this.bot) return null;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
    const oggPath = path.join(tmpDir, 'voice.ogg');

    try {
      // Get the file path from Telegram
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram file has no file_path');
        return null;
      }

      // Download the audio file
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn({ fileId, status: response.status }, 'Failed to download voice file');
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(oggPath, buffer);

      // Run faster-whisper via Python script
      const scriptPath = path.join(process.cwd(), 'scripts', 'transcribe.py');
      const { stdout } = await execFileAsync('python3', [
        scriptPath, WHISPER_MODEL, oggPath,
      ], { timeout: 120000 });

      const transcript = stdout.trim();
      if (!transcript) {
        logger.warn({ fileId }, 'Whisper produced empty transcription');
        return null;
      }

      logger.info(
        { fileId, textLength: transcript.length },
        'Voice message transcribed',
      );
      return transcript;
    } catch (err) {
      logger.error({ fileId, err }, 'Voice transcription failed');
      return null;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }
  }

  /**
   * Download a Telegram file to the group's media directory.
   * Returns the saved file path, or null on failure.
   */
  private async downloadMedia(
    fileId: string,
    groupFolder: string,
    extension: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram file has no file_path');
        return null;
      }

      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn({ fileId, status: response.status }, 'Failed to download Telegram media');
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Save to groups/{folder}/media/
      const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });

      const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${extension}`;
      const filePath = path.join(mediaDir, filename);
      fs.writeFileSync(filePath, buffer);

      logger.info({ fileId, filePath, size: buffer.length }, 'Telegram media saved');
      return filePath;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram media');
      return null;
    }
  }

  /**
   * Resolve the group folder for a chat JID.
   * Returns the folder name, or null if the chat is not registered.
   */
  private getGroupFolder(chatJid: string): string | null {
    const groups = this.opts.registeredGroups();
    const group = groups[chatJid];
    if (group) return group.folder;
    // Check virtual JIDs
    const entry = Object.entries(groups).find(([k]) => baseJid(k) === chatJid);
    return entry ? entry[1].folder : null;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to check agent status — asks active agents to report what they're doing
    this.bot.command('status', (ctx) => {
      const statuses = this.opts.getQueueStatus?.() || [];
      if (statuses.length === 0) {
        ctx.reply('No active agents. All idle.');
        return;
      }

      const statusPrompt = '<messages>\n<message sender="System" time="' + new Date().toISOString() + '">[STATUS CHECK] Briefly report what you are currently working on in 1-2 sentences. If you have background tasks running, mention them too.</message>\n</messages>';

      let piped = 0;
      for (const s of statuses) {
        if (this.opts.pipeToAgent?.(s.groupJid, statusPrompt)) {
          piped++;
        }
      }

      if (piped === 0) {
        ctx.reply('Agents are active but not accepting input right now. Try again shortly.');
      }
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups.
      // Also check for virtual JID registrations (sub-agents like tg:123#sonya)
      const groups = this.opts.registeredGroups();
      const hasRegistration = groups[chatJid] ||
        Object.keys(groups).some((k) => baseJid(k) === chatJid);
      if (!hasRegistration) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const hasRegistration = groups[chatJid] ||
        Object.keys(groups).some((k) => baseJid(k) === chatJid);
      if (!hasRegistration) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groupFolder = this.getGroupFolder(chatJid);
      if (!groupFolder) return;

      // Get the largest photo (last element in the array)
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const fileId = largest.file_id;

      const filePath = await this.downloadMedia(fileId, groupFolder, '.jpg');
      const caption = ctx.message.caption || '';
      const content = caption || '[Photo]';
      const media: MediaAttachment[] | undefined = filePath
        ? [{ type: 'image', mimeType: 'image/jpeg', filePath, caption: caption || undefined }]
        : undefined;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        media,
      });
    });

    this.bot.on('message:video', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groupFolder = this.getGroupFolder(chatJid);
      if (!groupFolder) {
        // Unregistered chat, skip
        return;
      }

      const fileId = ctx.message.video.file_id;
      const mimeType = ctx.message.video.mime_type || 'video/mp4';
      const ext = mimeType === 'video/mp4' ? '.mp4' : '.vid';

      const filePath = await this.downloadMedia(fileId, groupFolder, ext);
      const caption = ctx.message.caption || '';
      const content = caption || '[Video]';
      const media: MediaAttachment[] | undefined = filePath
        ? [{ type: 'video', mimeType, filePath, caption: caption || undefined }]
        : undefined;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        media,
      });
    });
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const hasRegistration = groups[chatJid] ||
        Object.keys(groups).some((k) => baseJid(k) === chatJid);
      if (!hasRegistration) return;

      const fileId = ctx.message.voice.file_id;
      const transcript = await this.transcribeVoice(fileId);
      if (transcript) {
        storeNonText(ctx, `[Voice message: "${transcript}"]`);
      } else {
        storeNonText(ctx, '[Voice message: transcription unavailable]');
      }
    });
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const hasRegistration = groups[chatJid] ||
        Object.keys(groups).some((k) => baseJid(k) === chatJid);
      if (!hasRegistration) return;

      const fileId = ctx.message.audio.file_id;
      const transcript = await this.transcribeVoice(fileId);
      if (transcript) {
        storeNonText(ctx, `[Audio: "${transcript}"]`);
      } else {
        storeNonText(ctx, '[Audio]');
      }
    });
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groupFolder = this.getGroupFolder(chatJid);
      if (!groupFolder) return;

      const doc = ctx.message.document;
      const fileName = doc?.file_name || 'file';
      const fileId = doc.file_id;
      const mimeType = doc.mime_type || 'application/octet-stream';
      const ext = path.extname(fileName) || '';

      const filePath = await this.downloadMedia(fileId, groupFolder, ext);
      const caption = ctx.message.caption || '';
      const content = caption || `[Document: ${fileName}]`;
      const media: MediaAttachment[] | undefined = filePath
        ? [{ type: 'document', mimeType, filePath, caption: caption || undefined }]
        : undefined;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        media,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = baseJid(jid).replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return baseJid(jid).startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = baseJid(jid).replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
