/**
 * Supervisor: composes TokenManager, the authorization flow and its callback server (and, from M2, EventSub
 * and the agent bridge) and owns their ordering. Commands and HTTP routes call into this class only.
 */

import { AuthorizationError, AuthorizationFlow, type AuthorizationResult } from '../auth/oauth';
import { startCallbackServer, type CallbackServerHandle, type CallbackServerOptions } from '../auth/callbackServer';
import { requestedScopes } from '../auth/scopes';
import { TokenManager, type Scheduler } from '../auth/tokenManager';
import { ReplyDispatcher } from '../agent/replyDispatcher';
import { EventBridge } from '../agent/eventBridge';
import type { AgentPort } from '../agent/agentPort';
import { OAUTH_TRANSACTION_TTL_MS } from '../config/defaults';
import { callbackPath, ConfigError } from '../config/schema';
import type { DecodedEvent } from '../domain/events';
import { HelixChatClient, type ChatSender } from '../twitch/chatClient';
import { decodeNotification } from '../twitch/eventsub/decoder';
import { EventSubSession, type NotificationFrame, type RevocationFrame } from '../twitch/eventsub/sessionManager';
import { createSubscription, planSubscriptions } from '../twitch/eventsub/subscriptionRegistry';
import { globalWebSocketFactory, type SocketFactory } from '../twitch/eventsub/websocketClient';
import { HelixClient } from '../twitch/helixClient';
import { fetchSelf } from '../twitch/users';
import { defaultFetch, type HttpFetch } from './http';
import type { PluginRuntime } from './lifecycle';
import { registerSecret } from './redact';
import type { SubscriptionStatus } from './status';
import { realTimers, type Timers } from './timers';

export interface SupervisorDeps {
  fetch?: HttpFetch;
  scheduler?: Scheduler;
  startCallbackServer?: (opts: CallbackServerOptions) => Promise<CallbackServerHandle>;
  now?: () => number;
  socketFactory?: SocketFactory;
  timers?: Timers;
  chat?: ChatSender;
  agentPort?: AgentPort;
}

export class NotReadyError extends Error {}

export interface AuthStart {
  url: string;
  callback: string;
  scopes: string[];
}

export class Supervisor {
  readonly tokens: TokenManager;
  readonly fetch: HttpFetch;
  readonly helix: HelixClient;
  readonly dispatcher: ReplyDispatcher;
  readonly bridge: EventBridge | null;
  readonly timers: Timers;
  private readonly flow: AuthorizationFlow;
  private callback: CallbackServerHandle | null = null;
  private lastAuth: { ok: true; result: AuthorizationResult } | { ok: false; error: string } | null = null;
  private readonly authListeners = new Set<(r: AuthorizationResult) => void>();
  private eventsub: EventSubSession | null = null;
  private subscriptions: SubscriptionStatus[] = [];
  private sink: (event: DecodedEvent) => void;

  constructor(readonly runtime: PluginRuntime, private readonly deps: SupervisorDeps = {}) {
    this.fetch = deps.fetch ?? defaultFetch;
    this.timers = deps.timers ?? realTimers;
    const { store, logger, status, config } = runtime;
    this.sink = (e) => logger.info(`event without a bridge: ${e.kind === 'chat' ? `chat from ${e.chat.sender.login}` : e.event.type}`);
    this.tokens = new TokenManager({
      store, fetch: this.fetch, logger, status,
      clientCredentials: () => this.clientCredentials(),
      ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.helix = new HelixClient(this.tokens, this.fetch, () => this.timers.now());
    this.dispatcher = new ReplyDispatcher({
      chat: deps.chat ?? new HelixChatClient(this.helix),
      broadcaster: () => this.tokens.identity,
      dryRun: () => runtime.dryRun,
      sendEnabled: () => config.chat.send,
      minIntervalMs: config.chat.minReplyIntervalMs,
      maxPerMinute: config.chat.maxRepliesPerMinute,
      logger, status, timers: this.timers,
    });
    this.tokens.onStateChange((state) => {
      if (state === 'reauthorization_required' && this.eventsub) {
        status.note('stopping EventSub: the Twitch authorization is no longer valid');
        this.stopChat();
      }
    });
    this.bridge = deps.agentPort ? new EventBridge({
      agent: deps.agentPort,
      dispatcher: this.dispatcher,
      boundSessionId: () => runtime.settings.boundSessionId,
      broadcaster: () => this.tokens.identity,
      autoReply: () => runtime.autoReply,
      maxQueue: config.chat.maxQueue,
      agentTimeoutMs: config.chat.agentTimeoutMs,
      status, logger, timers: this.timers,
    }) : null;
    if (this.bridge) {
      const bridge = this.bridge;
      this.sink = (e) => bridge.handle(e);
    }
    this.flow = new AuthorizationFlow({
      fetch: this.fetch,
      clientCredentials: () => this.clientCredentials(),
      redirectUri: config.redirectUri,
      expectedLogin: config.expectedBroadcasterLogin,
      boundIdentity: async () => this.tokens.identity ?? (await store.readGrant())?.identity,
      fetchSelf: (auth) => fetchSelf(this.fetch, auth),
      persist: (grant) => this.tokens.replaceGrant(grant),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  get config() {
    return this.runtime.config;
  }

  /** Client ID (config literal or credential) and secret (credential only). */
  async clientCredentials(): Promise<{ clientId: string; clientSecret: string }> {
    const { config, store } = this.runtime;
    const clientId = config.clientId.trim() || (await store.secret(config.clientIdRef))?.trim() || '';
    const clientSecret = (await store.secret(config.clientSecretRef))?.trim() || '';
    if (!clientId) throw new ConfigError(`Twitch Client ID is not set: put it in the plugin config (clientId) or the ${config.clientIdRef} credential`);
    if (!clientSecret) throw new ConfigError(`Twitch Client Secret is not set: store it as the ${config.clientSecretRef} credential (never in YAML)`);
    registerSecret(clientSecret);
    return { clientId, clientSecret };
  }

  async boot(): Promise<void> {
    const state = await this.tokens.start();
    this.runtime.logger.info(`auth state on start: ${state}`);
    const { config, settings } = this.runtime;
    if (config.autoConnect && state === 'valid' && settings.boundSessionId) {
      await this.connect().catch((err) => {
        this.runtime.status.error(`autoConnect failed: ${(err as Error).message}`);
      });
    }
  }

  async shutdown(): Promise<void> {
    this.stopChat();
    this.bridge?.stop();
    this.dispatcher.stop();
    this.tokens.stop();
    await this.cancelAuth();
  }

  /** Where decoded chat/platform events go (the agent bridge from M3). */
  setEventSink(sink: (event: DecodedEvent) => void): void {
    this.sink = sink;
  }

  get chatRunning(): boolean {
    return !!this.eventsub?.isRunning;
  }

  /** Start EventSub with the subscriptions the config and granted scopes allow. */
  async connect(): Promise<{ enabled: SubscriptionStatus[]; disabled: SubscriptionStatus[] }> {
    const { config, status, logger } = this.runtime;
    if (this.tokens.authState !== 'valid') await this.tokens.validateNow();
    if (this.tokens.authState !== 'valid' || !this.tokens.identity) {
      throw new NotReadyError(`not authorized (state ${this.tokens.authState}); run /twitch auth first`);
    }
    const me = this.tokens.identity;
    const plan = planSubscriptions(config, this.tokens.scopes);
    const disabled: SubscriptionStatus[] = plan.disabled.map((d) => ({ type: d.def.type, version: d.def.version, state: 'disabled', reason: d.reason }));
    const chatDef = plan.disabled.find((d) => d.def.essential);
    if (chatDef) throw new NotReadyError(`cannot read chat: ${chatDef.reason}`);
    if (!plan.enabled.length) throw new NotReadyError('nothing to subscribe to (chat.read is off and no events are on)');
    this.stopChat();
    this.subscriptions = [...plan.enabled.map((d) => ({ type: d.type, version: d.version, state: 'disabled' as const, reason: 'pending' })), ...disabled];
    status.eventsub({ subscriptions: this.subscriptions });

    const session = new EventSubSession({
      socketFactory: this.deps.socketFactory ?? globalWebSocketFactory,
      logger, timers: this.timers,
      handlers: {
        subscribe: async (sessionId) => {
          const results = await Promise.all(plan.enabled.map((d) => createSubscription(this.helix, d, sessionId, me)));
          this.subscriptions = [...results, ...disabled];
          status.eventsub({ subscriptions: this.subscriptions });
          const essential = results.find((r, i) => plan.enabled[i]!.essential && r.state !== 'enabled');
          if (essential) throw new Error(`could not subscribe to ${essential.type}: ${essential.reason}`);
          for (const r of results) if (r.state === 'failed') status.note(`${r.type} disabled: ${r.reason}`);
        },
        notification: (frame) => this.onNotification(frame),
        revocation: (frame) => this.onRevocation(frame),
        duplicate: () => status.count('duplicates'),
        state: (state, detail) => status.eventsub({ state, sessionId: detail.sessionId, reconnects: detail.reconnects, ...(detail.lastKeepaliveAt ? { lastKeepaliveAt: detail.lastKeepaliveAt } : {}) }),
      },
    });
    this.eventsub = session;
    session.start();
    logger.info(`EventSub starting for #${me.login}: ${plan.enabled.map((d) => d.type).join(', ')}`);
    return { enabled: plan.enabled.map((d) => ({ type: d.type, version: d.version, state: 'enabled' })), disabled };
  }

  stopChat(): void {
    this.bridge?.clear();
    if (!this.eventsub) return;
    this.eventsub.stop();
    this.eventsub = null;
  }

  private onNotification(frame: NotificationFrame): void {
    const { logger, status } = this.runtime;
    const decoded = decodeNotification(frame);
    if (decoded.kind === 'invalid') {
      logger.warn(`ignored malformed ${frame.subscription.type} event (${decoded.reason})`);
      return;
    }
    if (decoded.kind === 'unsupported') {
      logger.info(`ignored event of unsupported type ${decoded.type}`);
      return;
    }
    const channel = decoded.kind === 'chat' ? decoded.chat.channelId : decoded.event.channelId;
    if (channel !== this.tokens.identity?.userId) {
      logger.warn(`ignored ${frame.subscription.type} for another channel (${channel})`);
      return;
    }
    if (decoded.kind === 'chat') status.count('received');
    try {
      this.sink(decoded);
    } catch (err) {
      logger.warn(`event handler failed: ${(err as Error).message}`);
    }
  }

  private onRevocation(frame: RevocationFrame): void {
    const { status, logger } = this.runtime;
    const { type, status: why } = frame.subscription;
    this.subscriptions = this.subscriptions.map((s) => (s.type === type ? { ...s, state: 'revoked', reason: why } : s));
    status.eventsub({ subscriptions: this.subscriptions });
    logger.warn(`Twitch revoked ${type}: ${why}`);
    status.note(`subscription ${type} revoked (${why})`);
    if (why === 'authorization_revoked' || why === 'user_removed') void this.tokens.validateNow();
  }

  onAuthorized(listener: (r: AuthorizationResult) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  get lastAuthorization() {
    return this.lastAuth;
  }

  /** Start an authorization: open the loopback callback and return the URL for the browser. */
  async beginAuth(opts: { replaceAccount?: boolean } = {}): Promise<AuthStart> {
    const { config, status, logger } = this.runtime;
    await this.clientCredentials();
    await this.cancelAuth();
    const scopes = requestedScopes(config);
    const { url } = await this.flow.begin(scopes, opts);
    const start = this.deps.startCallbackServer ?? startCallbackServer;
    try {
      this.callback = await start({
        host: config.callbackHost,
        port: config.callbackPort,
        path: callbackPath(config),
        timeoutMs: OAUTH_TRANSACTION_TTL_MS,
        onCallback: (query) => this.handleCallback(query),
        onClosed: (reason) => {
          this.callback = null;
          this.flow.transactions.clear();
          status.auth({ pendingAuthorizeUrl: null });
          if (reason === 'timeout') status.note('authorization timed out');
          if (status.snapshot().auth.state === 'authorizing') status.auth({ state: this.tokens.authState });
        },
      });
    } catch (err) {
      this.flow.transactions.clear();
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(code === 'EADDRINUSE'
        ? `port ${config.callbackPort} on ${config.callbackHost} is busy; free it or change callbackPort and the registered Redirect URL together`
        : `could not start the OAuth callback server: ${(err as Error).message}`);
    }
    status.auth({ state: 'authorizing', pendingAuthorizeUrl: url });
    logger.info(`authorization started; callback listening on ${this.callback.address}`);
    return { url, callback: this.callback.address, scopes };
  }

  async cancelAuth(): Promise<void> {
    await this.callback?.close('stopped');
    this.callback = null;
  }

  private async handleCallback(query: URLSearchParams) {
    try {
      const result = await this.flow.complete(query);
      this.lastAuth = { ok: true, result };
      const id = result.identity;
      this.runtime.status.note(`authorized as ${id.login} (${id.userId}); scopes ${result.scopes.join(' ')}`);
      if (result.missingScopes.length) this.runtime.status.note(`not granted: ${result.missingScopes.join(' ')} (features using them stay off)`);
      for (const l of this.authListeners) l(result);
      return { status: 200, title: 'Twitch connected', message: `Authorized as ${id.displayName} (${id.login}). You can close this tab and return to DSH.`, done: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastAuth = { ok: false, error: message };
      this.runtime.status.error(`authorization failed: ${message}`);
      // Unknown/used state: keep waiting for the real callback. Anything else ends this attempt.
      const keepOpen = err instanceof AuthorizationError && (err.code === 'unknown_state' || err.code === 'already_used');
      if (!keepOpen) this.runtime.status.auth({ state: this.tokens.authState });
      return { status: 400, title: 'Twitch authorization failed', message, done: !keepOpen };
    }
  }

  async disconnect(opts: { forget: boolean }): Promise<{ revoked: boolean }> {
    this.stopChat();
    await this.cancelAuth();
    if (!opts.forget) return { revoked: false };
    return this.tokens.forget({ revoke: this.runtime.config.revokeOnForget });
  }
}
