# Troubleshooting

Start with `/twitch status`; its last lines show the most recent error (redacted) and a short history.

## Authorization

| Symptom | Cause and fix |
|---|---|
| `Twitch Client Secret is not set` | Store `TWITCH_CLIENT_SECRET` as a DSH credential ([oauth.md](oauth.md)). |
| `port 17123 ... is busy` | Another program or a pending `/twitch auth` holds it. Free it, or change `callbackPort` **and** the registered Redirect URL. |
| Twitch shows `redirect_mismatch` | `redirectUri` differs from the console entry. They must match exactly, including `localhost` vs `127.0.0.1` and the path. |
| Browser shows "connection refused" on localhost | Remote host: the SSH tunnel is not running ([remote-deployment.md](remote-deployment.md)). Local: the 10-minute window passed; run `/twitch auth` again. |
| `state parameter does not match` | An old or reused link. Use the URL from the latest `/twitch auth`. |
| `this plugin is bound to <login>` | You signed in as a different Twitch user. Sign in as the broadcaster, or `/twitch auth --replace-account`. |
| `expectedBroadcasterLogin is ...` | Same, enforced by config. |
| Status `reauthorization_required` | The refresh token was rejected or you removed the app under Twitch Settings > Connections. Run `/twitch auth`. |

## Chat

| Symptom | Cause and fix |
|---|---|
| `cannot read chat: scope not granted: user:read:chat` | Authorization did not include the scope. Run `/twitch auth` and approve all requested permissions. |
| EventSub `reconnecting` repeatedly | Network to `eventsub.wss.twitch.tv` is blocked, or Twitch rejected the subscription (see the subscription line in status). Close code 4003 means no subscription was created within 10 s. |
| Messages counted as received, nothing answered | `autoReply` is off (`/twitch reply on`) or no session is bound (`/twitch connect` inside the session). |
| Answers in status but not in chat | Dry-run is on (default). `/twitch dryrun off`. |
| `Twitch dropped it (msg_duplicate ...)` | Twitch refuses identical consecutive messages and messages caught by AutoMod or channel rules. |
| `failed ... HTTP 429` | Rate limited. The dispatcher waited for `Ratelimit-Reset` and retried twice; lower `maxRepliesPerMinute`. |
| Agent timeouts | The bound session's turns take longer than `chat.agentTimeoutMs`; use a faster model, shorter instructions, or raise the timeout. |
| Shared chat messages ignored | Messages from another channel in a shared chat session are skipped on purpose. |
| Two replies to every message | Two plugin instances are connected to the channel. Run only one ([remote-deployment.md](remote-deployment.md)). |

## Events

An event switched on in config but shown as `disabled (scope not granted ...)` needs one more `/twitch auth`
after turning it on. `failed` with HTTP 403 means Twitch refused the subscription for this account. Chat keeps
running in both cases.

## Logs

Log lines are prefixed `dsh-livestream-twitch:` and are redacted: access and refresh tokens, the client secret,
OAuth codes and `state`, and Authorization headers are replaced with `[REDACTED]`. If you ever see a credential
in a log, treat it as leaked: `/twitch disconnect --forget`, rotate the Client Secret in the Twitch console, and
report the log line (with the value removed).
