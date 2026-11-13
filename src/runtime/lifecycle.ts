/**
 * The plugin's runtime object: one per DSH process, created on plugin apply, disposed on unload.
 * Holds the shared pieces (config, status, stores) and owns start/stop ordering. Twitch-facing behavior is
 * composed in by the supervisor; this file only knows the lifecycle.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_NAME } from '../config/defaults';
import type { TwitchConfig } from '../config/schema';
import type { CredentialStore } from '../storage/credentialStore';
import type { RuntimeSettings, SettingsStore } from '../storage/settingsStore';
import type { Logger } from './redact';
import { StatusStore } from './status';

export function dataDirFor(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), PLUGIN_NAME);
}

export interface RuntimeParts {
  config: TwitchConfig;
  store: CredentialStore;
  settingsStore: SettingsStore;
  logger: Logger;
  status?: StatusStore;
}

export class PluginRuntime {
  readonly config: TwitchConfig;
  readonly store: CredentialStore;
  readonly logger: Logger;
  readonly status: StatusStore;
  private readonly settingsStore: SettingsStore;
  private settingsValue: RuntimeSettings;
  private readonly stops: Array<() => void | Promise<void>> = [];
  private started = false;

  constructor(parts: RuntimeParts) {
    this.config = parts.config;
    this.store = parts.store;
    this.logger = parts.logger;
    this.status = parts.status ?? new StatusStore();
    this.settingsStore = parts.settingsStore;
    this.settingsValue = this.settingsStore.load();
    this.status.auth({ store: this.store.kind });
    this.status.bridge({ boundSessionId: this.settingsValue.boundSessionId, autoReply: this.autoReply, dryRun: this.dryRun });
  }

  get settings(): RuntimeSettings {
    return { ...this.settingsValue };
  }

  get autoReply(): boolean {
    return this.settingsValue.autoReply ?? this.config.chat.autoReply;
  }

  get dryRun(): boolean {
    return this.settingsValue.dryRun ?? this.config.chat.dryRun;
  }

  updateSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
    this.settingsValue = { ...this.settingsValue, ...patch };
    this.settingsStore.save(this.settingsValue);
    this.status.bridge({ boundSessionId: this.settingsValue.boundSessionId, autoReply: this.autoReply, dryRun: this.dryRun });
    return this.settings;
  }

  /** Register teardown, run in reverse order on stop. */
  onStop(stop: () => void | Promise<void>): void {
    this.stops.push(stop);
  }

  async start(boot: () => Promise<void>): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await boot();
    } catch (err) {
      this.status.error(err);
      this.logger.warn(`start failed: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const stop of this.stops.splice(0).reverse()) {
      try {
        await stop();
      } catch (err) {
        this.logger.warn(`stop step failed: ${(err as Error).message}`);
      }
    }
  }
}
