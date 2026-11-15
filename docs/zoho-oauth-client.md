# Zoho OAuth client setup

The Connect button needs a Zoho OAuth client whose redirect URI is
`http://localhost:8642/callback`. Published builds of the extension bundle
a ready-made client; when running from source you create your own and place
its credentials in `zoho-client.json` next to `manifest.json`.

## Create the client

1. Open the Zoho API Console for your data center
   (`https://api-console.zoho.com`, `.eu`, `.in`, `.com.au`, or `.com.cn`
   matching your mailbox).
2. Add Client → **Server-Based Application**.
3. Name: letters and spaces only (the console rejects punctuation).
4. Redirect URI (sometimes called Authorized Redirect URI or Callback URL):
   `http://localhost:8642/callback`
   Add it exactly as written, no trailing slash.
5. Scopes: choose the Zoho Mail category and select all four:
   - `ZohoMail.accounts.READ`
   - `ZohoMail.messages.READ`
   - `ZohoMail.messages.UPDATE`
   - `ZohoMail.folders.READ`
   Scope selection happens at creation time and is the ceiling for every
   token this client can mint; an unlisted scope is silently dropped at
   consent and fails later on the API call that needs it.
6. Create. Copy the Client ID and Client Secret.

## Configure the extension

```
cd <repo checkout>
cp zoho-client.example.json zoho-client.json
```

Edit `zoho-client.json` and paste the two values. `zoho-client.json` is
gitignored: never commit it, never paste its contents into issues, chats, or
terminal output you share.

## Port conflicts

The callback listener binds to loopback port 8642. If something else on the
machine owns that port, Connect reports the conflict. To move: change
`REDIRECT_PORT` in `src/experiments/zoho-api/experimental-api.js`, re-register
the matching `http://localhost:<port>/callback` URI on your client, reload the
add-on.

## Notes

- Client credentials are sent in the token request body; Zoho rejects the
  HTTP Basic authorization form.
- One client serves all data centers; sign-in happens against
  `accounts.zoho.<your DC>` automatically.
