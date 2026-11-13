# Architecture

How the extension currently works.

## Components

- `manifest.json`: Thunderbird manifest (MV2), declares the message-display
  action and the `zohoApi` experiment.
- `src/background.js`: maps Zoho mailboxes to Thunderbird messages, maintains
  button state per tab, orchestrates the click flow.
- `src/experiments/zoho-api`: privileged parent-process code. Owns all network
  calls to Zoho and the native junk-marking bridge.
- `src/options`: setup page. Token entry, connection status, detected-mailbox
  and Thunderbird-match status.

## Button eligibility

The message-display action is enabled when the displayed message's recipient
list contains an address the connected token can act on. That set comes from
`GET /api/accounts` (primary addresses plus domain aliases) and updates when the
connection changes. Each message can be reported once per Thunderbird session.

## Click flow

1. **Local mark.** Thunderbird's own junk machinery handles the message via the
   3-pane window's junk command (`DBView.markMessages` with
   `nsMsgViewCommandType.junk`, falling back to the `cmdMarkJunk` command), so
   the user's junk settings (folder moves, server keywords, adaptive training)
   apply unchanged.
2. **Message resolution.** `GET /api/accounts/{accountId}/messages/view` (the
   50 most recent messages, newest first). The extension picks the best match on
   sender address, normalized subject (`Re:`/`Fwd:` prefixes stripped), and
   `receivedTime` within 40 minutes of Thunderbird's message date; a same
   sender+subject match is the fallback.
3. **Server report.** `PUT /api/accounts/{accountId}/updatemessage` with body
   `{"mode":"moveToSpam","messageId":[<messageId>]}`. Zoho applies its spam
   similarity learning for the account.

## Zoho Mail API usage

| Call | Purpose | Scope |
|---|---|---|
| `GET /api/accounts` | list reachable mailboxes (`email`, `accountId`, aliases) | `ZohoMail.accounts.READ` |
| `GET /api/accounts/{id}/messages/view` | recent messages for resolution | `ZohoMail.messages.READ` |
| `PUT /api/accounts/{id}/updatemessage` | the `moveToSpam` report | `ZohoMail.messages.UPDATE` |

Every call sends the header `Authorization: Zoho-oauthtoken <token>` and uses
the API host matching the account's data center: `mail.zoho.com`, `.eu`, `.in`,
`.com.au`, or `.com.cn`.

## Authentication (current)

An access token from any OAuth client holding the three scopes above is pasted
into the options page and held in memory for the running Thunderbird session.
See [getting an access token](getting-an-access-token.md) for the step-by-step.
