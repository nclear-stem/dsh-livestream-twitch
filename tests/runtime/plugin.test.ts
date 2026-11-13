import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, resolveConfig } from '../../src/config/schema';
import * as entry from '../../src/index';
import { activeRuntime } from '../../src/plugin';
import { fakeContext } from '../helpers';

describe('config', () => {
  it('defaults to chat-only, dry-run, no auto reply', () => {
    const cfg = resolveConfig(undefined);
    expect(cfg.chat.dryRun).toBe(true);
    expect(cfg.chat.autoReply).toBe(false);
    expect(cfg.events).toEqual({ follow: false, subscription: false, cheer: false, raid: false });
    expect(cfg.redirectUri).toBe('http://localhost:17123/oauth/twitch/callback');
  });

  it('refuses non-loopback callback hosts and redirect URIs', () => {
    expect(() => resolveConfig({ callbackHost: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => resolveConfig({ redirectUri: 'https://example.com/cb' })).toThrow(ConfigError);
  });

  it('the exported Config schema accepts the defaults', () => {
    const result = entry.Config['~standard'].validate({}) as { value?: unknown; issues?: unknown };
    expect(result.issues).toBeUndefined();
    expect((result.value as typeof DEFAULT_CONFIG).callbackPort).toBe(17123);
  });
});

describe('plugin entry', () => {
  let home: string;
  const prev = process.env.DSH_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-twitch-'));
    process.env.DSH_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  });

  it('exposes the Cordis plugin shape and only injects connection', () => {
    expect(entry.name).toBe('dsh-livestream-twitch');
    expect(entry.inject).toEqual(['connection']);
    expect(typeof entry.apply).toBe('function');
  });

  it('loads, registers its command and route, and unloads cleanly', async () => {
    const commands: string[] = [];
    const routes: string[] = [];
    const { ctx, dispose } = fakeContext({
      commands: { register: (d: { name: string }) => { commands.push(d.name); return () => commands.splice(commands.indexOf(d.name), 1); } },
      connection: { fetch: { register: (r: { path: string }) => { routes.push(r.path); return () => routes.splice(routes.indexOf(r.path), 1); } } },
    });
    entry.apply(ctx, {});
    expect(activeRuntime()).not.toBeNull();
    expect(commands).toContain('twitch');
    expect(routes).toContain('/api/dsh-livestream-twitch/status');
    dispose();
    expect(activeRuntime()).toBeNull();
    expect(commands).toEqual([]);
    expect(routes).toEqual([]);
  });

  it('does nothing when disabled', () => {
    const { ctx } = fakeContext({});
    entry.apply(ctx, { enabled: false });
    expect(activeRuntime()).toBeNull();
  });
});
