/* Zoho Spam Report — background script (skeleton, M1)
 *
 * Responsibilities (see docs/architecture.md):
 *  1. Auto-detect Zoho-hosted Thunderbird accounts: for each connection stored
 *     by the zohoApi experiment, call GET /api/accounts and identity-match
 *     mailbox addresses against messenger.accounts.
 *  2. Add a "Report to Zoho as spam" toolbox button in the message header,
 *     shown only for messages in auto-detected Zoho accounts
 *     (messageDisplay.onMessageDisplayed).
 *  3. On click: mark junk locally, resolve Zoho messageId, call
 *     zohoApi.reportSpam(accountId, messageId), tag message with
 *     keyword "zohoReported" to dedupe.
 */

// "use strict"; — fleshed out in M1 (issue #1)
