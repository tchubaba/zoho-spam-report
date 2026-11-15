# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning per
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Project skeleton.
- One-click **Connect Zoho**: OAuth consent opens in the system browser and the
  extension receives the redirect on loopback port 8642. The refresh token is
  kept in Thunderbird's built-in password manager; access tokens stay in memory
  and renew automatically before expiry. Connections survive restarts.
  `prompt=consent` guarantees Zoho issues a fresh refresh token even for an
  app that was authorized before.
- Disconnect removes the local entry and revokes the refresh token at Zoho
  (`oauth/v2/revoke/token`), so the grant is gone server-side too.
- Message resolution now prefers exact RFC Message-Id matching: candidates
  are pre-filtered by sender and time proximity, then confirmed against the
  `Message-Id` header of each; sender+subject matching is the fallback.
- On messages from accounts no connected Zoho user serves, the button is
  disabled and labeled "No Zoho mailbox" (full explanation on hover) rather
  than looking clickable (Thunderbird offers no way to hide a
  message-display button per message).
- Multiple Zoho users can be connected at once; mailboxes from all connected
  users merge into the button eligibility map. Each connection has a
  Disconnect action in the options page.
- `zoho-client.example.json`, `docs/zoho-oauth-client.md`, and a gitignored
  `zoho-client.json` slot for the OAuth client credentials.
- Manual access-token paste moved to an advanced section of the options page.
- Message-display report button with Zoho account auto-detection, native junk
  marking plus server-side `moveToSpam` report, message-id resolution,
  per-session dedupe, options page setup, and an access-token guide.
- Messages displayed in a junk folder get a "Report to Zoho as not spam"
  action, which sends `markNotSpam` (reversing Zoho's filtering decision for
  similar future mail) plus the local not-junk mark. The Spam folder's id is
  resolved once per account via the folders API (`ZohoMail.folders.READ`).
- Alpha verified end to end: reporting a message from Thunderbird marks it
  junk locally and Zoho moves it to Spam and begins filtering similar future
  messages.

### Fixed
- Already-reported state keyed by RFC Message-ID and tracked per direction
  (spam vs not-spam), so folder moves and re-reports keep correct state.
- Zoho lists subjects HTML-entity-encoded; subject matching now decodes
  entities, typographic lookalikes, and junk-mailer padding before comparing.
- Account detection reads Zoho's hosted-mailbox fields (`primaryEmailAddress`,
  `emailAlias`) so addresses merely attached to the Zoho user are ignored.
- Server-side report runs before the local junk mark, which moves the
  message out of the folder the API lookup searches.
- Thunderbird 160's flat recipient list is matched correctly.
- Options page surfaces experiment-API and storage errors instead of failing
  silently.
