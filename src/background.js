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
  const r = message.recipients;
  if (Array.isArray(r)) {
    // TB 160 hands back a flat array of recipient strings
    for (const entry of r) addrs.push(String(entry || "").toLowerCase());
  } else if (r) {
    for (const bucket of [r.to, r.cc, r.bcc]) {
      for (const entry of bucket || []) addrs.push(String(entry || "").toLowerCase());
    }
  }
  // some versions also expose flat to/cc lists
  for (const bucket of [message.to, message.cc]) {
    for (const entry of bucket || []) addrs.push(String(entry || "").toLowerCase());
  }
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

function parseIdentityEmail(raw) {
  const s = String(raw || "").trim().toLowerCase();
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim();
}

// The options page has no messenger access; it asks us for the identity
// emails used in the match preview.
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "identityEmails") return undefined;
  return (async () => {
    const emails = [];
    const push = (raw) => {
      const e = parseIdentityEmail(raw);
      if (e && !emails.includes(e)) emails.push(e);
    };
    try {
      for (const i of await browser.messenger.identities.list()) push(i.email);
    } catch (e) {
      console.warn("messenger.identities.list failed, falling back:", e && e.message);
      try {
        const accounts = await browser.accounts.list();
        for (const a of accounts) for (const idn of a.identities || []) push(idn.email);
      } catch (e2) {
        console.warn("accounts.list fallback failed too:", e2 && e2.message);
      }
    }
    return { emails };
  })();
});

browser.messageDisplay.onMessageDisplayed.addListener(async (tab, message) => {
  displayedByTab.set(tab.id, message);
  const match = zohoMatchForMessage(message);
  console.log(
    "zsr: displayed",
    JSON.stringify(message.subject),
    "recipients=", JSON.stringify(message.recipients),
    "mapSize=", zohoByEmail.size,
    "match=", match ? match.accountId : null
  );
  const done = reported.has(message.messageKey);
  setActionState(tab.id, {
    enabled: !!match && !done,
    title: done ? "Already reported to Zoho" : IDLE_TITLE,
  });
});

browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  console.log("zsr: clicked tab", tab.id, "tracked=", displayedByTab.has(tab.id));
  const message = displayedByTab.get(tab.id);
  if (!message || reported.has(message.messageKey)) {
    console.warn("zsr: click ignored (no tracked message or already reported)");
    return;
  }
  const match = zohoMatchForMessage(message);
  if (!match) {
    console.warn("zsr: click ignored (recipients matched no Zoho mailbox)");
    return;
  }

  setActionState(tab.id, { enabled: false, title: "Reporting to Zoho…" });
  try {
  // 1) Server-side spam report FIRST: the local junk mark is an IMAP move
  // that relocates the server-side copy, and the Zoho messageId lookup
  // expects the message where IMAP sync last left it.
  let dateEpochMs = Number(message.time) || Date.now();
  if (dateEpochMs < 1e12) dateEpochMs *= 1000; // seconds -> ms safety
  const report = await browser.zohoApi.report({
    accountId: match.accountId,
    fromAddress: message.author,
    subject: message.subject || "",
    dateEpochMs,
  });

  // 2) Local junk mark via Thunderbird's own command path (full inheritance),
  // regardless of whether the Zoho side succeeded.
  const local = await browser.zohoApi.markJunkSelected();
  if (!local.ok) console.warn("zsr: local junk mark failed:", local.error);

  console.log("zsr: report=", JSON.stringify(report), "local=", JSON.stringify(local));
  if (report.ok) {
    reported.add(message.messageKey);
    setActionState(tab.id, { title: "Reported \u2713" });
  } else if (report.error === "message_not_found") {
    setActionState(tab.id, { title: "Marked junk; Zoho lookup failed. Retry.", enabled: true });
  } else {
    console.warn("zsr: zoho report failed:", report.error);
    setActionState(tab.id, { title: "Marked junk; Zoho error. Retry.", enabled: true });
  }
  setTimeout(() => setActionState(tab.id, { title: IDLE_TITLE }), 5000);
  } catch (e) {
    console.error("zsr: click handler threw:", e);
    setActionState(tab.id, { title: `Error: ${e.message}`, enabled: true });
  }
});

// --- lifecycle ---------------------------------------------------------------
browser.runtime.onStartup.addListener(refreshAccountMap);
refreshAccountMap();

// Options page bumps this after (re)moving the connection.
browser.storage.local.onChanged.addListener((changes) => {
  if ("connectionPulse" in changes) refreshAccountMap();
});
