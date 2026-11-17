/* Spam Report for Zoho Mail: background script
 *
 * - Maps Thunderbird identities to Zoho mailboxes via the connected token
 *   (GET /api/accounts). Only messages delivered to a mapped mailbox get an
 *   enabled "Report to Zoho as spam" message-display action.
 * - On click: native junk mark (inheriting user junk settings) + Zoho API
 *   moveToSpam report; in-memory dedupe per session.
 */
"use strict";

// key: stable message id -> value: the mode already sent ("moveToSpam" or
// "markNotSpam"). Session-scoped in the alpha.
const reported = new Map();

// Prefer the RFC Message-ID header: stable across folder moves (an IMAP move
// re-homes the message, changing folder and local id).
function dedupeKey(message) {
  const rfc = message.headerMessageId || message.header?.messageId || message.messageId;
  if (rfc) return `m:${String(rfc).trim()}`;
  const acc = message.account?.id || "";
  const folder = message.folder?.path || message.folder?.name || "";
  const id = message.id ?? `${message.subject}|${message.author}|${message.time}`;
  return `a:${acc}|${folder}|${id}`;
}

// Is the displayed message in a junk folder? folder.type is authoritative
// (special-use flag); the name check covers accounts without one.
function isInJunkFolder(message) {
  const f = message.folder || {};
  if (f.type === "junk") return true;
  const name = String(f.path || f.name || "").toLowerCase();
  return /(^|\/)(spam|junk)$/.test(name);
}
function headerValue(header, name) {
  if (!header) return "";
  if (typeof header.get === "function") {
    const v = header.get(name) || header.get(name.toLowerCase()) ||
      header.get(name.toUpperCase());
    if (v) return String(v);
  }
  return String(header[name] || header[name.toLowerCase()] ||
    header[name.toUpperCase()] || "");
}

// Thunderbird exposes the RFC Message-ID of the displayed message as
// headerMessageId (the msg-db header id); "0" means the message has none.
async function getRfcMessageId(message) {
  const direct = message.headerMessageId ||
    headerValue(message.header, "message-id") || "";
  if (direct && direct !== "0") return String(direct).trim();
  return "";
}

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
    console.warn("spam-report-for-zoho-mail: account map refresh failed:", e && e.message);
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

function setActionState(tabId, { enabled, title, label }) {
  try {
    if (title !== undefined) {
      browser.messageDisplayAction.setTitle({ tabId, title });
    }
    // The label is what the button prints; the title is only the tooltip.
    // Clearing the label (null) falls back to the title.
    browser.messageDisplayAction.setLabel({ tabId, label: label ?? null });
    if (enabled !== undefined) {
      browser.messageDisplayAction.setEnabled({ tabId, enabled });
    }
  } catch { /* tab may be gone */ }
}

const IDLE_TITLE = "Report to Zoho as spam";
const NOT_SPAM_TITLE = "Report to Zoho as not spam";

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
  const inJunk = isInJunkFolder(message);
  const wantMode = inJunk ? "markNotSpam" : "moveToSpam";
  const done = reported.get(dedupeKey(message)) === wantMode;
  // messageDisplayAction has no show/hide in Thunderbird (checked against
  // the TB 160 schema); an ineligible message gets a disabled button with a
  // short label on the button itself and the full explanation on hover.
  let title, label;
  if (!match) {
    title = zohoByEmail.size
      ? "No connected Zoho mailbox serves this message"
      : "Zoho not connected (see add-on options)";
    label = "No Zoho mailbox";
  } else if (done) {
    title = label = inJunk
      ? "Already reported as not spam" : "Already reported to Zoho";
  } else {
    title = label = inJunk ? NOT_SPAM_TITLE : IDLE_TITLE;
  }
  setActionState(tab.id, { enabled: !!match && !done, title, label });
});

browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  console.log("zsr: clicked tab", tab.id, "tracked=", displayedByTab.has(tab.id));
  const message = displayedByTab.get(tab.id);
  if (!message || reported.has(dedupeKey(message))) {
    console.warn("zsr: click ignored (no tracked message or already reported)");
    return;
  }
  const match = zohoMatchForMessage(message);
  if (!match) {
    console.warn("zsr: click ignored (recipients matched no Zoho mailbox)");
    return;
  }

  const inJunk = isInJunkFolder(message);
  const mode = inJunk ? "markNotSpam" : "moveToSpam";
  const idleTitle = inJunk ? NOT_SPAM_TITLE : IDLE_TITLE;
  setActionState(tab.id, {
    enabled: false,
    title: inJunk ? "Reporting as not spam…" : "Reporting to Zoho…",
  });
  try {
  // 1) Server-side spam report FIRST: the local junk mark is an IMAP move
  // that relocates the server-side copy, and the Zoho messageId lookup
  // expects the message where IMAP sync last left it.
  let dateEpochMs = Number(message.time) || Date.now();
  if (dateEpochMs < 1e12) dateEpochMs *= 1000; // seconds -> ms safety
  const rfcId = await getRfcMessageId(message);
  console.log("zsr: rfc message id:", rfcId ? "present" : "MISSING (header unavailable)");
  const report = await browser.zohoApi.report({
    accountId: match.accountId,
    fromAddress: message.author,
    subject: message.subject || "",
    dateEpochMs,
    mode,
    inJunk,
    internetMessageId: rfcId,
  });

  // 2) Local junk mark via Thunderbird's own command path (full inheritance),
  // regardless of whether the Zoho side succeeded.
  const local = await browser.zohoApi.markJunkSelected({ notJunk: inJunk });
  if (!local.ok) console.warn("zsr: local junk mark failed:", local.error);

  console.log("zsr: report=", JSON.stringify(report), "local=", JSON.stringify(local));
  const localWord = inJunk ? "Not junk" : "Marked junk";
  if (report.ok) {
    reported.set(dedupeKey(message), mode);
    setActionState(tab.id, { title: inJunk ? "Not spam \u2713" : "Reported \u2713" });
  } else if (report.error === "message_not_found") {
    setActionState(tab.id, { title: `${localWord} locally; Zoho lookup failed. Retry.`, enabled: true });
  } else {
    console.warn("zsr: zoho report failed:", report.error);
    setActionState(tab.id, { title: `${localWord} locally; Zoho error. Retry.`, enabled: true });
  }
  setTimeout(() => setActionState(tab.id, { title: idleTitle }), 5000);
  } catch (e) {
    console.error("zsr: click handler threw:", e);
    setActionState(tab.id, { title: `Error: ${e.message}`, enabled: true });
  }
});

// --- lifecycle ---------------------------------------------------------------
// OAuth client id/secret live in zoho-client.json at the add-on root; the
// extension's own pages can always fetch their own resources.
async function loadZohoClientConfig() {
  try {
    const resp = await fetch(browser.runtime.getURL("zoho-client.json"));
    if (!resp.ok) return;
    const cfg = await resp.json();
    if (cfg && cfg.clientId && cfg.clientSecret) {
      await browser.zohoApi.setClientConfig(cfg);
    }
  } catch (e) {
    console.warn("spam-report-for-zoho-mail: zoho-client.json not loaded:", e && e.message);
  }
}

const clientConfigReady = loadZohoClientConfig();
browser.runtime.onStartup.addListener(async () => {
  await clientConfigReady;
  refreshAccountMap();
});
clientConfigReady.then(refreshAccountMap);

// Options page bumps this after (re)moving the connection.
browser.storage.local.onChanged.addListener((changes) => {
  if ("connectionPulse" in changes) refreshAccountMap();
});
