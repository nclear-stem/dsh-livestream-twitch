import type { Supervisor } from '../runtime/supervisor';

/** `disconnect` stops chat; `disconnect --forget` also revokes (if configured) and clears the stored grant. */
export async function disconnectCommand(sup: Supervisor, args: string[]): Promise<string> {
  const forget = args.includes('--forget');
  const { revoked } = await sup.disconnect({ forget });
  if (!forget) return 'Disconnected from Twitch chat. The authorization is kept; /twitch connect resumes. Use --forget to remove it.';
  return `Disconnected and removed the stored Twitch authorization${sup.config.revokeOnForget ? (revoked ? ' (token revoked at Twitch)' : ' (revocation at Twitch failed or there was no token; remove the app under Twitch Settings > Connections if needed)') : ''}.`;
}
