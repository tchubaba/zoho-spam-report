/* Zoho Spam Report: options page
 * Token paste -> zohoApi.setConnection (in-memory), connection status,
 * detected Zoho mailboxes, and Thunderbird identity matching preview.
 */
"use strict";

const $ = (id) => document.getElementById(id);

// Thunderbird identity.email may be "Display Name <addr@x.y>"; accept both forms.
function parseEmail(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

async function safeSet(obj) {
  try {
    await browser.storage.local.set(obj);
  } catch (e) {
    console.warn("storage unavailable:", e.message);
  }
}

function fmt(expiresAt) {
  if (!expiresAt) return "";
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  return ` (expires in ~${left} min)`;
}

async function renderStatus() {
  let status;
  try {
    status = await browser.zohoApi.connectionStatus();
  } catch (e) {
    const el = $("status");
    el.textContent = `Error from zohoApi.connectionStatus: ${e.message}`;
    el.className = "status err";
    return { connected: false };
  }
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
    const resp = await browser.runtime.sendMessage({ type: "identityEmails" });
    for (const e of (resp && resp.emails) || []) tbEmails.add(e);
  } catch (e) {
    console.warn("identityEmails request failed:", e);
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
  let result;
  try {
    result = await browser.zohoApi.setConnection({
      dc: $("dc").value,
      accessToken: $("token").value,
      expiresInSeconds: Number($("expires").value) || 3600,
    });
  } catch (e) {
    const el = $("status");
    el.textContent = `Error from zohoApi.setConnection: ${e.message}`;
    el.className = "status err";
    return;
  }
  if (!result || !result.ok) {
    const el = $("status");
    el.textContent = `setConnection failed: ${result ? result.error : "no result returned"}`;
    el.className = "status err";
    return;
  }
  if (result.ok) {
    $("token").value = "";
    // nudge the background script to rebuild its account map (never fatal)
    await safeSet({ connectionPulse: Date.now() });
  }
  await renderStatus();
  await renderAccounts();
});

$("dump-btn").addEventListener("click", async () => {
  const pre = $("raw-dump");
  try {
    const r = await browser.zohoApi.dumpAccounts();
    pre.textContent = r.ok
      ? `HTTP ${r.status}\n${JSON.stringify(JSON.parse(r.body), null, 2)}`
      : `error: ${r.error}`;
  } catch (e) {
    pre.textContent = `error: ${e.message}`;
  }
  pre.hidden = false;
});

$("clear").addEventListener("click", async () => {
  await browser.zohoApi.clearConnection();
  await safeSet({ connectionPulse: Date.now() });
  await renderStatus();
  await renderAccounts();
});

window.addEventListener("error", (ev) => {
  const el = $("status");
  el.textContent = `Error: ${ev.message}`;
  el.className = "status err";
});

(async function init() {
  const status = await renderStatus();
  if (status.connected) {
    const saved = await browser.storage.local.get("lastDc");
    if (saved.lastDc) $("dc").value = saved.lastDc;
    await renderAccounts();
  }
  $("dc").addEventListener("change", async (e) => {
    await safeSet({ lastDc: e.target.value });
  });
})();
