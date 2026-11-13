/* zohoApi experiment implementation (skeleton, M1/M2)
 *
 * Parent-process code. Will implement (see docs/architecture.md):
 *  - bundled Zoho OAuth client id/secret (Server-Based app, published),
 *  - consent URL -> localhost TCPServerSocket callback capture,
 *  - token exchange (secret in BODY; grant_type=AUTHORIZATION_CODE),
 *  - refresh token in LoginDataServices/password manager,
 *  - access-token cache (~1h) + auto refresh,
 *  - reportSpam: PUT https://mail.{dc}/api/accounts/{id}/updatemessage
 *    header Authorization: Zoho-oauthtoken <access_token>
 *    body {"mode":"moveToSpam","messageId":[<long>]}.
 */

Components.utils.import("resource://gre/modules/ExtensionUtils.jsm");
// M1: flesh out; keep all network code here so the web-side stays simple.
