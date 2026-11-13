/**
 * DSH host plugin wiring: builds the runtime and supervisor from the Cordis context, registers the
 * `/twitch` slash command and the HTTP routes, and ties start/stop to the plugin effect lifetime.
 */

import { runCommand } from './commands';
import { DshAgentPort } from './agent/agentPort';
import { realTimers } from './runtime/timers';
import { PLUGIN_NAME } from './config/defaults';
import { resolveConfig, type TwitchConfig } from './config/schema';
import { host, type CordisLikeContext } from './dsh/host';
import { consoleSink, createLogger, type LogSink } from './runtime/redact';
import { dataDirFor, PluginRuntime } from './runtime/lifecycle';
import { Supervisor } from './runtime/supervisor';
import { DshCredentialStore, EncryptedFileCredentialStore, LazyCredentialStore, type CredentialStore } from './storage/credentialStore';
import { JsonSettingsStore } from './storage/settingsStore';

let current: Supervisor | null = null;

/** The live supervisor, shared with the agent sub-plugin (same process, same module instance). */
export function activeSupervisor(): Supervisor | null {
  return current;
}

export function activeRuntime(): PluginRuntime | null {
  return current?.runtime ?? null;
}

function sinkFor(ctx: CordisLikeContext): LogSink {
  const logger = ctx.logger;
  if (!logger) return consoleSink;
  return (level, message) => {
    (logger[level] ?? logger.info)?.call(logger, message);
    if (level === 'warn' || level === 'error') consoleSink(level, message);
  };
}

function storeFor(ctx: CordisLikeContext, dataDir: string): CredentialStore {
  return new LazyCredentialStore(() => {
    const credentials = host.credentials(ctx);
    return credentials ? new DshCredentialStore(credentials) : new EncryptedFileCredentialStore(dataDir);
  });
}

export function createRuntime(ctx: CordisLikeContext, rawConfig: Partial<TwitchConfig> | undefined): PluginRuntime {
  const config = resolveConfig(rawConfig as never);
  const dataDir = dataDirFor();
  return new PluginRuntime({
    config,
    store: storeFor(ctx, dataDir),
    settingsStore: JsonSettingsStore.inDir(dataDir),
    logger: createLogger(sinkFor(ctx), PLUGIN_NAME),
  });
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

export function applyPlugin(ctx: CordisLikeContext, rawConfig: Partial<TwitchConfig> | undefined, makeSupervisor?: (rt: PluginRuntime) => Supervisor): void {
  const runtime = createRuntime(ctx, rawConfig);
  if (!runtime.config.enabled) {
    runtime.logger.info('disabled by config (enabled: false)');
    return;
  }
  const agentPort = new DshAgentPort({ agents: () => host.agents(ctx), sessionController: () => host.sessionController(ctx), timers: realTimers });
  const sup = makeSupervisor ? makeSupervisor(runtime) : new Supervisor(runtime, { agentPort });

  ctx.effect(() => {
    current = sup;
    void runtime.start(() => sup.boot());
    runtime.onStop(() => sup.shutdown());
    return () => {
      if (current === sup) current = null;
      void runtime.stop();
    };
  }, `${PLUGIN_NAME} runtime`);

  const env = (sessionId?: string) => ({ sup, agentsAvailable: agentPort.available(), ...(sessionId ? { sessionId } : {}) });

  const commands = host.commands(ctx);
  if (commands) {
    ctx.effect(() => commands.register({
      name: 'twitch',
      description: 'Twitch chat: setup | auth | status | connect | disconnect | reply | dryrun | test',
      input: { hint: 'status' },
      handler: async (inv) => {
        const out = await runCommand(inv.rawInput, env(inv.agent?.id));
        return out.ok ? { kind: 'success', text: out.text } : { kind: 'error', text: out.text };
      },
    }), `${PLUGIN_NAME} command`);
  } else {
    runtime.logger.info('DSH command service not available in this profile; use the HTTP routes');
  }

  const connection = host.connection(ctx);
  if (connection) {
    const route = (path: string, methods: string[], fetch: (request: Request) => Response | Promise<Response>) =>
      ctx.effect(() => connection.fetch.register({ path: `/api/${PLUGIN_NAME}${path}`, methods, requestBody: 'buffered', fetch }), `${PLUGIN_NAME} ${path}`);
    route('/status', ['GET'], () => json({ ok: true, status: runtime.status.snapshot() }));
    // POST /api/dsh-livestream-twitch/command { "input": "connect <session-id>" } — same grammar as /twitch
    route('/command', ['POST'], async (request) => {
      let input = '';
      try {
        input = String(((await request.json()) as { input?: unknown }).input ?? '');
      } catch { /* empty body */ }
      const out = await runCommand(input, env());
      return json({ ok: out.ok, text: out.text }, out.ok ? 200 : 400);
    });
  }
}
