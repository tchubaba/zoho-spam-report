# Zoho Spam Report

**Status: pre-alpha.** A Thunderbird extension that finally closes the spam-feedback
loop for Zoho Mail-hosted accounts: one button press in Thunderbird marks the
message junk locally *and* reports it to Zoho's server-side spam filter via the
Zoho Mail API — so Zoho actually learns and auto-spams similar future messages.

> Not affiliated with, endorsed by, or sponsored by Zoho Corporation. "Zoho" is a
> trademark of Zoho Corporation.

## The problem

Thunderbird's junk controls are entirely local. Over IMAP, marking junk is just a
folder move plus a keyword tag — Zoho's filter learns nothing, so the same spammer
haunts your inbox forever. Zoho's real feedback loop ("Mark as spam") lives only
in their webmail. If you chose a desktop mail client, you shouldn't have to visit
webmail to train your own filter.

## How it works

1. Click **Report to Zoho as spam** on a message in Thunderbird (button only
   appears on messages from Zoho-hosted accounts, auto-detected via the connected
   Zoho token — no manual mailbox mapping).
2. Thunderbird's native junk marking runs (your existing junk configuration,
   Bayesian training, and folder rules all apply).
3. The extension resolves the message to Zoho's internal `messageId` and calls
   `PUT /api/accounts/{accountId}/updatemessage` with `mode: moveToSpam`.
4. Zoho's per-account spam intelligence learns from it. The next similar message
   from that sender arrives in Spam with Zoho's own banner:
   *"You marked similar emails as Spam earlier."*

## Verified, not guessed

The core mechanism was proven end-to-end on a live mailbox (2026-11-13) before
any extension code was written: the API spam-report trained Zoho's filter, a
follow-up send from the same sender was auto-spammed, and the effect was cleanly
reversible (`markNotSpam` / *Report not spam*). Details and gotchas are in
[docs/architecture.md](docs/architecture.md).

## Privacy

- Everything runs client-side, first-party: your Thunderbird talks directly to
  `mail.zoho.com`. No proxy servers, no telemetry, no third party ever sees your
  mail or tokens.
- OAuth tokens are stored in Thunderbird's built-in password manager.
- Minimum OAuth scopes only: `ZohoMail.accounts.READ`, `ZohoMail.messages.READ`,
  `ZohoMail.messages.UPDATE`.
- See [PRIVACY.md](PRIVACY.md).

## Requirements

- Thunderbird 128+ (Betterbird compatibility intended; untested yet)
- A Zoho Mail account on any data center (`.com`, `.eu`, `.in`, `.com.au`, `.com.cn`)

## Roadmap

- **M1 — Alpha harness**: dogfoodable build (paste-token setup, button, API report)
- **M2 — Real Connect flow**: one-click "Connect Zoho" OAuth, message-ID mapping,
  dedupe tagging
- **M3 — Marketplace**: signed build submitted to addons.thunderbird.net

## License

MIT — see [LICENSE](LICENSE).
