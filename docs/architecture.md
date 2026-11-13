# Architecture & verified API findings

This document records what has been **empirically verified** against a live Zoho
Mail mailbox (US data center, 2026-11-13), as opposed to what merely appears in
Zoho's documentation. Trust the verified column.

## The core mechanism (verified end-to-end)

```
PUT https://mail.zoho.com/api/accounts/{accountId}/updatemessage
Authorization: Zoho-oauthtoken <access_token>
Content-Type: application/json

{"mode":"moveToSpam","messageId":[<long>]}
```

- Does **not** add the sender to the personal Anti-Spam Blocklist page.
- **Does** train Zoho's per-account spam intelligence: a subsequent similar
  message from the same sender arrived in Spam with Zoho's banner
  *"You marked similar emails as Spam earlier."*
- This is exactly the user-facing behavior the extension promises. Content
  similarity matching means it covers "similar future email", not just exact
  senders.
- Reversible: `mode: markNotSpam` (the *Report not spam* button does the same).
- Note Zoho's asymmetric naming: `moveToSpam` / `markNotSpam` (there is **no**
  `markSpam` mode; that returns 400 `Invalid mode`).

## Endpoints (Zoho Mail API v1)

| Call | Result |
|---|---|
| `GET /api/accounts` | ✅ lists mailboxes: `email`, `accountId`, etc. Basis for account auto-detection. Scope `ZohoMail.accounts.READ`. |
| `GET /api/accounts/{id}/messages/view?limit=25` | ✅ lists `messageId`, `fromAddress`, `subject`, `folderId`, `receivedTime`. Scope `ZohoMail.messages.READ`. (`/messages` without `/view` → 404 `INVALID_METHOD`.) |
| `PUT /api/accounts/{id}/updatemessage` | ✅ see above. Scope `ZohoMail.messages.UPDATE`. |
| `GET /api/accounts/{id}/folders` | ⚠️ works but needs `ZohoMail.settings.READ`. Avoid — not needed if we work by `messageId`. |
| `PUT /api/v2/sharedmailbox/{id}/messages/{id}/spam` | ⚠️ shared-mailbox only; not usable for personal mailboxes. |
| personal Anti-Spam blocklist API | ❌ not found publicly. Not needed: filter learning works without it. |

## Auth (Zoho API console, 2026 UI) — hard-won notes

- **Self Client is a dead end.** Its "Generate Code" codes cannot be exchanged
  (persistent `invalid_client`), there is no token-download step, and it rejects
  `oob` redirects. Use a **Server-Based** client.
- Console validators reject hyphens/punctuation in client names/descriptions:
  letters, numbers, spaces only.
- Redirect URIs are **exact-match including trailing slash**, registered in the
  app *and* passed at token exchange.
- Token exchange: `POST https://accounts.zoho.com/oauth/v2/token` with
  `grant_type=AUTHORIZATION_CODE` and the **client secret in the body**
  (HTTP Basic is rejected).
- All API calls need header `Authorization: Zoho-oauthtoken <token>` — **not**
  `Bearer`.
- Access tokens expire in ~1 hour; refresh with the refresh token.
- Data-center domains must match the account: `mail.zoho.com` / `.eu` / `.in` /
  `.com.au` / `.com.cn` (and matching `accounts.` / `mail.` API hosts).
- Minimum scopes for this extension: `ZohoMail.accounts.READ`,
  `ZohoMail.messages.READ`, `ZohoMail.messages.UPDATE`.

## Open engineering question

Mapping a Thunderbird message (IMAP) to a Zoho `messageId`. Approach (M2):
fetch message details for the candidate (likely by recent-date + subject/from
search, matching the RFC `Message-Id` header exposed by the message-details
endpoint), fallback to `from + subject + receivedTime` window. To be verified
when M2 builds; document result here.

## Extension design (agreed)

- Button ("Report to Zoho as spam") in the message header, shown only for
  accounts auto-detected by matching Thunderbird identity addresses against the
  connected Zoho token's `/api/accounts` result. Overrides in options for
  multi-connection/region cases.
- On click: native `markMessageAsJunk` (via a small privileged messenger
  experiment so the user's own junk configuration is fully inherited) + the
  `moveToSpam` API call. Dedupe with a keyword tag so a message is reported at
  most once.
- OAuth client is **bundled and published** by the project publisher; users
  experience a single "Connect Zoho" consent flow; the extension listens on
  localhost for the redirect callback (privileged experiment) and stores tokens
  in Thunderbird's password manager.
- Works on Thunderbird 128+; Betterbird intended.
