/* Zoho Spam Report: options page
 * Token paste -> zohoApi.setConnection (in-memory), connection status,
 * detected Zoho mailboxes, and Thunderbird identity matching preview.
 */
"use strict";

const $ = (id) => document.getElementById(id);

function fmt(expiresAt) {
  if (!expiresAt) return "";
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  return ` (expires in ~${left} min)`;
}

async function renderStatus() {
  const status = await browser.zohoApi.connectionStatus();
  const el = $("status");
  if (status.connected) {
    el.textContent = `Connected to Zoho (${status.dc})${fmt(status.expiresAt)}.`;
    el.className = "status ok";
  } else {
    el.textContent = "Not connected. Paste an access token below.";
    el.className = "status warn";
  }
  return status;
}

async function renderAccounts() {
  const list = $("account-list");
  const matches = $("match-list");
  list.textContent = "";
  matches.textContent = "";
  let zoho = [];
  try {
    zoho = await browser.zohoApi.listAccounts();
  } catch (e) {
    const li = document.createElement("li");
    li.className = "err";
    li.textContent = `Could not list accounts: ${e.message}`;
    list.append(li);
    return;
  }
  if (!zoho.length) {
    const li = document.createElement("li");
    li.textContent = "No mailboxes visible to this token.";
    list.append(li);
    return;
  }

  // Thunderbird identity emails for match preview
  let tbEmails = new Set();
  try {
    const identities = await browser.messenger.identities.list();
    for (const i of identities) tbEmails.add(String(i.email || "").toLowerCase());
  } catch (e) {
    console.warn("identities.list() failed:", e);
  }

  for (const acc of zoho) {
    const li = document.createElement("li");
    li.textContent = `${acc.email}  (accountId ${acc.accountId})`;
    list.append(li);
    if (tbEmails.has(acc.email)) {
      const m = document.createElement("li");
      m.className = "ok";
      m.textContent = `Matched: ${acc.email} (configured in Thunderbird)`;
      matches.append(m);
    } else {
      const m = document.createElement("li");
      m.className = "warn";
      m.textContent = `Unmatched: ${acc.email} (no Thunderbird identity with this email)`;
      matches.append(m);
    }
  }
}

$("save").addEventListener("click", async () => {
  const result = await browser.zohoApi.setConnection({
    dc: $("dc").value,
    accessToken: $("token").value,
    expiresInSeconds: Number($("expires").value) || 3600,
  });
  if (result.ok) {
    $("token").value = "";
    // nudge the background script to rebuild its account map
    await browser.storage.local.set({ connectionPulse: Date.now() });
  }
  await renderStatus();
  await renderAccounts();
});

$("clear").addEventListener("click", async () => {
  await browser.zohoApi.clearConnection();
  await browser.storage.local.set({ connectionPulse: Date.now() });
  await renderStatus();
  await renderAccounts();
});

(async function init() {
  const status = await renderStatus();
  if (status.connected) {
    const saved = await browser.storage.local.get("lastDc");
    if (saved.lastDc) $("dc").value = saved.lastDc;
    await renderAccounts();
  }
  $("dc").addEventListener("change", async (e) => {
    await browser.storage.local.set({ lastDc: e.target.value });
  });
})();
