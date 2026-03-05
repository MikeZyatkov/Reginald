import { describe, it, expect } from 'vitest';

import { baseJid, isVirtualJid } from './virtual-jid.js';

describe('baseJid', () => {
  it('returns the JID unchanged when no alias present', () => {
    expect(baseJid('tg:190301535')).toBe('tg:190301535');
  });

  it('strips the #alias suffix', () => {
    expect(baseJid('tg:190301535#sonya')).toBe('tg:190301535');
  });

  it('handles WhatsApp JIDs unchanged', () => {
    expect(baseJid('12345@g.us')).toBe('12345@g.us');
  });

  it('handles empty string', () => {
    expect(baseJid('')).toBe('');
  });

  it('strips only the first #alias', () => {
    expect(baseJid('tg:123#a#b')).toBe('tg:123');
  });
});

describe('isVirtualJid', () => {
  it('returns false for base JIDs', () => {
    expect(isVirtualJid('tg:190301535')).toBe(false);
    expect(isVirtualJid('12345@g.us')).toBe(false);
  });

  it('returns true for virtual JIDs', () => {
    expect(isVirtualJid('tg:190301535#sonya')).toBe(true);
  });
});
