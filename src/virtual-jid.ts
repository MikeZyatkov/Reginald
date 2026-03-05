/**
 * Virtual JID utilities for sub-agent routing.
 *
 * Convention: `{baseJid}#alias` (e.g., `tg:190301535#sonya`).
 * Messages are stored under the base JID; routing uses the virtual JID
 * for agent lookup.
 */

/** Strip the `#alias` suffix, returning the base JID. */
export function baseJid(jid: string): string {
  const idx = jid.indexOf('#');
  return idx === -1 ? jid : jid.slice(0, idx);
}

/** Check whether a JID contains a `#alias` suffix. */
export function isVirtualJid(jid: string): boolean {
  return jid.includes('#');
}
