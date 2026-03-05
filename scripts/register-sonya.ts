/**
 * One-time script to register Sonya as a sub-agent and update Sam's model.
 * Run with: npx tsx scripts/register-sonya.ts
 */
import { initDatabase, setRegisteredGroup, getRegisteredGroup } from '../src/db.js';

initDatabase();

// Register Sonya (sub-agent on same Telegram chat as Sam)
const sonyaJid = 'tg:190301535#sonya';
const existing = getRegisteredGroup(sonyaJid);
if (existing) {
  console.log(`Sonya already registered at ${sonyaJid}`);
} else {
  setRegisteredGroup(sonyaJid, {
    name: 'Sonya',
    folder: 'sonya',
    trigger: '^@Sonya\\b',
    added_at: new Date().toISOString(),
    requiresTrigger: true,
    model: 'claude-sonnet-4-6',
    assistantName: 'Sonya',
  });
  console.log(`Registered Sonya at ${sonyaJid}`);
}

// Update Sam's registration with explicit model
const samJid = 'tg:190301535';
const sam = getRegisteredGroup(samJid);
if (sam) {
  setRegisteredGroup(samJid, {
    ...sam,
    model: 'claude-opus-4-6',
  });
  console.log(`Updated Sam at ${samJid} with model: claude-opus-4-6`);
} else {
  console.log(`Sam not registered at ${samJid} — register Sam first`);
}
