# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning per
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Project skeleton.
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
