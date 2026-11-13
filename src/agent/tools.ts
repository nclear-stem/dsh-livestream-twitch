/**
 * Agent tools. Deliberately small: the reply channel is the assistant's own text for the turn that handles a
 * chat message (the bridge sends it), so there is no "send chat" tool that could double-post.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { StatusSnapshot } from '../runtime/status';

const textOut = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

export function statusToolText(s: StatusSnapshot | null): string {
  if (!s) return 'The Twitch plugin is not running.';
  const id = s.auth.identity;
  return [
    `Twitch channel: ${id ? `${id.displayName} (${id.login})` : 'not authorized'}`,
    `Chat connection: ${s.eventsub.state}`,
    `Auto reply: ${s.bridge.autoReply ? 'on' : 'off'}; dry-run: ${s.bridge.dryRun ? 'on (replies are not posted)' : 'off (replies are posted to chat)'}`,
    `Enabled events: ${s.eventsub.subscriptions.filter((x) => x.state === 'enabled').map((x) => x.type).join(', ') || 'none'}`,
  ].join('\n');
}

export function twitchStatusTool(snapshot: () => StatusSnapshot | null) {
  return defineTool({
    name: 'twitch_status',
    description: 'Show the Twitch chat connection: which channel you are speaking as, whether replies are posted or only previewed (dry-run), and which events are enabled.',
    parameters: {},
    output: textOut,
    async execute() {
      return statusToolText(snapshot());
    },
  });
}
