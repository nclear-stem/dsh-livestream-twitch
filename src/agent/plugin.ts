/**
 * Agent sub-plugin (`dsh-livestream-twitch/agent`), mounted under the Twitch agent preset in
 * cordis.patch.yml. It only contributes agent-scoped tools; event delivery and reply capture are done by the
 * host plugin's bridge, which works with any session the user binds.
 */

import { activeRuntime } from '../plugin';
import { twitchStatusTool } from './tools';

export const name = 'dsh-livestream-twitch-agent';
export const inject = ['tools'];

interface AgentContext {
  effect(effect: () => () => void, label?: string): unknown;
  tools: { register(tool: unknown): () => void };
}

export function apply(ctx: AgentContext): void {
  ctx.effect(() => ctx.tools.register(twitchStatusTool(() => activeRuntime()?.status.snapshot() ?? null)), 'twitch_status tool');
}
