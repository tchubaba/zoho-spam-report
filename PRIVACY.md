# Privacy Policy

Zoho Spam Report (the extension) processes mail data exclusively on your own
machine and only to perform the action you explicitly request.

- **No servers.** The extension ships no backend. All API calls go directly from
  your Thunderbird installation to Zoho's own API
  (`https://mail.zoho.com/...`, or your data center's equivalent).
- **No telemetry, no analytics, no crash reporting.** The extension collects
  nothing, sends nothing.
- **Minimal scopes.** Connecting grants the extension exactly three Zoho Mail
  scopes: `ZohoMail.accounts.READ` (list which mailboxes your token controls),
  `ZohoMail.messages.READ` (locate the message you clicked on), and
  `ZohoMail.messages.UPDATE` (apply your spam report). Nothing else.
- **Token storage.** OAuth tokens are kept in Thunderbird's built-in password
  manager, the same store Thunderbird uses for your account passwords.
- **What a spam report sends to Zoho.** The Zoho `messageId` of the message you
  reported — the same data Zoho's own webmail "Mark as spam" button sends. The
  message content is already on Zoho's servers; the extension never uploads
  message bodies.
- **Revocation.** You can remove all access at any time by deleting the
  connection in the extension's options page and/or revoking the authorization
  in your Zoho account settings (My Account → Sign-in & security → Connected
  applications).
