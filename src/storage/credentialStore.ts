/**
 * Where the Twitch grant (access + refresh token) and the client secret live.
 *
 *  1. DshCredentialStore (default): the DSH credential service. The grant is a `grant` record under
 *     `dsh-livestream-twitch/broadcaster`; DSH's local provider keeps it in `$DSH_HOME/.credentials.yaml`
 *     (refuses to start when that file is readable beyond its owner) and serializes `modifyRecord`
 *     across processes, which is what makes refresh-token rotation safe. The client secret is a credential
 *     reference (TWITCH_CLIENT_SECRET) resolved per operation.
 *  2. EncryptedFileCredentialStore (fallback when DSH has no credential service): AES-256-GCM file,
 *     directory 0700, file 0600, key from DSH_TWITCH_STORE_KEY (32 bytes, base64 or hex) which the user
 *     keeps outside the data directory. Without the key the fallback refuses to store anything.
 *  3. MemoryCredentialStore: tests only.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GRANT_RECORD_KEY } from '../config/defaults';
import type { DshCredentials } from '../dsh/host';
import type { TwitchIdentity } from '../domain/user';
import { registerSecret } from '../runtime/redact';

export interface StoredGrant {
  version: 1;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms; informational, validation and 401 handling are authoritative. */
  expiresAt: number;
  scopes: string[];
  identity: TwitchIdentity;
  obtainedAt: number;
}

export interface CredentialStore {
  readonly kind: string;
  readGrant(): Promise<StoredGrant | undefined>;
  /** Serialized read-modify-write. Returning undefined leaves the stored grant untouched. */
  modifyGrant(mutate: (current: StoredGrant | undefined) => Promise<StoredGrant | undefined>): Promise<StoredGrant | undefined>;
  deleteGrant(): Promise<void>;
  /** Resolve a non-grant secret (client secret / client id) by reference name. */
  secret(ref: string): Promise<string | undefined>;
}

export function isStoredGrant(value: unknown): value is StoredGrant {
  const v = value as Partial<StoredGrant> | null;
  return !!v && v.version === 1 && typeof v.accessToken === 'string' && typeof v.refreshToken === 'string'
    && typeof v.clientId === 'string' && Array.isArray(v.scopes) && !!v.identity && typeof v.identity.userId === 'string';
}

function remember(grant: StoredGrant | undefined): StoredGrant | undefined {
  if (grant) {
    registerSecret(grant.accessToken);
    registerSecret(grant.refreshToken);
  }
  return grant;
}

export class DshCredentialStore implements CredentialStore {
  readonly kind = 'dsh-credentials';
  constructor(private readonly credentials: DshCredentials, private readonly key = GRANT_RECORD_KEY) {}

  async readGrant(): Promise<StoredGrant | undefined> {
    const record = await this.credentials.readRecord(this.key);
    return remember(record?.kind === 'grant' && isStoredGrant(record.payload) ? record.payload : undefined);
  }

  async modifyGrant(mutate: (current: StoredGrant | undefined) => Promise<StoredGrant | undefined>): Promise<StoredGrant | undefined> {
    const after = await this.credentials.modifyRecord(this.key, async (current) => {
      const grant = current?.kind === 'grant' && isStoredGrant(current.payload) ? current.payload : undefined;
      const next = await mutate(remember(grant));
      return next ? { kind: 'grant', payload: next } : undefined;
    });
    return remember(after?.kind === 'grant' && isStoredGrant(after.payload) ? after.payload : undefined);
  }

  async deleteGrant(): Promise<void> {
    await this.credentials.deleteRecord(this.key);
  }

  async secret(ref: string): Promise<string | undefined> {
    const hit = await this.credentials.resolve(ref).catch(() => undefined);
    registerSecret(hit?.value);
    return hit?.value || undefined;
  }
}

/** In-process async mutex (the cross-process part is the lock file in the file store). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class StoreKeyError extends Error {}

export function parseStoreKey(raw: string | undefined): Buffer {
  const text = (raw ?? '').trim();
  if (!text) throw new StoreKeyError('DSH_TWITCH_STORE_KEY is not set: the encrypted file store needs a 32-byte key (openssl rand -base64 32)');
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new StoreKeyError('DSH_TWITCH_STORE_KEY must decode to exactly 32 bytes (base64 or hex)');
  return key;
}

export class EncryptedFileCredentialStore implements CredentialStore {
  readonly kind = 'encrypted-file';
  private readonly file: string;
  private readonly mutex = new Mutex();

  constructor(dir: string, private readonly keyText: () => string | undefined = () => process.env.DSH_TWITCH_STORE_KEY,
    private readonly env: (name: string) => string | undefined = (n) => process.env[n]) {
    this.file = join(dir, 'grant.enc');
  }

  async readGrant(): Promise<StoredGrant | undefined> {
    return remember(this.readUnlocked());
  }

  modifyGrant(mutate: (current: StoredGrant | undefined) => Promise<StoredGrant | undefined>): Promise<StoredGrant | undefined> {
    return this.mutex.run(() => this.withFileLock(async () => {
      const current = remember(this.readUnlocked());
      const next = await mutate(current);
      if (!next) return current;
      this.write(next);
      return remember(next);
    }));
  }

  async deleteGrant(): Promise<void> {
    await this.mutex.run(() => this.withFileLock(async () => rmSync(this.file, { force: true })));
  }

  async secret(ref: string): Promise<string | undefined> {
    const value = this.env(ref);
    registerSecret(value);
    return value || undefined;
  }

  private readUnlocked(): StoredGrant | undefined {
    let blob: Buffer;
    try {
      const mode = statSync(this.file).mode & 0o777;
      if (mode & 0o077) throw new Error(`${this.file} is readable beyond its owner (mode ${mode.toString(8)}); run chmod 600 on it`);
      blob = readFileSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const key = parseStoreKey(this.keyText());
    const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), body = blob.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return isStoredGrant(parsed) ? parsed : undefined;
  }

  private write(grant: StoredGrant): void {
    const key = parseStoreKey(this.keyText());
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.file), 0o700);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(grant), 'utf8'), cipher.final()]);
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Cross-process exclusion via an O_EXCL lock file; a lock older than 30 s is treated as stale. */
  private async withFileLock<T>(task: () => Promise<T>): Promise<T> {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx', 0o600));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true });
        } catch { /* raced with the owner */ }
        if (Date.now() > deadline) throw new Error('timed out waiting for the Twitch credential lock');
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await task();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly kind = 'memory';
  private readonly mutex = new Mutex();
  writes = 0;
  constructor(public grant: StoredGrant | undefined = undefined, public secrets: Record<string, string> = {}) {}

  async readGrant(): Promise<StoredGrant | undefined> {
    return this.grant ? structuredClone(this.grant) : undefined;
  }

  modifyGrant(mutate: (current: StoredGrant | undefined) => Promise<StoredGrant | undefined>): Promise<StoredGrant | undefined> {
    return this.mutex.run(async () => {
      const next = await mutate(this.grant ? structuredClone(this.grant) : undefined);
      if (next) {
        this.grant = structuredClone(next);
        this.writes++;
      }
      return this.grant ? structuredClone(this.grant) : undefined;
    });
  }

  async deleteGrant(): Promise<void> {
    this.grant = undefined;
  }

  async secret(ref: string): Promise<string | undefined> {
    return this.secrets[ref];
  }
}

/**
 * Picks the backing store on first use rather than at plugin apply, because DSH services are not
 * guaranteed to be registered when a non-injecting plugin applies.
 */
export class LazyCredentialStore implements CredentialStore {
  private chosen: CredentialStore | null = null;
  constructor(private readonly choose: () => CredentialStore) {}
  private get inner(): CredentialStore {
    return (this.chosen ??= this.choose());
  }
  get kind(): string {
    return this.inner.kind;
  }
  readGrant(): Promise<StoredGrant | undefined> {
    return this.inner.readGrant();
  }
  modifyGrant(mutate: (current: StoredGrant | undefined) => Promise<StoredGrant | undefined>): Promise<StoredGrant | undefined> {
    return this.inner.modifyGrant(mutate);
  }
  deleteGrant(): Promise<void> {
    return this.inner.deleteGrant();
  }
  secret(ref: string): Promise<string | undefined> {
    return this.inner.secret(ref);
  }
}
