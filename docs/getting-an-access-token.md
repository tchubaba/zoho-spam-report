# Getting a Zoho Mail access token (alpha workflow)

The current alpha flow uses a **Zoho Mail API access token** (lifetime ~1 hour,
pasted into the options page each session). A one-click "Connect Zoho" OAuth
flow is planned for a future release.

## 1. Create a Zoho OAuth client (one time)

1. Open <https://api-console.zoho.com> while logged into your Zoho account.
2. **Create Application → Server-Based**.
   - The console rejects hyphens/punctuation in names. Use letters, numbers and
     spaces only (Zoho rejects names containing "Zoho"; use e.g. `Spam Report for Thunderbird`).
   - Homepage URL: anything (it is only displayed on the consent page).
   - Authorized Redirect URI: add **exactly**
     `https://oauth.pstmn.io/v1/callbacks`
     (Postman's public token catcher; also fine to add `http://localhost:8080`).
3. Save. Copy the **Client ID** and **Client Secret** (Client Secret tab).

## 2. Get a token in Postman (free desktop app)

1. Create any request → **Authorization** tab → Type **OAuth 2.0** →
   *Configure new token*:
   - Grant Type: **Authorization Code**
   - Callback URL: `https://oauth.pstmn.io/v1/callbacks`
   - Auth URL: `https://accounts.zoho.com/oauth/v2/auth`
     (use `accounts.zoho.eu` / `.in` / `.com.au` / `.com.cn` for those data centers)
   - Access Token URL: `https://accounts.zoho.com/oauth/v2/token`
   - Client ID / Secret: from step 1
   - Scope:
     `ZohoMail.accounts.READ,ZohoMail.messages.READ,ZohoMail.messages.UPDATE,ZohoMail.folders.READ`
   - Client Authentication: **Send client credentials in body**
     (Zoho rejects Basic-header auth)
2. **Get New Access Token** → the consent page opens → approve → Postman
   catches the callback and stores the token.
3. Copy the **Access Token** value.

## 3. Paste into the extension

Thunderbird → Add-ons → Spam Report for Zoho Mail → Options → pick the data center,
paste the token, hit **Use token**. The token lives in memory only; when it
expires (~1 h), repeat step 2 (Postman can refresh it with one click while the
app runs).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `invalid_client` at exchange | secret in body, not header; URI exact-match incl. trailing slash |
| `INVALID_OAUTHSCOPE` | scope set incomplete: see step 2 |
| 404 `INVALID_METHOD` | wrong path: the list endpoint is `/messages/view` |
| header auth ignored | use the exact scheme `Zoho-oauthtoken <token>` |
| wrong mailboxes shown | data center mismatch: the token's accounts.zoho.* must match the account's DC |
