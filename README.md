# dsh-livestream-twitch

A DeepSeek Harness (DSH) plugin that lets a DSH agent answer **Twitch chat as the broadcaster**. Chat arrives over
the official EventSub WebSocket; replies go out through the official Helix Send Chat Message API, using the
broadcaster's own account. One account, one authorization, no bot account.

This is an independent project. It does not depend on, modify, or share code with the Bilibili
`dsh-livestream` plugin, and it ships no character art.

## What works

- OAuth Authorization Code Grant (confidential client) with a loopback-only callback; one-time `state`;
  bound-account guard by Twitch user ID; optional expected login.
- Tokens in the DSH credential store; validation on start and hourly; one serialized refresh on 401 with the
  rotated refresh token persisted before use; `reauthorization_required` on rejection; revoke on forget.
- EventSub WebSocket: welcome/keepalive/reconnect-migration/revocation/close handling, backoff and resubscribe,
  dedupe by message id. `channel.chat.message` v1, and optionally `channel.follow` v2, `channel.subscribe`,
  `channel.subscription.gift`, `channel.subscription.message`, `channel.cheer`, `channel.raid` (all v1), each
  requested and subscribed only when switched on.
- Agent bridge: each viewer message becomes one follow-up turn in a DSH session you bind; the turn's text is the
  reply. The broadcaster's own messages never reach the agent. Bounded queue, timeout, `[skip]`.
- Reply dispatcher: dry-run (default on), minimum interval, per-minute cap, 429/5xx bounded retries, no resend
  when the outcome is unknown, 500-character limit.
- `/twitch setup | auth | status | connect | disconnect | reply | dryrun | test`, plus HTTP routes.
- Redacted logs; secret scan in the release check.

## Quick start

1. Register a Confidential app with Redirect URL `http://localhost:17123/oauth/twitch/callback` and store the
   secret as the `TWITCH_CLIENT_SECRET` credential: [docs/oauth.md](docs/oauth.md).
2. Build and install into a DSH profile: [docs/local-deployment.md](docs/local-deployment.md).
3. In a session: `/twitch setup`, `/twitch auth`, `/twitch connect`, `/twitch reply on`. Watch dry-run
   replies in `/twitch status`, then `/twitch dryrun off`.

Remote server: [docs/remote-deployment.md](docs/remote-deployment.md) (SSH tunnel for the OAuth callback only).
Problems: [docs/troubleshooting.md](docs/troubleshooting.md).

## Configuration

Defaults are in [cordis.patch.yml](cordis.patch.yml) and `src/config/schema.ts`. No secrets go in YAML.

| Key | Default | Meaning |
|---|---|---|
| `clientId` | `''` | Client ID; empty = `TWITCH_CLIENT_ID` credential |
| `clientSecretRef` | `TWITCH_CLIENT_SECRET` | Credential reference for the Client Secret |
| `redirectUri` | `http://localhost:17123/oauth/twitch/callback` | Must equal the console entry |
| `callbackHost` / `callbackPort` | `127.0.0.1` / `17123` | Loopback only (`0.0.0.0` is rejected) |
| `expectedBroadcasterLogin` | `''` | Reject other accounts at authorization |
| `autoConnect` | `false` | Start EventSub on DSH start |
| `revokeOnForget` | `true` | Revoke at Twitch on `disconnect --forget` |
| `chat.read` / `chat.send` | `true` / `true` | Subscribe to chat / allow posting |
| `chat.autoReply` | `false` | Hand messages to the bound session (`/twitch reply on`) |
| `chat.dryRun` | `true` | Generate replies but never post (`/twitch dryrun off`) |
| `chat.minReplyIntervalMs` / `chat.maxRepliesPerMinute` | `3000` / `15` | Pacing |
| `chat.maxQueue` / `chat.agentTimeoutMs` | `20` / `90000` | Inbound queue size / agent turn timeout |
| `events.follow` / `subscription` / `cheer` / `raid` | `false` | Optional events (each adds its scope) |

`reply` and `dryrun` toggles and the bound session are stored in `$DSH_HOME/dsh-livestream-twitch/settings.json`.

## One instance per channel

Run one active instance per Twitch channel. There is no leader election; two instances answer twice and
compete for the same refresh token.

## Development

```bash
pnpm install
pnpm check      # tsc --strict
pnpm test       # vitest, all network and WebSocket traffic mocked
pnpm build      # lib/index.js (host plugin), lib/agent.js (agent sub-plugin)
pnpm verify     # all of the above + secret scan
pnpm pack:release
```

Layout: `src/auth` (OAuth, callback, TokenManager), `src/twitch` (Helix, chat, EventSub), `src/agent` (bridge,
dispatcher, tools), `src/runtime` (supervisor, status, redaction), `src/storage`, `src/commands`, `src/dsh`
(the only file that knows DSH service shapes). DSH integration points and their verified signatures are listed
at the top of `src/dsh/host.ts`.

## License

MIT, see [LICENSE](LICENSE).
