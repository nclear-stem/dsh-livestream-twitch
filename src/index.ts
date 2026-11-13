/**
 * dsh-livestream-twitch host plugin entry (Cordis plugin shape used by DSH: name, inject, Config, apply).
 * Cordis 4 treats every `inject` entry as required (array or name -> config map; there is no optional form),
 * so only `connection` (HTTP routes, present in the web/desktop profiles) is injected. Credentials, commands,
 * agents and sessionController are resolved lazily through ctx.get in ./dsh/host.
 */

import { PLUGIN_NAME } from './config/defaults';
import { Config, type TwitchConfig } from './config/schema';
import type { CordisLikeContext } from './dsh/host';
import { applyPlugin } from './plugin';

export const name = PLUGIN_NAME;
export const inject = ['connection'];
export { Config };

export function apply(ctx: CordisLikeContext, config?: Partial<TwitchConfig>): void {
  applyPlugin(ctx, config);
}
