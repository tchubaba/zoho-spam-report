/* Zoho Spam Report: background script
 *
 * - Maps Thunderbird identities to Zoho mailboxes via the connected token
 *   (GET /api/accounts). Only messages delivered to a mapped mailbox get an
 *   enabled "Report to Zoho as spam" message-display action.
 * - On click: native junk mark (inheriting user junk settings) + Zoho API
 *   moveToSpam report; in-memory dedupe per session.
 */
"use strict";

const reported = new Set();          // messageKey dedupe (session-scoped, alpha)
const displayedByTab = new Map();    // tabId -> last displayed message
let zohoByEmail = new Map();         // lowercase identity email -> {accountId}

async function refreshAccountMap() {
  try {
    const status = await browser.zohoApi.connectionStatus();
    if (!status.connected) {
      zohoByEmail = new Map();
      return;
    }
    const zohoAccounts = await browser.zohoApi.listAccounts();
    const map = new Map();
    for (const za of zohoAccounts) map.set(za.email, za);
    zohoByEmail = map;
  } catch (e) {
    console.warn("zoho-spam-report: account map refresh failed:", e && e.message);
  }
}

// Which mailbox a message was delivered to: scan recipients for a mapped email.
function zohoMatchForMessage(message) {
  const addrs = [];
  const r = message.recipients || {};
  for (const bucket of [r.to, r.cc, r.bcc]) {
    for (const entry of bucket || []) addrs.push(String(entry || "").toLowerCase());
  }
  // TB Message also exposes a flat list on some versions
  for (const entry of message.to || []) addrs.push(String(entry || "").toLowerCase());
  for (const addr of addrs) {
    const m = /<([^>]+)>/.exec(addr);
    const email = (m ? m[1] : addr).trim();
    if (zohoByEmail.has(email)) return zohoByEmail.get(email);
  }
  return null;
}

function setActionState(tabId, { enabled, title }) {
  try {
    if (title !== undefined) {
      browser.messageDisplayAction.setTitle({ tabId, title });
    }
    if (enabled !== undefined) {
      browser.messageDisplayAction.setEnabled({ tabId, enabled });
    }
  } catch { /* tab may be gone */ }
}

const IDLE_TITLE = "Report to Zoho as spam";

browser.messageDisplay.onMessageDisplayed.addListener(async (tab, message) => {
  displayedByTab.set(tab.id, message);
  const match = zohoMatchForMessage(message);
  const done = reported.has(message.messageKey);
  setActionState(tab.id, {
    enabled: !!match && !done,
    title: done ? "Already reported to Zoho" : IDLE_TITLE,
  });
});

browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  const message = displayedByTab.get(tab.id);
  if (!message || reported.has(message.messageKey)) return;
  const match = zohoMatchForMessage(message);
  if (!match) return;

  setActionState(tab.id, { enabled: false, title: "Reporting to Zoho…" });

  // 1) Local junk mark via Thunderbird's own command path (full inheritance).
  const local = await browser.zohoApi.markJunkSelected();

  // 2) Server-side spam report via the Zoho Mail API.
  let dateEpochMs = Number(message.time) || Date.now();
  if (dateEpochMs < 1e12) dateEpochMs *= 1000; // seconds -> ms safety
  const report = await browser.zohoApi.report({
    accountId: match.accountId,
    fromAddress: message.author,
    subject: message.subject || "",
    dateEpochMs,
  });

  if (report.ok) {
    reported.add(message.messageKey);
    setActionState(tab.id, { title: "Reported ✓" });
  } else if (report.error === "message_not_found") {
    setActionState(tab.id, { title: "Reported locally; Zoho lookup failed. Retry.", enabled: true});
    if (!local.ok) console.warn("zoho-spam-report: local junk mark failed:", local.error);
  } else {
    setActionState(tab.id, {
      title: `Zoho error: ${report.error || "unknown"}`,
      enabled: true,
    });
  }
  setTimeout(() => setActionState(tab.id, { title: IDLE_TITLE }), 5000);
});

// --- lifecycle ---------------------------------------------------------------
browser.runtime.onStartup.addListener(refreshAccountMap);
refreshAccountMap();

// Options page bumps this after (re)moving the connection.
browser.storage.local.onChanged.addListener((changes) => {
  if ("connectionPulse" in changes) refreshAccountMap();
});
