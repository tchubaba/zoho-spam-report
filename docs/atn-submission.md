# ATN submission guide (addons.thunderbird.net)

Everything below is a working checklist for the first submission of
**Spam Report for Zoho Mail**. Nothing is submitted until the author
approves.

## Before packaging

1. In the Zoho OAuth console, the application used by the shipped
   `zoho-client.json` is named **Spam Report for Thunderbird** (Zoho's
   console rejects application names containing "Zoho"). The registered
   redirect URI must be exactly `http://localhost:8642/callback`.
2. Build the package: `python3 scripts/build-xpi.py` produces
   `dist/spam-report-for-zoho-mail-<version>.xpi`. The build refuses to run if
   `zoho-client.json` (the shared OAuth application credentials, kept
   out of git) is missing.
3. Install the built XPI once via `about:debugging` and re-run the full
   cycle (connect, report spam, report not-spam, disconnect, reconnect,
   restart persistence) exactly once before upload.

## Listing copy

- **Name:** Spam Report for Zoho Mail
- **Category:** Email (mail communication)
- **Summary (short description):**
  One click reports junk to Zoho Mail's server-side spam filter, so
  Zoho learns to route future similar messages to Spam automatically.
  Unofficial; not affiliated with or endorsed by Zoho Corporation.
- **Full description:** the README's How it works / Privacy sections,
  with the trademark disclaimer kept verbatim at top and bottom.
- **Support / source:** https://github.com/tchubaba/spam-report-for-zoho-mail
- **Privacy policy:** PRIVACY.md served from the repository.

## Reviewer notes (the experiment API)

The add-on declares one privileged experiment API, `zohoApi`. What it
does, in full:

- Performs Zoho Mail API calls (the four documented endpoints) with an
  OAuth bearer token; hosts are limited to `mail.zoho.*` and
  `accounts.zoho.*` for the five Zoho data centers.
- Runs the OAuth code flow: opens the consent URL in the system browser
  and listens on `127.0.0.1:8642` only, for the duration of one connect,
  closing the socket on completion, cancel, or extension shutdown.
- Reads and writes exactly one password-manager entry per connected
  Zoho user (origin `accounts.zoho.*`) to persist the refresh token;
  access tokens stay in memory.
- Reads the bundled `zoho-client.json` for the OAuth application
  credentials. These credentials are the same for all installs (the
  normal arrangement for installed desktop applications; Thunderbird's
  own Gmail client works the same way).

No telemetry, no remote servers of the author, no message content ever
sent anywhere except the connected user's own Zoho API host.

## Data-collection disclosure form

Answers: no collection by the author; no analytics; no crash reporting
beyond Thunderbird's own; API calls to Zoho happen with the user's own
explicit OAuth grant; nothing is stored outside the user's own
Thunderbird profile.

## Known review risks

- The name uses the Zoho trademark in the descriptive "X for Y"
  position; the add-on name, options page, and description all carry the
  unofficial disclaimer.
- The experiment API may draw reviewer questions; the section above is
  the prepared answer.
- Zoho data-center hosts must all stay reachable in the manifest's
  network surface; the experiment is not restricted by host
  permissions, which reviewers may also ask about.
