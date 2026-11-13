# OAuth setup

The plugin uses a **Confidential** Twitch application and the **Authorization Code Grant**. The broadcaster
account signs in once; that same account reads chat and sends the replies. No second bot account, no
`user:bot` / `channel:bot`, no Verified Bot status.

## 1. Register the Twitch application (once)

1. Open the [Twitch Developer Console](https://dev.twitch.tv/console/apps). Your Twitch account needs a
   verified email and two-factor authentication. Registering an app is self-service; it is not the same as
   Chatbot verification.
2. **Register Your Application**:
   - Name: `DSH Livestream Twitch` (any name you like)
   - OAuth Redirect URL: `http://localhost:17123/oauth/twitch/callback`
     (must match `redirectUri` in the plugin config character for character)
   - Category: Chat Bot (or the closest current option)
   - Client Type: **Confidential**
3. Copy the **Client ID**. Click **New Secret** and copy the **Client Secret**.

## 2. Give DSH the Client ID and Client Secret

The Client ID is not secret. Put it in the plugin config (`clientId` in `cordis.patch.yml` or your profile
patch) or store it as the `TWITCH_CLIENT_ID` credential.

The Client Secret is secret. Store it only as the `TWITCH_CLIENT_SECRET` credential in DSH. With the default
local credential provider that is `$DSH_HOME/.credentials.yaml` (DSH refuses to start when that file is
readable by other users):

```yaml
# $DSH_HOME/.credentials.yaml   (chmod 600)
version: 1
refs:
  TWITCH_CLIENT_SECRET: "<your client secret>"
```

If the file already exists, add only the `TWITCH_CLIENT_SECRET` line under its existing `refs:`. The DSH
settings UI can also write credential references, if your build shows them.

DSH also falls back to the process environment and to `.env` files for references. Use those only if you
chose that deployment style; keep `.env` out of Git and never echo it into logs.

## 3. Authorize

In a DSH session run `/twitch setup` (checks everything without showing secrets), then `/twitch auth`. Open
the printed URL (it opens automatically on a desktop), sign in **as the broadcaster**, and approve.

Scopes requested:

| Feature | Scope | When |
|---|---|---|
| Read chat | `user:read:chat` | always (chat.read) |
| Send chat | `user:write:chat` | always (chat.send) |
| Follow events | `moderator:read:followers` | only with `events.follow: true` |
| Subscriptions, gifts, resubs | `channel:read:subscriptions` | only with `events.subscription: true` |
| Cheers | `bits:read` | only with `events.cheer: true` |
| Raids | none | `events.raid: true` |

Turning an event on later and running `/twitch auth` again requests the extra scope (incremental
authorization). If you decline a scope, only the events that need it stay off; chat keeps working.

## What the plugin checks

- `state` is 32 random bytes, valid once, for 10 minutes.
- The code is exchanged with the exact registered `redirect_uri`.
- `/oauth2/validate` must report this Client ID and a user ID; Helix `/users` must agree on the user.
- If `expectedBroadcasterLogin` is set, any other login is rejected.
- The plugin remembers the account by Twitch **user ID**. Authorizing a different user ID is refused unless
  you run `/twitch auth --replace-account` or `/twitch disconnect --forget` first. A renamed login with the
  same user ID is accepted.
- A refused token is revoked right away.

## Tokens after authorization

- Stored as one `grant` record (`dsh-livestream-twitch/broadcaster`) in the DSH credential store.
- Validated on start and every hour (Twitch requirement).
- A 401 from Twitch triggers one refresh and one retry. Concurrent requests share that refresh, and the
  rotated refresh token is written (with the new access token, in one locked write) before anything uses it.
- If the refresh is rejected or the user disconnects the app on Twitch, status becomes
  `reauthorization_required`, EventSub stops, and `/twitch auth` fixes it.
- `/twitch disconnect --forget` revokes the token at Twitch (`revokeOnForget: true`) and deletes the record.

## Without the DSH credential service

If the profile has no credential service, the plugin falls back to an AES-256-GCM file at
`$DSH_HOME/dsh-livestream-twitch/grant.enc` (directory `0700`, file `0600`). Its key comes from the
`DSH_TWITCH_STORE_KEY` environment variable (32 bytes, base64 or hex; for example `openssl rand -base64 32`).
Keep that key outside the data directory, for example in your service manager's secret store. Without the key
the fallback refuses to store tokens. The client secret is then read from the `TWITCH_CLIENT_SECRET`
environment variable.
