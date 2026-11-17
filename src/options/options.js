/* Spam Report for Zoho Mail: options page
 * One-click OAuth connect (loopback callback handled by the experiment),
 * connected-user list with disconnect, detected Zoho mailboxes, and
 * Thunderbird identity matching preview. Manual token paste kept as an
 * advanced fallback.
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

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${cls}`;
}

async function renderStatus() {
  let conns;
  try {
    conns = await browser.zohoApi.listConnections();
  } catch (e) {
    setStatus(`Error from zohoApi.listConnections: ${e.message}`, "err");
    return { connected: false, conns: [] };
  }
  if (!conns.length) {
    setStatus("Not connected. Choose a data center and press Connect Zoho.", "warn");
  } else {
    const users = conns.filter((c) => c.stored).map((c) => c.username);
    const parts = [];
    if (users.length) parts.push(`${users.length} Zoho user${users.length > 1 ? "s" : ""}`);
    if (conns.some((c) => !c.stored)) parts.push("a manual token");
    setStatus(`Connected: ${parts.join(" and ")}. Access tokens renew automatically.`, "ok");
  }
  return { connected: conns.length > 0, conns };
}

async function renderConnections() {
  const list = $("connection-list");
  list.textContent = "";
  let conns;
  try {
    conns = await browser.zohoApi.listConnections();
  } catch (e) {
    const li = document.createElement("li");
    li.className = "err";
    li.textContent = `Could not list connections: ${e.message}`;
    list.append(li);
    return;
  }
  for (const conn of conns) {
    const li = document.createElement("li");
    const label = conn.stored
      ? `${conn.username} (${conn.dc})`
      : "manual token (this session only)";
    li.textContent = label;
    if (conn.error) {
      li.className = "warn";
      li.textContent = `${label} - token needs reconnecting (${conn.error})`;
    }
    if (conn.stored) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost";
      btn.textContent = "Disconnect";
      btn.addEventListener("click", async () => {
        await browser.zohoApi.disconnect({ dc: conn.dc, username: conn.username });
        await safeSet({ connectionPulse: Date.now() });
        await renderStatus();
        await renderConnections();
        await renderAccounts();
      });
      li.append(" ", btn);
    }
    list.append(li);
  }
}

let polling = null;

function setConnectUI({ busy, message }) {
  $("connect-btn").disabled = Boolean(busy);
  $("connect-cancel").hidden = !busy;
  const p = $("connect-progress");
  p.hidden = !message;
  p.textContent = message || "";
}

async function finishConnectPolling({ keepStatus = false } = {}) {
  if (polling) { clearInterval(polling); polling = null; }
  setConnectUI({ busy: false, message: "" });
  await safeSet({ connectionPulse: Date.now() });
  if (!keepStatus) {
    await renderStatus();
  }
  await renderConnections();
  await renderAccounts();
}

$("connect-btn").addEventListener("click", async () => {
  let result;
  try {
    result = await browser.zohoApi.connect({ dc: $("dc").value });
  } catch (e) {
    setStatus(`Error from zohoApi.connect: ${e.message}`, "err");
    return;
  }
  if (!result || !result.ok) {
    setStatus(`Connect failed: ${result ? result.error : "no result returned"}`, "err");
    return;
  }
  setConnectUI({
    busy: true,
    message: "Complete sign-in in the browser tab that just opened. " +
      "Zoho will redirect back to this computer; this page updates on its own.",
  });
  polling = setInterval(async () => {
    let st;
    try {
      st = await browser.zohoApi.connectState();
    } catch (e) {
      setConnectUI({ busy: false, message: "" });
      setStatus(`Connect polling error: ${e.message}`, "err");
      return;
    }
    if (st.status === "waiting") return;
    if (st.status === "done") {
      setStatus(`Connected: ${st.message}`, "ok");
      await finishConnectPolling();
    } else if (st.status === "error") {
      setStatus(`Connect failed: ${st.message}`, "err");
      await finishConnectPolling({ keepStatus: true });
    } else {
      await finishConnectPolling();
    }
  }, 800);
});

$("connect-cancel").addEventListener("click", async () => {
  await browser.zohoApi.connectCancel();
  await finishConnectPolling();
});

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
    li.textContent = "No mailboxes visible to the connected accounts.";
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
    setStatus(`Error from zohoApi.setConnection: ${e.message}`, "err");
    return;
  }
  if (!result || !result.ok) {
    setStatus(`setConnection failed: ${result ? result.error : "no result returned"}`, "err");
    return;
  }
  if (result.ok) {
    $("token").value = "";
    // nudge the background script to rebuild its account map (never fatal)
    await safeSet({ connectionPulse: Date.now() });
  }
  await renderStatus();
  await renderConnections();
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
  await renderConnections();
  await renderAccounts();
});

window.addEventListener("error", (ev) => {
  setStatus(`Error: ${ev.message}`, "err");
});

(async function init() {
  // Load the OAuth client config (add-on-root zoho-client.json) before anything
  // can connect or refresh tokens.
  try {
    const resp = await fetch(browser.runtime.getURL("zoho-client.json"));
    if (resp.ok) {
      const cfg = await resp.json();
      if (cfg && cfg.clientId && cfg.clientSecret) {
        await browser.zohoApi.setClientConfig(cfg);
      }
    }
  } catch (e) {
    console.warn("zoho-client.json not loaded:", e.message);
  }
  const saved = await browser.storage.local.get("lastDc");
  if (saved.lastDc) $("dc").value = saved.lastDc;
  const status = await renderStatus();
  await renderConnections();
  if (status.connected) {
    await renderAccounts();
  }
  $("dc").addEventListener("change", async (e) => {
    await safeSet({ lastDc: e.target.value });
  });
})();
