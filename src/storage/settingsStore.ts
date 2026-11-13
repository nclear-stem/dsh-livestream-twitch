/**
 * Runtime settings changed from commands (not secrets): which DSH session the bridge talks to and the live
 * toggles that override the patch config. Stored as JSON under `$DSH_HOME/dsh-livestream-twitch/settings.json`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RuntimeSettings {
  boundSessionId: string | null;
  autoReply?: boolean;
  dryRun?: boolean;
}

export interface SettingsStore {
  load(): RuntimeSettings;
  save(settings: RuntimeSettings): void;
}

export class JsonSettingsStore implements SettingsStore {
  constructor(private readonly file: string) {}

  static inDir(dataDir: string): JsonSettingsStore {
    return new JsonSettingsStore(join(dataDir, 'settings.json'));
  }

  load(): RuntimeSettings {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RuntimeSettings>;
      return {
        boundSessionId: typeof raw.boundSessionId === 'string' ? raw.boundSessionId : null,
        ...(typeof raw.autoReply === 'boolean' ? { autoReply: raw.autoReply } : {}),
        ...(typeof raw.dryRun === 'boolean' ? { dryRun: raw.dryRun } : {}),
      };
    } catch {
      return { boundSessionId: null };
    }
  }

  save(settings: RuntimeSettings): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export class MemorySettingsStore implements SettingsStore {
  constructor(private value: RuntimeSettings = { boundSessionId: null }) {}
  load(): RuntimeSettings {
    return { ...this.value };
  }
  save(settings: RuntimeSettings): void {
    this.value = { ...settings };
  }
}
