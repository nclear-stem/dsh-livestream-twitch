# Local deployment (macOS / Linux)

Requirements: DSH 0.2.x (`dsh --version`), Node.js 22 or newer (the DSH runtime; EventSub uses Node's
built-in WebSocket), pnpm. Paths below use `$DSH_HOME` (default `~/.dsh`); nothing is macOS-specific.

## Build

```bash
cd dsh-livestream-twitch
pnpm install
pnpm verify        # type check, tests, build, secret scan
```

## Install into a DSH profile

Use a profile of your choice. To keep your existing profiles untouched, create a new one from the shipped web
template first:

```bash
dsh twitch --from-default-profile web     # creates and boots $DSH_HOME/profiles/twitch; stop it with Ctrl-C
dsh plugin --profile twitch add link:/absolute/path/to/dsh-livestream-twitch
```

The package declares its bundle patch (`dsh.bundle.patch` -> `cordis.patch.yml`). If your DSH build does not add
newly installed packages to the profile's bundle list automatically, add `"dsh-livestream-twitch"` to
`dsh.profile.bundles` in that profile's `package.json`. Check the result without booting:

```bash
dsh --profile twitch --dump-config | grep -n twitch
```

You should see the `dsh-livestream-twitch` plugin and the `Twitch Chat` agent preset.

Put the Client ID in the plugin config and the Client Secret in the credential store (see [oauth.md](oauth.md)).
Override plugin settings in the profile's own `cordis.patch.yml`, for example:

```yaml
- id: dsh-livestream-twitch
  name: dsh-livestream-twitch
  config:
    clientId: your_client_id
    expectedBroadcasterLogin: your_channel_login
```

## First run

```bash
dsh twitch          # web profile: open the printed URL
```

1. Start a new session with the **Twitch Chat** preset (or any preset; the preset only adds instructions and the
   `twitch_status` tool).
2. `/twitch setup`: every line should be `ok`.
3. `/twitch auth`: the browser opens on Twitch; sign in as the broadcaster. The callback listens on
   `127.0.0.1:17123` only while this authorization is pending (10 minutes).
4. `/twitch connect`: binds **this session** as the one that answers chat and starts EventSub.
5. `/twitch reply on`: viewer messages are now delivered to the session. Replies are dry-run by default: they
   appear in `/twitch status` and the log, nothing is posted.
6. When the answers look right: `/twitch dryrun off`. Replies are now posted as the broadcaster.

`/twitch test` runs an offline self-check that sends nothing.

Set `autoConnect: true` to start EventSub automatically after a DSH restart (needs a stored grant and a bound
session).

## How a message flows

viewer message -> EventSub `channel.chat.message` -> dedupe by message id -> the broadcaster's own messages are
dropped (so the plugin never answers itself) -> queue (`chat.maxQueue`, oldest chat dropped first) -> one
follow-up turn in the bound DSH session -> the assistant's text for that turn -> pacing
(`minReplyIntervalMs`, `maxRepliesPerMinute`) -> Helix Send Chat Message with `broadcaster_id = sender_id =`
the broadcaster, threaded to the viewer's message.

If the agent writes `[skip]` or nothing, no message is posted. If a turn takes longer than `chat.agentTimeoutMs`
(90 s), that message is given up; an answer that arrives later is not posted.

## Commands

| Command | Does |
|---|---|
| `/twitch setup` | Checks config, credentials (presence only), callback port, Node, WebSocket, DSH agent service |
| `/twitch auth [--replace-account]` | OAuth in the browser; shows account, scopes, state |
| `/twitch status` | Auth, EventSub, subscriptions, bridge counters, dry-run; never secrets |
| `/twitch connect [session-id]` | Bind a session and start chat |
| `/twitch disconnect [--forget]` | Stop chat; `--forget` revokes the token and removes it |
| `/twitch reply on\|off`, `/twitch dryrun on\|off` | Live toggles, persisted in `$DSH_HOME/dsh-livestream-twitch/settings.json` |
| `/twitch test` | Offline self-test |

DSH 0.2.x has no way for a plugin to add `dsh <subcommand>` CLI commands, so the planned `dsh-twitch <cmd>` set
is provided as the `/twitch` slash command. The same grammar is available over HTTP on the DSH web server:
`POST /api/dsh-livestream-twitch/command` with `{"input": "status"}`, and `GET /api/dsh-livestream-twitch/status`
(JSON). These routes sit behind DSH's own web authentication.

## Uninstall

```bash
# in a DSH session first, to revoke and delete the token:
/twitch disconnect --forget
dsh plugin --profile twitch remove dsh-livestream-twitch
rm -rf "$DSH_HOME/dsh-livestream-twitch"     # settings.json (and grant.enc if the file fallback was used)
```

Then delete `TWITCH_CLIENT_SECRET` from `$DSH_HOME/.credentials.yaml` and, if you no longer need it, the
application in the Twitch Developer Console. The plugin never touches the Bilibili `dsh-livestream` plugin or
its data, so installing or removing it has no effect there.
