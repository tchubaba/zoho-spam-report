# Privacy Policy

Spam Report for Zoho Mail (the extension) processes mail data exclusively on your own
machine and only to perform the action you explicitly request.

- **No servers.** The extension ships no backend. All API calls go directly from
  your Thunderbird installation to Zoho's own API
  (`https://mail.zoho.com/...`, or your data center's equivalent).
- **No telemetry, no analytics, no crash reporting.** The extension collects
  nothing, sends nothing.
- **Minimal scopes.** Connecting grants the extension exactly four Zoho Mail
  scopes: `ZohoMail.accounts.READ` (list which mailboxes your token controls),
  `ZohoMail.messages.READ` (locate the message you clicked on),
  `ZohoMail.messages.UPDATE` (apply your spam or not-spam report), and
  `ZohoMail.folders.READ` (resolve the Spam folder's id so not-spam reports
  can find messages already sitting in Spam). Nothing else.
- **Token storage.** The refresh token issued by Zoho when you connect is
  stored in Thunderbird's built-in password manager (the same store that
  protects your mail account credentials), one entry per connected Zoho user.
  Access tokens are held in memory only and renew automatically. Pressing
  Disconnect deletes the stored entry and sends Zoho a token-revocation
  request so the grant is also removed server-side. The manual token path
  holds a pasted access token in memory for the running Thunderbird session
  only.
- **The connect flow.** Sign-in happens in your system browser on Zoho's own
  pages. The extension briefly listens on port 8642 of 127.0.0.1 (loopback
  only, closed the moment the callback lands) to receive Zoho's redirect. No
  port is reachable from outside your machine.
- **What a spam report sends to Zoho.** The Zoho `messageId` of the message you
  reported. This is the same data Zoho's own webmail "Mark as spam" button
sends. The
  message content is already on Zoho's servers; the extension never uploads
  message bodies.
- **Revocation.** You can remove all access at any time by deleting the
  connection in the extension's options page and/or revoking the authorization
  in your Zoho account settings (My Account → Sign-in & security → Connected
  applications).
