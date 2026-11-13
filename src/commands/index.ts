/**
 * `/twitch <sub>` router. DSH 0.2.x has no extension point for new `dsh <cmd>` CLI subcommands (the `dsh` binary
 * only boots profiles and manages plugins), so the plan's `dsh-twitch <sub>` commands are slash commands in a
 * DSH session plus equivalent HTTP routes. Every handler returns redacted plain text.
 */

import { redact } from '../runtime/redact';
import type { Supervisor } from '../runtime/supervisor';
import { authCommand } from './auth';
import { connectCommand, toggleCommand } from './connect';
import { disconnectCommand } from './disconnect';
import { setupCommand } from './setup';
import { statusCommand } from './status';
import { testCommand } from './test';

export interface CommandEnv {
  sup: Supervisor;
  /** DSH session the slash command was typed in (bind target for connect). */
  sessionId?: string;
  agentsAvailable: boolean;
}

export const USAGE = [
  'Usage: /twitch <command>',
  '  setup                       check config, credentials, callback port, runtime',
  '  auth [--replace-account]    authorize the broadcaster account (OAuth in the browser)',
  '  status                      auth, EventSub, bridge and dry-run status',
  '  connect [session-id]        start chat; replies go through this session (or the given one)',
  '  disconnect [--forget]       stop chat; --forget also revokes and clears the authorization',
  '  reply on|off | dryrun on|off   toggle automatic replies / dry-run',
  '  test                        offline self-test of decoding and request shapes (sends nothing)',
].join('\n');

export async function runCommand(rawInput: string, env: CommandEnv): Promise<{ ok: boolean; text: string }> {
  const [sub = 'status', ...args] = rawInput.trim().split(/\s+/).filter(Boolean);
  try {
    switch (sub) {
      case 'setup': return { ok: true, text: await setupCommand(env.sup, { agentsAvailable: env.agentsAvailable }) };
      case 'auth': return { ok: true, text: await authCommand(env.sup, args) };
      case 'status': return { ok: true, text: statusCommand(env.sup) };
      case 'disconnect': return { ok: true, text: await disconnectCommand(env.sup, args) };
      case 'connect': return { ok: true, text: await connectCommand(env.sup, args, env.sessionId) };
      case 'reply':
      case 'dryrun': return { ok: true, text: toggleCommand(env.sup, sub, args) };
      case 'test': {
        const text = testCommand(env.sup.config);
        return { ok: !text.includes('[FAIL]'), text };
      }
      case 'help': return { ok: true, text: USAGE };
      default:
        return { ok: false, text: `Unknown subcommand "${sub}".\n${USAGE}` };
    }
  } catch (err) {
    return { ok: false, text: redact(err instanceof Error ? err.message : err) };
  }
}
