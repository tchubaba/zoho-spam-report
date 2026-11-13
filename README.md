# Zoho Spam Report

**Status: pre-alpha.** A Thunderbird extension for Zoho Mail-hosted mailboxes: one
button press reports a message to both Thunderbird's local junk controls and
Zoho Mail's server-side spam filter, so Zoho auto-spams similar messages from
that sender in the future.

> Unofficial extension. Not affiliated with, endorsed by, or sponsored by Zoho
> Corporation. "Zoho" is a trademark of Zoho Corporation.

## Why this exists

Thunderbird's junk controls are local. Over IMAP a junk mark is a folder move and
a keyword tag, so Zoho's filter never hears about your spam and the same senders
keep returning. Zoho's feedback mechanism lives in their webmail. This extension
brings that feedback loop to your desktop client: one click in Thunderbird, and
Zoho's own filter learns.

## How it works

1. Click **Report to Zoho as spam** on a message in Thunderbird. The button is
   offered on messages delivered to mailboxes reachable by your connected Zoho
   token (accounts are detected automatically).
2. Thunderbird's native junk marking runs first. Your existing junk
   configuration, local adaptive training, and folder rules apply exactly as
   with the regular junk button.
3. The extension resolves the message to Zoho's internal message id and calls
   the Zoho Mail API's update-message endpoint in `moveToSpam` mode.
4. Zoho treats that call as your spam feedback. Future similar messages arrive
   in the Spam folder carrying Zoho's own banner: *"You marked similar emails as
   Spam earlier."*

## Privacy

- Everything runs client-side, first-party: your Thunderbird talks directly to
  Zoho's own API (or your data center's equivalent).
- Minimum OAuth scopes only: list your mailboxes, read message metadata to
  locate the message you clicked, and apply the spam report.
- The alpha holds the access token in memory only; nothing is written to disk.
- See [PRIVACY.md](PRIVACY.md).

## Requirements

- Thunderbird 128 or later
- A Zoho Mail account on any data center (`.com`, `.eu`, `.in`, `.com.au`,
  `.com.cn`)

## Documentation

- [Alpha setup: getting an access token](docs/getting-an-access-token.md)
- [Architecture and API usage](docs/architecture.md)

## License

MIT, see [LICENSE](LICENSE).
