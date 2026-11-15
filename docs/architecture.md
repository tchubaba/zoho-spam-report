# Architecture

How the extension currently works.

## Components

- `manifest.json`: Thunderbird manifest (MV2), declares the message-display
  action and the `zohoApi` experiment.
- `src/background.js`: maps Zoho mailboxes to Thunderbird messages, maintains
  button state per tab, orchestrates the click flow.
- `src/experiments/zoho-api`: privileged parent-process code. Owns all network
  calls to Zoho and the native junk-marking bridge.
- `src/options`: setup page. Connect flow, connected-user list with
  Disconnect, connection status, detected-mailbox and Thunderbird-match
  status, and an advanced manual-token fallback.

## Button eligibility

The message-display action is enabled when the displayed message's recipient
list contains an address a connected Zoho user can act on. That set comes from
`GET /api/accounts` for every connected user (primary addresses plus domain
aliases) and updates when connections change. Each message can be reported
once per direction per Thunderbird session.

## Click flow

1. **Message resolution.** `GET /api/accounts/{accountId}/messages/view`
   (recent messages, inbox and - when the message already sits in junk - the
   Spam folder) is scanned for the message Thunderbird is displaying.
   Candidates sharing the sender address, closest to the displayed message's
   time, are confirmed one by one against the RFC `Message-Id` header via
   `GET .../folders/{folderId}/messages/{messageId}/header` - the header
   survives delivery untouched, while subjects get entity-encoded, mangled by
   spam mailers or prefixed with `Re:`. The best sender+subject match
   (normalized subject, HTML entities decoded) is the fallback. The view
   queries fetch the 100 most recent messages per folder, newest first.
2. **Server report.** `PUT /api/accounts/{accountId}/updatemessage` with body
   `{"mode":"moveToSpam","messageId":[<messageId>]}` (or `markNotSpam`). Zoho
   applies its spam similarity learning for the account.
3. **Local mark.** Thunderbird's own junk machinery handles the message via the
   3-pane window's junk command (`DBView.markMessages` with
   `nsMsgViewCommandType.junk`, falling back to the `cmdMarkJunk` command), so
   the user's junk settings (folder moves, server keywords, adaptive training)
   apply unchanged. The server report runs first because the local mark is an
   IMAP move that relocates the server-side copy out of the folder the API
   lookup searches.

## Zoho Mail API usage

| Call | Purpose | Scope |
|---|---|---|
| `GET https://accounts.zoho.{dc}/oauth/v2/auth` | consent page, opened in the system browser | n/a |
| `POST https://accounts.zoho.{dc}/oauth/v2/token` | code exchange and access-token refresh | n/a |
| `GET /api/accounts` | list reachable mailboxes (`email`, `accountId`, aliases) | `ZohoMail.accounts.READ` |
| `GET /api/accounts/{id}/messages/view` | recent messages for resolution | `ZohoMail.messages.READ` |
| `GET /api/accounts/{id}/folders/{fid}/messages/{mid}/header` | confirm candidates by RFC `Message-Id` | `ZohoMail.messages.READ` |
| `PUT /api/accounts/{id}/updatemessage` | the `moveToSpam`/`markNotSpam` report | `ZohoMail.messages.UPDATE` |
| `GET /api/accounts/{id}/folders` | resolve the Spam folder id for not-spam reports | `ZohoMail.folders.READ` |

Every call sends the header `Authorization: Zoho-oauthtoken *** and uses
the API host matching the account's data center: `mail.zoho.com`, `.eu`, `.in`,
`.com.au`, or `.com.cn`.

## Authentication

- **Connect flow.** The options page opens Zoho's consent page in the system
  browser (`access_type=offline&prompt=consent`: offline is what makes Zoho
  issue a refresh token, and prompt=consent is what makes Zoho issue a *new*
  one even when the app was already approved before) and listens on
  `127.0.0.1:8642` for the redirect. A random `state` value is checked on
  return. The code is exchanged at `POST /oauth/v2/token` with client
  credentials in the form body.
- **Refresh tokens** go to Thunderbird's login manager (the password
  manager), one `nsILoginInfo` entry per Zoho user: the account's
  `accounts.zoho.{dc}` origin, the user's primary address as username, and
  the scope string as realm. Disconnect removes the entry and asks Zoho to
  revoke the refresh token server-side
  (`POST /oauth/v2/revoke/token`, client credentials as HTTP Basic).
- **Access tokens** live in memory per connection and are renewed
  automatically when within 60 seconds of expiry.
- **Multiple connections.** Any number of Zoho users (same or different data
  centers) can be connected; each request is routed to the connection that
  owns the target `accountId`.
- **Manual token path.** Pasting an access token remains available under
  Advanced; it is held in memory for the session only.

The OAuth client id and secret are read from `zoho-client.json` in the
extension root; see [OAuth client setup](zoho-oauth-client.md).
