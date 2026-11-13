/**
 * `/twitch test`: offline self-check. Decodes built-in EventSub fixtures and builds (but does not send) the
 * Helix request bodies, so a broken install shows up without touching Twitch or the chat.
 */

import { requestedScopes } from '../auth/scopes';
import type { TwitchConfig } from '../config/schema';
import { decodeNotification, parseFrame, PLATFORM_DECODERS } from '../twitch/eventsub/decoder';
import { planSubscriptions, SUBSCRIPTIONS } from '../twitch/eventsub/subscriptionRegistry';
import { sendChatBody } from '../twitch/chatClient';

const BROADCASTER = { userId: '1001', login: 'selftest_channel', displayName: 'SelfTest' };

export const CHAT_FIXTURE = JSON.stringify({
  metadata: { message_id: 'selftest-1', message_type: 'notification', message_timestamp: '2026-11-10T00:00:00.000000000Z', subscription_type: 'channel.chat.message', subscription_version: '1' },
  payload: {
    subscription: { id: 'sub-1', type: 'channel.chat.message', version: '1', status: 'enabled', condition: { broadcaster_user_id: '1001', user_id: '1001' }, transport: { method: 'websocket', session_id: 's' } },
    event: {
      broadcaster_user_id: '1001', broadcaster_user_login: 'selftest_channel', broadcaster_user_name: 'SelfTest',
      chatter_user_id: '2002', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
      message_id: 'chat-msg-1', message: { text: 'hello from the self-test', fragments: [] }, badges: [{ set_id: 'subscriber', id: '3', info: '3' }],
      message_type: 'text', cheer: null, reply: null,
    },
  },
});

export function testCommand(config: TwitchConfig): string {
  const lines: string[] = [];
  const check = (name: string, ok: boolean, detail = '') => lines.push(`[${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? `: ${detail}` : ''}`);

  const frame = parseFrame(CHAT_FIXTURE);
  const decoded = frame.type === 'notification' ? decodeNotification(frame) : null;
  const chat = decoded?.kind === 'chat' ? decoded.chat : null;
  check('decode channel.chat.message', !!chat && chat.sender.userId === '2002' && chat.text === 'hello from the self-test');
  check('malformed frame is rejected without throwing', parseFrame('{"metadata":{}}').type === 'invalid');

  const body = sendChatBody({ broadcasterId: BROADCASTER.userId, senderId: BROADCASTER.userId, message: 'x'.repeat(600), replyParentMessageId: 'chat-msg-1' });
  check('send body uses the broadcaster as sender', body.broadcaster_id === body.sender_id);
  check('send body is cut to 500 characters', [...(body.message ?? '')].length === 500);
  check('send body carries reply_parent_message_id', body.reply_parent_message_id === 'chat-msg-1');

  const scopes = requestedScopes(config);
  const plan = planSubscriptions(config, scopes);
  check('subscription plan for this config', plan.disabled.length === 0, plan.enabled.map((d) => `${d.type} v${d.version}`).join(', '));
  check('every registered subscription has a decoder', SUBSCRIPTIONS.every((d) => d.type === 'channel.chat.message' || typeof PLATFORM_DECODERS[d.type] === 'function'));
  lines.push(`Scopes this config requests: ${scopes.join(' ')}`);
  lines.push('No request was sent to Twitch.');
  return lines.join('\n');
}
