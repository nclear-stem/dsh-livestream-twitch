import type { Supervisor } from '../runtime/supervisor';

const SESSION_ID = /^[A-Za-z0-9_-]{6,80}$/;

/**
 * `connect [session-id]`: bind the agent session (the one the command is typed in, or the given id) and
 * start EventSub. The binding persists across restarts.
 */
export async function connectCommand(sup: Supervisor, args: string[], invokingSessionId?: string): Promise<string> {
  const explicit = args.find((a) => !a.startsWith('--'));
  if (explicit && !SESSION_ID.test(explicit)) throw new Error(`"${explicit.slice(0, 40)}" does not look like a DSH session id`);
  const target = explicit ?? invokingSessionId ?? sup.runtime.settings.boundSessionId;
  const { enabled, disabled } = await sup.connect();
  // bind only once chat actually started
  if (target && target !== sup.runtime.settings.boundSessionId) sup.runtime.updateSettings({ boundSessionId: target });
  const me = sup.tokens.identity!;
  const bound = sup.runtime.settings.boundSessionId;
  return [
    `Connecting to #${me.login} chat as ${me.displayName} (user ID ${me.userId}).`,
    `Subscribing: ${enabled.map((s) => `${s.type} v${s.version}`).join(', ')}`,
    ...disabled.map((s) => `Off: ${s.type} (${s.reason})`),
    bound ? `Agent session: ${bound}` : 'No agent session bound: run /twitch connect inside the session that should answer chat.',
    `Auto reply: ${sup.runtime.autoReply ? 'on' : 'off (/twitch reply on)'}`,
    `Replies: ${sup.runtime.dryRun ? 'dry-run, nothing is posted (/twitch dryrun off to post)' : 'posted to chat as the broadcaster'}`,
    'Check /twitch status for the live connection state.',
  ].join('\n');
}

export function toggleCommand(sup: Supervisor, which: 'reply' | 'dryrun', args: string[]): string {
  const v = args[0]?.toLowerCase();
  if (v !== 'on' && v !== 'off') throw new Error(`usage: /twitch ${which} on|off`);
  const on = v === 'on';
  sup.runtime.updateSettings(which === 'reply' ? { autoReply: on } : { dryRun: on });
  return which === 'reply'
    ? `Auto reply ${on ? 'on: viewer messages go to the bound agent session' : 'off: messages are received but not answered'}.`
    : `Dry-run ${on ? 'on: replies are generated but not posted' : 'off: replies are posted to Twitch chat as the broadcaster'}.`;
}
