# Remote Linux deployment (SSH tunnel)

DSH and the plugin run on the server. The OAuth callback listens only on the server's `127.0.0.1:17123`; the
server needs no inbound port for it.

## Authorize through an SSH tunnel

1. On your **local** machine, forward local port 17123 to the server's loopback:

   ```bash
   ssh -N -L 17123:127.0.0.1:17123 user@your-server
   ```

   Keep it running. Local port 17123 must be free. If it is not, pick another local port, and change both the
   Redirect URL in the Twitch console and `redirectUri` in the plugin config to that port; `callbackPort`
   stays the server-side port (`/twitch setup` warns when the two differ, which is correct in this case).

2. In a DSH session on the server (web UI or TUI), run `/twitch auth`. On a server the browser is not opened;
   copy the printed URL into your **local** browser.

3. Sign in as the broadcaster and approve. Twitch redirects your browser to `http://localhost:17123/...`; the
   tunnel carries that request to the plugin on the server. The page says "Twitch connected".

4. Stop the tunnel. `/twitch status` shows the channel, user ID and scopes.

Only the OAuth callback uses the tunnel. EventSub (`wss://eventsub.wss.twitch.tv/ws`) and Helix
(`https://api.twitch.tv`) are reached directly from the server.

## Secrets on the server

The Client Secret and the tokens stay on the server: `TWITCH_CLIENT_SECRET` and the grant record in the
server's `$DSH_HOME/.credentials.yaml` (mode 600). Nothing is stored on your local machine.

## One active instance per channel

Run the plugin for a given channel on one machine at a time. Two running instances would both answer every
message. Do not share one credential store between two running machines, and do not run two instances that
could refresh the same refresh token. Keep `chat.dryRun: true` on any second machine you use for testing; that
only prevents sending, it does not make two active instances safe.

## Restart

After a DSH restart the grant is loaded and validated again; no new login is needed unless the authorization
was revoked or the refresh token stopped working.
