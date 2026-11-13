import type { AgentPort } from '../src/agent/agentPort';
import { resolveConfig, type TwitchConfig } from '../src/config/schema';
import { PluginRuntime } from '../src/runtime/lifecycle';
import { Supervisor } from '../src/runtime/supervisor';
import { MemoryCredentialStore } from '../src/storage/credentialStore';
import { MemorySettingsStore } from '../src/storage/settingsStore';
import { FAKE, FakeSocket, fakeFetch, grant, json, ManualTimers, memoryLogger } from './helpers';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

/** A supervisor with a stored, valid grant, fake Twitch HTTP, fake EventSub sockets and manual time. */
export function connectedHarness(
  config: DeepPartial<TwitchConfig> = {},
  scopes = ['user:read:chat', 'user:write:chat'],
  extraRoutes: Parameters<typeof fakeFetch>[0] = {},
  opts: { agentPort?: AgentPort; boundSessionId?: string } = {},
) {
  const timers = new ManualTimers();
  const sockets: FakeSocket[] = [];
  const store = new MemoryCredentialStore(grant({ scopes }), { TWITCH_CLIENT_SECRET: FAKE.clientSecret });
  const f = fakeFetch({
    'GET https://id.twitch.tv/oauth2/validate': () => json({ client_id: FAKE.clientId, login: 'streamer', user_id: '1001', scopes, expires_in: 9000 }),
    'POST https://api.twitch.tv/helix/eventsub/subscriptions': () => json({ data: [{ id: 'x', status: 'enabled' }] }, 202),
    'POST https://api.twitch.tv/helix/chat/messages': () => json({ data: [{ message_id: 'sent-1', is_sent: true }] }),
    ...extraRoutes,
  });
  const { logger, lines } = memoryLogger();
  const runtime = new PluginRuntime({
    config: resolveConfig({ clientId: FAKE.clientId, ...config } as never),
    store, settingsStore: new MemorySettingsStore({ boundSessionId: opts.boundSessionId ?? null }), logger,
  });
  const sup = new Supervisor(runtime, {
    fetch: f, timers, scheduler: { setInterval: () => 0, clearInterval: () => undefined },
    socketFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    ...(opts.agentPort ? { agentPort: opts.agentPort } : {}),
  });
  return { sup, runtime, f, timers, sockets, store, lines };
}
