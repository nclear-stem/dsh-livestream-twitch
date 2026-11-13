import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/commands';
import { setupCommand } from '../../src/commands/setup';
import { FAKE, frames } from '../helpers';
import { connectedHarness } from '../harness';

describe('/twitch commands', () => {
  it('connect binds the invoking session only after chat starts', async () => {
    const h = connectedHarness();
    h.store.grant = undefined;
    await h.sup.boot();
    const fail = await runCommand('connect', { sup: h.sup, sessionId: 'session-123456', agentsAvailable: true });
    expect(fail.ok).toBe(false);
    expect(h.runtime.settings.boundSessionId).toBeNull();

    const ok = connectedHarness();
    await ok.sup.boot();
    const res = await runCommand('connect', { sup: ok.sup, sessionId: 'session-123456', agentsAvailable: true });
    expect(res.ok).toBe(true);
    expect(ok.runtime.settings.boundSessionId).toBe('session-123456');
    ok.sockets[0]!.server(frames.welcome('S'));
  });

  it('reply/dryrun toggles persist and are reflected in status', async () => {
    const h = connectedHarness();
    await h.sup.boot();
    await runCommand('reply on', { sup: h.sup, agentsAvailable: true });
    await runCommand('dryrun off', { sup: h.sup, agentsAvailable: true });
    expect(h.runtime.autoReply).toBe(true);
    expect(h.runtime.dryRun).toBe(false);
    expect((await runCommand('status', { sup: h.sup, agentsAvailable: true })).text).toContain('autoReply on, dry-run off');
    expect((await runCommand('reply maybe', { sup: h.sup, agentsAvailable: true })).ok).toBe(false);
  });

  it('test passes offline and status/setup never print secrets', async () => {
    const h = connectedHarness();
    await h.sup.boot();
    const t = await runCommand('test', { sup: h.sup, agentsAvailable: true });
    expect(t.ok).toBe(true);
    expect(h.f.calls.filter((c) => !c.url.endsWith('/validate'))).toHaveLength(0);
    const setup = await setupCommand(h.sup, { agentsAvailable: true }, { portFree: async () => true, hasWebSocket: () => true, nodeVersion: '26.0.0' });
    const status = (await runCommand('status', { sup: h.sup, agentsAvailable: true })).text;
    for (const text of [setup, status, t.text]) {
      for (const secret of [FAKE.clientSecret, FAKE.access, FAKE.refresh]) expect(text).not.toContain(secret);
    }
    expect(setup).toContain('[ok  ] Client ID and Client Secret are set');
  });

  it('unknown subcommands print usage', async () => {
    const h = connectedHarness();
    const r = await runCommand('frobnicate', { sup: h.sup, agentsAvailable: true });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Usage: /twitch');
  });
});
