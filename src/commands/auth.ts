import { spawn } from 'node:child_process';
import type { Supervisor } from '../runtime/supervisor';

/** Open the default browser when this looks like a desktop session; otherwise the URL is only printed. */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === 'darwin') return true;
  if (platform === 'linux') return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
  return false;
}

export function openBrowser(url: string): boolean {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!cmd) return false;
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function authCommand(sup: Supervisor, args: string[], opener: (url: string) => boolean = (u) => canOpenBrowser() && openBrowser(u)): Promise<string> {
  const replaceAccount = args.includes('--replace-account');
  const start = await sup.beginAuth({ replaceAccount });
  const opened = opener(start.url);
  const { config } = sup;
  return [
    opened ? 'Opened Twitch in your browser. If nothing appeared, open this URL:' : 'Open this URL in a browser on the machine whose localhost reaches the callback:',
    start.url,
    '',
    `Requested scopes: ${start.scopes.join(' ')}`,
    `Waiting for the callback on ${start.callback} (10 minutes).`,
    `Remote host? On your local machine run: ssh -N -L ${new URL(config.redirectUri).port || 80}:127.0.0.1:${config.callbackPort} user@your-server`,
    'Then check /twitch status. Sign in with the broadcaster account; it is also the chat sender.',
  ].join('\n');
}
