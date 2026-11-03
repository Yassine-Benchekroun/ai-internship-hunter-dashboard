# Gmail provider OAuth contract

Step 7 adds an explicit Gmail provider connection that is separate from
Supabase Auth and from the saved sender identity. It authorizes read-only
mailbox monitoring only. This contract never sends mail, creates a draft in
Gmail, creates a schedule, or enables automatic sending.

## Backend boundary

The `provider-oauth` Edge Function is the only OAuth implementation. Its
platform JWT check is disabled because Google's callback does not contain a
Supabase JWT; the function validates the Supabase JWT itself for `start`,
`status`, `refresh`, and `disconnect` actions. The callback is accepted only
when it consumes a matching, single-use, short-lived SHA-256 state hash.

The function requires these backend-only environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `OAUTH_REDIRECT_URI` — the exact HTTPS callback registered with Google
- `OAUTH_RETURN_URL` — optional HTTPS dashboard URL for a status-only redirect

Supabase secret keys and Google OAuth values are never placed in browser code,
the public settings row, or the response body. The callback response contains
only a connection status; access and refresh tokens stay in
`private.provider_connections` and are readable only by the service-role
backend path. Pending OAuth states are stored as hashes in
`private.provider_oauth_states`.

## Actions

`POST /functions/v1/provider-oauth`

```json
{"action":"start"}
```

Returns a Google authorization URL containing the read-only scope
`https://www.googleapis.com/auth/gmail.readonly`, `access_type=offline`, and a
one-time state value. The frontend redirects the browser to that URL and never
handles tokens.

The other authenticated actions are:

- `{"action":"status"}` — returns safe connection metadata only.
- `{"action":"refresh"}` — refreshes the backend session using the stored
  refresh token and returns only `connected` status.
- `{"action":"disconnect"}` — asks Google to revoke the provider token, then
  clears local access and refresh tokens even if Google's remote response could
  not be confirmed. The response reports whether remote revocation was
  confirmed, without returning a token.

`GET /functions/v1/provider-oauth?code=...&state=...` is the Google callback.
The authorization code is exchanged server-to-server, the Gmail profile email
is stored as provider metadata, and the public `user_settings` row is updated
only with `provider_connection_status`.

## Security decisions

- The browser's Supabase Auth session remains the dashboard login; Gmail is a
  separate provider connection scoped to the same signed-in user.
- Sender identity is still an editable draft identity and does not imply Gmail
  authorization.
- Only `gmail.readonly` is requested for Step 7. No `gmail.send`,
  `gmail.compose`, `gmail.modify`, or `mail.google.com` scope is requested.
- No provider token, client secret, or raw OAuth code is returned to the
  browser, written to public assets, or logged by the function.
- No schedule or automatic sender is part of this step.

Google's web-server OAuth guidance requires a state value for request/response
binding and recommends offline access when a backend must refresh a session.
The Gmail API documentation recommends requesting the narrowest scope needed;
the read-only scope is intentionally used here.
