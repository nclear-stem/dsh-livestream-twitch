import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DshCredentialStore, EncryptedFileCredentialStore, type StoredGrant } from '../../src/storage/credentialStore';
import type { DshCredentialRecord, DshCredentials } from '../../src/dsh/host';
import { redact, registerSecret } from '../../src/runtime/redact';
import { FAKE, grant } from '../helpers';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('encrypted file store', () => {
  it('writes 0600 file in a 0700 directory, encrypted at rest, and reads it back', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'twitch-store-')), 'data');
    const store = new EncryptedFileCredentialStore(dir, () => KEY);
    await store.modifyGrant(async () => grant());
    expect(statSync(join(dir, 'grant.enc')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, 'grant.enc')).toString('latin1')).not.toContain(FAKE.refresh);
    expect((await store.readGrant())?.refreshToken).toBe(FAKE.refresh);
  });

  it('refuses to work without a key and refuses a world-readable file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twitch-store-'));
    await expect(new EncryptedFileCredentialStore(dir, () => undefined).modifyGrant(async () => grant())).rejects.toThrow(/DSH_TWITCH_STORE_KEY/);
    const store = new EncryptedFileCredentialStore(dir, () => KEY);
    await store.modifyGrant(async () => grant());
    chmodSync(join(dir, 'grant.enc'), 0o644);
    await expect(store.readGrant()).rejects.toThrow(/readable beyond its owner/);
  });

  it('rejects a wrong key (authenticated encryption)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twitch-store-'));
    await new EncryptedFileCredentialStore(dir, () => KEY).modifyGrant(async () => grant());
    await expect(new EncryptedFileCredentialStore(dir, () => Buffer.alloc(32, 9).toString('base64')).readGrant()).rejects.toThrow();
  });
});

describe('DSH credential store adapter', () => {
  it('stores the grant as a grant record under the plugin scope and resolves secrets by reference', async () => {
    const records = new Map<string, DshCredentialRecord>();
    const creds: DshCredentials = {
      resolve: async (ref) => (ref === 'TWITCH_CLIENT_SECRET' ? { value: FAKE.clientSecret, source: 'file' } : undefined),
      readRecord: async (k) => records.get(k),
      modifyRecord: async (k, mutate) => { const next = await mutate(records.get(k)); if (next) records.set(k, next); return records.get(k); },
      deleteRecord: async (k) => { records.delete(k); },
    };
    const store = new DshCredentialStore(creds);
    await store.modifyGrant(async () => grant());
    expect(records.get('dsh-livestream-twitch/broadcaster')?.kind).toBe('grant');
    expect(((await store.readGrant()) as StoredGrant).identity.userId).toBe('1001');
    expect(await store.secret('TWITCH_CLIENT_SECRET')).toBe(FAKE.clientSecret);
    await store.deleteGrant();
    expect(await store.readGrant()).toBeUndefined();
  });
});

describe('redaction', () => {
  it('masks headers, form fields, JSON fields and registered secrets', () => {
    registerSecret('registeredsecretvalue123');
    const text = redact('Authorization: Bearer abc.def OAuth zzz access_token=aaa&refresh_token=bbb {"refresh_token":"ccc"} code=xyz registeredsecretvalue123');
    for (const leaked of ['abc.def', 'zzz', 'aaa', 'bbb', 'ccc', 'xyz', 'registeredsecretvalue123']) expect(text).not.toContain(leaked);
  });
});
