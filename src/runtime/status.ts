/**
 * Observable plugin status. Contains no secrets by construction: only states, identity (public), scopes,
 * counters and redacted error strings. `snapshot()` is what status commands and the HTTP route return.
 */

import type { TwitchIdentity } from '../domain/user';
import { redact } from './redact';

export type AuthState = 'unconfigured' | 'unauthorized' | 'authorizing' | 'validating' | 'valid' | 'reauthorization_required';
export type EventSubState = 'stopped' | 'connecting' | 'subscribing' | 'connected' | 'reconnecting' | 'failed';

export interface SubscriptionStatus {
  type: string;
  version: string;
  state: 'enabled' | 'disabled' | 'failed' | 'revoked';
  reason?: string;
}

export interface StatusSnapshot {
  auth: {
    state: AuthState;
    identity: TwitchIdentity | null;
    scopes: string[];
    expiresAt: number | null;
    lastValidatedAt: number | null;
    store: string;
    pendingAuthorizeUrl: string | null;
  };
  eventsub: {
    state: EventSubState;
    sessionId: string | null;
    lastKeepaliveAt: number | null;
    reconnects: number;
    subscriptions: SubscriptionStatus[];
  };
  bridge: {
    boundSessionId: string | null;
    autoReply: boolean;
    dryRun: boolean;
    queued: number;
    received: number;
    ignoredSelf: number;
    duplicates: number;
    agentCalls: number;
    agentTimeouts: number;
    dropped: number;
    sent: number;
    dryRunReplies: number;
    sendFailures: number;
  };
  lastError: string | null;
  recent: string[];
}

type Listener = (s: StatusSnapshot) => void;

export class StatusStore {
  private s: StatusSnapshot = {
    auth: { state: 'unconfigured', identity: null, scopes: [], expiresAt: null, lastValidatedAt: null, store: 'none', pendingAuthorizeUrl: null },
    eventsub: { state: 'stopped', sessionId: null, lastKeepaliveAt: null, reconnects: 0, subscriptions: [] },
    bridge: {
      boundSessionId: null, autoReply: false, dryRun: true, queued: 0, received: 0, ignoredSelf: 0, duplicates: 0,
      agentCalls: 0, agentTimeouts: 0, dropped: 0, sent: 0, dryRunReplies: 0, sendFailures: 0,
    },
    lastError: null,
    recent: [],
  };
  private listeners = new Set<Listener>();

  snapshot(): StatusSnapshot {
    return structuredClone(this.s);
  }

  auth(patch: Partial<StatusSnapshot['auth']>): void {
    Object.assign(this.s.auth, patch);
    this.emit();
  }

  eventsub(patch: Partial<StatusSnapshot['eventsub']>): void {
    Object.assign(this.s.eventsub, patch);
    this.emit();
  }

  bridge(patch: Partial<StatusSnapshot['bridge']>): void {
    Object.assign(this.s.bridge, patch);
    this.emit();
  }

  count(key: 'received' | 'ignoredSelf' | 'duplicates' | 'agentCalls' | 'agentTimeouts' | 'dropped' | 'sent' | 'dryRunReplies' | 'sendFailures', by = 1): void {
    this.s.bridge[key] += by;
    this.emit();
  }

  error(err: unknown): void {
    this.s.lastError = redact(err instanceof Error ? err.message : err);
    this.note(`error: ${this.s.lastError}`);
  }

  /** Short human-readable trail of what happened (redacted, last 30 lines). */
  note(line: string): void {
    this.s.recent.push(`${new Date().toISOString()} ${redact(line)}`);
    if (this.s.recent.length > 30) this.s.recent.splice(0, this.s.recent.length - 30);
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l(this.s);
      } catch {
        // observers never break status updates
      }
    }
  }
}

/** Plain-text rendering for slash commands. */
export function formatStatus(s: StatusSnapshot): string {
  const id = s.auth.identity;
  const lines = [
    `Auth: ${s.auth.state}${id ? ` as ${id.displayName} (login ${id.login}, user ID ${id.userId})` : ''}`,
    `Scopes: ${s.auth.scopes.length ? s.auth.scopes.join(' ') : '(none)'}`,
    `Token store: ${s.auth.store}${s.auth.lastValidatedAt ? `, last validated ${new Date(s.auth.lastValidatedAt).toISOString()}` : ''}`,
    `EventSub: ${s.eventsub.state}${s.eventsub.sessionId ? ` (session ${s.eventsub.sessionId.slice(0, 8)}…)` : ''}, reconnects ${s.eventsub.reconnects}`,
    ...s.eventsub.subscriptions.map((sub) => `  - ${sub.type} v${sub.version}: ${sub.state}${sub.reason ? ` (${sub.reason})` : ''}`),
    `Agent bridge: ${s.bridge.boundSessionId ? `session ${s.bridge.boundSessionId}` : 'no session bound'}, autoReply ${s.bridge.autoReply ? 'on' : 'off'}, dry-run ${s.bridge.dryRun ? 'on' : 'off'}`,
    `Messages: received ${s.bridge.received}, own ignored ${s.bridge.ignoredSelf}, duplicates ${s.bridge.duplicates}, queued ${s.bridge.queued}, dropped ${s.bridge.dropped}`,
    `Replies: agent calls ${s.bridge.agentCalls}, timeouts ${s.bridge.agentTimeouts}, sent ${s.bridge.sent}, dry-run ${s.bridge.dryRunReplies}, failed ${s.bridge.sendFailures}`,
  ];
  if (s.auth.pendingAuthorizeUrl) lines.push(`Pending authorization: ${s.auth.pendingAuthorizeUrl}`);
  if (s.lastError) lines.push(`Last error: ${s.lastError}`);
  return lines.join('\n');
}
