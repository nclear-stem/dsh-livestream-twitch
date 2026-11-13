/**
 * POST /helix/chat/messages with a user access token: broadcaster_id and sender_id are both the broadcaster
 * (sender_id must equal the token's user). `user:write:chat` scope. 500-character limit.
 */

import { TWITCH_LIMITS } from '../config/defaults';
import type { HelixClient } from './helixClient';

export interface SendChatRequest {
  broadcasterId: string;
  senderId: string;
  message: string;
  replyParentMessageId?: string;
}

export interface SendChatResult {
  messageId: string | null;
  isSent: boolean;
  dropReason?: { code: string; message: string };
}

export interface ChatSender {
  send(req: SendChatRequest): Promise<SendChatResult>;
}

/** Trim and cut to Twitch's limit by code points (no split surrogate pairs), ending with an ellipsis. */
export function clipChatMessage(text: string, max: number = TWITCH_LIMITS.chatMessageMaxChars): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

export function sendChatBody(req: SendChatRequest): Record<string, string> {
  return {
    broadcaster_id: req.broadcasterId,
    sender_id: req.senderId,
    message: clipChatMessage(req.message),
    ...(req.replyParentMessageId ? { reply_parent_message_id: req.replyParentMessageId } : {}),
  };
}

export class HelixChatClient implements ChatSender {
  constructor(private readonly helix: HelixClient) {}

  async send(req: SendChatRequest): Promise<SendChatResult> {
    const res = await this.helix.request<{ data?: Array<{ message_id?: string; is_sent?: boolean; drop_reason?: { code?: string; message?: string } | null }> }>(
      'POST', '/chat/messages', { body: sendChatBody(req) },
    );
    const d = res.body?.data?.[0];
    return {
      messageId: typeof d?.message_id === 'string' && d.message_id ? d.message_id : null,
      isSent: d?.is_sent === true,
      ...(d?.drop_reason ? { dropReason: { code: String(d.drop_reason.code ?? 'unknown'), message: String(d.drop_reason.message ?? '') } } : {}),
    };
  }
}
