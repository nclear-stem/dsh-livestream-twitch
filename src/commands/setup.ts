import { createServer } from 'node:net';
import { ConfigError } from '../config/schema';
import type { Supervisor } from '../runtime/supervisor';

export interface SetupProbe {
  portFree(host: string, port: number): Promise<boolean>;
  hasWebSocket(): boolean;
  nodeVersion: string;
}

export const realProbe: SetupProbe = {
  portFree: (host, port) => new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  }),
  hasWebSocket: () => typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function',
  nodeVersion: process.versions.node,
};

/** Check config, credentials (presence only), callback port and runtime capabilities. Never prints secrets. */
export async function setupCommand(sup: Supervisor, extras: { agentsAvailable: boolean }, probe: SetupProbe = realProbe): Promise<string> {
  const { config } = sup;
  const ok = (b: boolean) => (b ? 'ok  ' : 'FAIL');
  const lines: string[] = [];
  let creds = 'ok';
  try {
    await sup.clientCredentials();
  } catch (err) {
    creds = err instanceof ConfigError ? err.message : `could not read credentials: ${(err as Error).message}`;
  }
  lines.push(`[${ok(creds === 'ok')}] Client ID and Client Secret ${creds === 'ok' ? 'are set' : `: ${creds}`}`);
  lines.push(`[ok  ] Credential store: ${sup.runtime.store.kind}`);
  const redirect = new URL(config.redirectUri);
  lines.push(`[ok  ] Redirect URL (must match the Twitch console exactly): ${config.redirectUri}`);
  const redirectPort = Number(redirect.port || 80);
  if (redirectPort !== config.callbackPort) lines.push(`[warn] redirect port ${redirectPort} differs from callbackPort ${config.callbackPort}: only correct if an SSH tunnel maps ${redirectPort} -> ${config.callbackPort}`);
  const free = await probe.portFree(config.callbackHost, config.callbackPort);
  lines.push(`[${ok(free)}] Callback ${config.callbackHost}:${config.callbackPort} ${free ? 'is free' : 'is in use (another process or a pending /twitch auth)'}`);
  const major = Number(probe.nodeVersion.split('.')[0]);
  lines.push(`[${ok(major >= 22)}] Node.js ${probe.nodeVersion} (needs 22+)`);
  lines.push(`[${ok(probe.hasWebSocket())}] Built-in WebSocket client for EventSub`);
  lines.push(`[${ok(extras.agentsAvailable)}] DSH agent service ${extras.agentsAvailable ? 'available' : 'not found: the agent bridge cannot deliver messages in this profile'}`);
  lines.push(`Chat: read ${config.chat.read}, send ${config.chat.send}, autoReply ${sup.runtime.autoReply}, dryRun ${sup.runtime.dryRun}`);
  lines.push(`Events: ${Object.entries(config.events).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ')}`);
  return lines.join('\n');
}
