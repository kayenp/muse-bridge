/**
 * Replies the agent can refer to later (e.g. to export their code), by a bridge-assigned id.
 *
 * The id is the reply's viewer entry number, so the agent and the user see the same "#N". It is never derived
 * from anything Muse wrote; Muse's own message ids stay inside the bridge.
 */
export interface KnownReply {
  messageIds: string[];
  threadUrl: string;
  at: number;
}

const MAX_REPLIES = 200;
const replies = new Map<number, KnownReply>();

export function registerReply(id: number, messageIds: string[], threadUrl: string): void {
  if (!messageIds.length) return;
  replies.set(id, { messageIds: [...messageIds], threadUrl, at: Date.now() });
  for (const key of replies.keys()) {
    if (replies.size <= MAX_REPLIES) break;
    replies.delete(key);
  }
}

export function getReply(id: number): KnownReply | undefined {
  return replies.get(id);
}

/** Thread part of a URL, so a reply is only looked up in the chat it came from. */
export function threadOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}
