/* zohoApi: privileged parent-process implementation
 *
 * Design (see docs/architecture.md):
 *  - the access token is held IN MEMORY only (pasted via options; gone on
 *    restart);
 *  - report(): locate the Zoho messageId by matching recent /messages/view
 *    entries on sender, subject, and date, then PUT updatemessage in
 *    moveToSpam mode;
 *  - markJunkSelected(): drive Thunderbird's own junk machinery so the user's
 *    junk settings (folder moves, keyword, training) apply unchanged.
 */

"use strict";

// Services, Cu/Ci/Cc are pre-injected into the parent-process extension sandbox.
if (!globalThis.fetch) {
  Cu.importGlobalProperties(["fetch"]);
}

// --- connection model ---------------------------------------------------------
// Multiple Zoho users can be connected at once. A connection is either a
// stored one (refresh token kept in Thunderbird's password manager, access
// token in memory and auto-renewed) or the manual one (a pasted access token,
// memory only).

const SCOPES =
  "ZohoMail.accounts.READ,ZohoMail.messages.READ," +
  "ZohoMail.messages.UPDATE,ZohoMail.folders.READ";
const REDIRECT_PORT = 8642;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

const DC_TLD = {
  "com": "com",
  "eu": "eu",
  "in": "in",
  "com.au": "com.au",
  "com.cn": "com.cn",
};
const TLD_DC = Object.fromEntries(
  Object.entries(DC_TLD).map(([dc, tld]) => [tld, dc])
);

function dcHost(dc) {
  const tld = DC_TLD[dc];
  if (!tld) throw new Error(`unknown data center: ${dc}`);
  return `https://mail.zoho.${tld}`;
}
function accountsHost(dc) {
  const tld = DC_TLD[dc];
  if (!tld) throw new Error(`unknown data center: ${dc}`);
  return `https://accounts.zoho.${tld}`;
}

const connections = new Map(); // dc|username -> conn
const manualConn = {
  id: "manual", dc: null, username: "(manual token)",
  accessToken: null, expiresAt: 0, refreshToken: null,
  accounts: [], accountsLoaded: false,
};
let storedLoaded = false;

function allConns() {
  const list = [...connections.values()];
  if (manualConn.accessToken) list.push(manualConn);
  return list;
}

// --- OAuth client config (bundled with the add-on, never pasted into the UI) ---
// The extension's own pages (background, options) read zoho-client.json via
// browser.runtime.getURL + fetch and hand it over through setClientConfig;
// privileged file-reading APIs are deliberately avoided.
let clientConfig = null; // { clientId, clientSecret }

// --- password-manager storage for refresh tokens ------------------------------
// Pattern taken from Thunderbird's own OAuth2Module.sys.mjs: nsILoginInfo with
// the OAuth scope string as the httpRealm, the refresh token as the password.

function loginOrigin(dc) { return `https://accounts.zoho.${DC_TLD[dc]}`; }

async function saveRefreshToken(dc, username, token) {
  const origin = loginOrigin(dc);
  const logins = await Services.logins.searchLoginsAsync({ origin });
  for (const login of logins) {
    if (login.username === username && String(login.httpRealm || "").startsWith("ZohoMail")) {
      if (login.password !== token) {
        const propBag = Cc["@mozilla.org/hash-property-bag;1"]
          .createInstance(Ci.nsIWritablePropertyBag);
        propBag.setProperty("password", token);
        propBag.setProperty("httpRealm", SCOPES);
        propBag.setProperty("timePasswordChanged", Date.now());
        await Services.logins.modifyLoginAsync(login, propBag);
      }
      return;
    }
  }
  if (token) {
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"]
      .createInstance(Ci.nsILoginInfo);
    login.init(origin, null, SCOPES, username, token, "", "");
    await Services.logins.addLoginAsync(login);
  }
}

async function removeStoredToken(dc, username) {
  const origin = loginOrigin(dc);
  for (const login of await Services.logins.searchLoginsAsync({ origin })) {
    if (login.username === username && String(login.httpRealm || "").startsWith("ZohoMail")) {
      await Services.logins.removeLoginAsync(login);
    }
  }
}

async function loadStoredConnections() {
  if (storedLoaded) return;
  storedLoaded = true;
  for (const tld of Object.values(DC_TLD)) {
    let logins = [];
    try {
      logins = await Services.logins.searchLoginsAsync({ origin: `https://accounts.zoho.${tld}` });
    } catch (e) { continue; }
    for (const l of logins) {
      if (!String(l.httpRealm || "").startsWith("ZohoMail")) continue;
      const dc = TLD_DC[tld];
      const key = `${dc}|${l.username}`;
      if (!connections.has(key)) {
        connections.set(key, {
          id: key, dc, username: l.username, refreshToken: l.password,
          accessToken: null, expiresAt: 0, accounts: [], accountsLoaded: false,
        });
      }
    }
  }
}

// --- token acquisition and refresh ---------------------------------------------

async function tokenExchange(dc, params) {
  const cfg = clientConfig;
  if (!cfg || !cfg.clientId || !cfg.clientSecret) {
    throw new Error("no OAuth client configured (zoho-client.json missing; see docs/zoho-oauth-client.md)");
  }
  const fields = { ...params, client_id: cfg.clientId, client_secret: cfg.clientSecret };
  const resp = await fetch(`${accountsHost(dc)}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: formBody(fields),
  });
  let json = null;
  try { json = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok || !json || !json.access_token) {
    const detail = json ? (json.error_description || json.error || JSON.stringify(json)) : `HTTP ${resp.status}`;
    // Zoho docs use the uppercase grant name; the RFC standard name is the
    // lowercase one. Some Zoho DCs are strict about one or the other.
    if (params.grant_type === "authorization_code" && /invalid/i.test(String(detail))) {
      return tokenExchange(dc, { ...params, grant_type: "AUTHORIZATION_CODE" });
    }
    throw new Error(String(detail));
  }
  const keys = [];
  for (const k of Object.keys(json || {})) keys.push(k);
  console.log("zohoApi: token response fields:", keys.join(","));
  return json;
}

async function ensureToken(conn) {
  if (conn.accessToken && Date.now() < conn.expiresAt - 60_000) return conn.accessToken;
  if (!conn.refreshToken) {
    const err = new Error("not_connected_or_expired");
    err.name = "NotConnected";
    throw err;
  }
  const json = await tokenExchange(conn.dc, {
    grant_type: "refresh_token",
    refresh_token: conn.refreshToken,
  });
  conn.accessToken = json.access_token;
  conn.expiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
  if (json.refresh_token) {
    conn.refreshToken = json.refresh_token;
    if (conn.username) saveRefreshToken(conn.dc, conn.username, json.refresh_token).catch(() => {});
  }
  return conn.accessToken;
}

function apiHeaders(conn) {
  if (!conn.accessToken || Date.now() >= conn.expiresAt) {
    const err = new Error("not_connected_or_expired");
    err.name = "NotConnected";
    throw err;
  }
  return {
    // The scheme name below is literal; Zoho requires exactly this form.
    Authorization: `Zoho-oauthtoken ${conn.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function apiFetch(conn, path, init = {}) {
  await ensureToken(conn);
  const resp = await fetch(`${dcHost(conn.dc)}${path}`, {
    ...init,
    headers: { ...apiHeaders(conn), ...(init.headers || {}) },
  });
  let body = null;
  try {
    body = await resp.json();
  } catch {
    /* non-JSON body */
  }
  if (!resp.ok) {
    const detail = body?.data?.moreInfo ? body.data.moreInfo : JSON.stringify(body);
    const err = new Error(`HTTP ${resp.status}: ${detail}`);
    err.name = "ZohoApiError";
    throw err;
  }
  return body;
}

// --- account listing per connection ---------------------------------------------

function parseAccountsBody(body) {
  const out = [];
  const add = (email, accountId) => {
    const e = String(email || "").toLowerCase();
    const id = String(accountId || "");
    if (e && id && !out.some((x) => x.email === e)) {
      out.push({ email: e, accountId: id });
    }
  };
  // One entry per hosted mailbox. Hosted addresses are EXACTLY
  //   primaryEmailAddress + emailAlias[] (plain strings).
  // emailAddress[] additionally contains attached-but-not-hosted
  // addresses (recovery or alternate logins for the Zoho user) and
  // must NOT be treated as mailboxes.
  for (const entry of body?.data || []) {
    add(entry.primaryEmailAddress, entry.accountId);
    for (const alias of entry.emailAlias || []) {
      add(alias, entry.accountId);
    }
    if (!entry.primaryEmailAddress) {
      add(entry.mailboxAddress || entry.incomingUserName, entry.accountId);
    }
  }
  if (!out.length) {
    console.warn(
      "zohoApi.listAccounts: unrecognized /api/accounts shape:",
      JSON.stringify(body).slice(0, 400)
    );
  }
  return out;
}

async function ensureAccounts(conn) {
  if (!conn.accountsLoaded) {
    conn.accounts = parseAccountsBody(await apiFetch(conn, "/api/accounts"));
    conn.accountsLoaded = true;
    if (!conn.username) {
      conn.username = conn.accounts[0]?.email || "(unknown)";
    }
  }
  return conn.accounts;
}

async function resolveConn(accountId) {
  await loadStoredConnections();
  for (const conn of allConns()) {
    try {
      const accounts = await ensureAccounts(conn);
      if (accounts.some((a) => a.accountId === String(accountId))) return conn;
    } catch (e) {
      console.warn("zohoApi.resolveConn: connection unusable:", conn.id, e?.message);
    }
  }
  return null;
}

// --- loopback OAuth listener (same XPCOM pattern as Thunderbird core) ----------

let pendingConnect = null; // { dc, state, status, message, socket, timer }

function formBody(fields) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

function b64Ascii(str) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "", sum = 0, bits = 0;
  for (let i = 0; i < str.length; i++) {
    sum = (sum << 8) | str.charCodeAt(i);
    bits += 8;
    while (bits >= 6) { out += chars[(sum >> (bits - 6)) & 63]; bits -= 6; }
  }
  if (bits) out += chars[(sum << (6 - bits)) & 63];
  while (out.length % 4) out += "=";
  return out;
}

function zsrDecode(s) {
  return String(s).replace(/\+/g, " ").replace(/%([0-9A-Fa-f]{2})/g,
    (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseParams(queryStr) {
  const map = new Map();
  for (const pair of String(queryStr || "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    map.set(zsrDecode(k), zsrDecode(v));
  }
  return map;
}

function makeState() {
  try {
    return Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
  } catch (e) {
    return "zsr-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }
}

function openExternally(url) {
  // Try, in order: TB core's own link launcher (what message windows use for
  // http links), the external protocol service with a triggering principal,
  // and the legacy one-argument call. Collect every failure reason.
  const errs = [];
  let uriObj = null;
  try {
    uriObj = Services.io.newURI(url);
  } catch (e) {
    return { ok: false, error: `newURI: ${e?.message || e}` };
  }
  try {
    const { openLinkExternally } = ChromeUtils.importESModule("resource:///modules/LinkHelper.sys.mjs");
    openLinkExternally(uriObj);
    return { ok: true };
  } catch (e) {
    errs.push(`LinkHelper: ${e?.message || e}`);
  }
  const eps = () => Cc["@mozilla.org/uriloader/external-protocol-service;1"]
    .getService(Ci.nsIExternalProtocolService);
  try {
    eps().loadURI(uriObj, Services.scriptSecurityManager.getSystemPrincipal());
    return { ok: true };
  } catch (e) {
    errs.push(`loadURI+principal: ${e?.message || e}`);
  }
  try {
    eps().loadURI(uriObj);
    return { ok: true };
  } catch (e) {
    errs.push(`loadURI: ${e?.message || e}`);
  }
  return { ok: false, error: errs.join(" | ") };
}

function writeAndClose(connection, status, html) {
  try {
    const payload = `HTTP/1.1 ${status}\r\nContent-Type: text/html; charset=utf-8` +
      `\r\nContent-Length: ${html.length}\r\nConnection: close\r\n\r\n${html}`;
    try {
      connection._outputStream.write(payload, payload.length);
    } catch (e) {
      if (/Not enough arguments/i.test(String(e?.message || e))) {
        connection._outputStream.write(payload);
      } else { throw e; }
    }
    connection._outputStream.close(); // FIN after the response
    console.log("zsr parse: responded", status);
  } catch (e) {
    console.log("zsr parse: response write failed:", e?.message || e);
  }
  // Drain any request bytes still queued; closing with unread receive data
  // makes the OS send RST instead of FIN and the browser reports a reset.
  try {
    const ss = Cc["@mozilla.org/scriptableinputstream;1"]
      .createInstance(Ci.nsIScriptableInputStream);
    ss.init(connection._inputStream);
    for (let guard = 0; guard < 16; guard++) {
      const avail = connection._inputStream.available();
      if (avail <= 0) break;
      ss.read(avail);
    }
  } catch { /* gone */ }
  connection.close();
}

function closePendingConnect() {
  if (!pendingConnect) return;
  if (pendingConnect.timer && typeof clearTimeout === "function") {
    clearTimeout(pendingConnect.timer);
  }
  try { pendingConnect.socket?.close(); } catch { /* already closed */ }
  pendingConnect.socket = null;
  if (liveListenerSocket) {
    try { liveListenerSocket.close(); } catch { /* already closed */ }
    liveListenerSocket = null;
  }
}

function setConnectResult(status, message) {
  if (pendingConnect) {
    pendingConnect.status = status;
    pendingConnect.message = message || "";
  }
  closePendingConnect();
}

// Loopback listener, modeled on Thunderbird core's OAuth2.sys.mjs: the
// server-socket callback is onSocketAccepted, and the per-connection input
// stream observer must QI to nsIInputStreamCallback.
let liveListenerSocket = null;
const liveConnections = new Set();

function startListener(dc) {
  if (liveListenerSocket) {
    try { liveListenerSocket.close(); } catch { /* already closed */ }
    liveListenerSocket = null;
  }
  const socket = Cc["@mozilla.org/network/server-socket;1"]
    .createInstance(Ci.nsIServerSocket);
  socket.init(REDIRECT_PORT, true, -1); // loopback only, any backlog
  liveListenerSocket = socket;
  socket.asyncListen({
    QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
    onSocketAccepted(_serverSocket, transport) {
      console.log("zohoApi listener: connection accepted");
      const connection = {
        QueryInterface: ChromeUtils.generateQI(["nsIInputStreamCallback"]),
        _transport: transport,
        _inputStream: transport.openInputStream(0, 0, 0)
          .QueryInterface(Ci.nsIAsyncInputStream),
        _outputStream: transport.openOutputStream(
          Ci.nsITransport.OPEN_BLOCKING, 0, 0),
        _buffer: "",
        close() {
          if (!this._transport) return;
          try { this._inputStream.close(); } catch { /* gone */ }
          try { this._outputStream.close(); } catch { /* gone */ }
          try { this._transport.close(Cr.NS_OK); } catch { /* gone */ }
          this._transport = null;
          liveConnections.delete(this);
        },
        onInputStreamReady(stream) {
          console.log("zsr parse: ready fired");
          try {
          this._onInput(stream);
          } catch (e) {
            console.error("zohoApi listener: parse error:", e?.message || e);
            try { writeAndClose(connection, "400 Bad Request", "<html><body>Bad request.</body></html>"); } catch { /* gone */ }
          }
        },
        _onInput(stream) {
          console.log("zsr parse: enter");
          let available;
          try { available = stream.available(); }
          catch (e) {
            console.log("zsr parse: available() threw:", e?.message || e);
            connection.close(); return;
          }
          console.log("zsr parse: available =", available);
          if (available <= 0) {
            stream.asyncWait(connection, 0, 0, Services.tm.mainThread);
            return;
          }
          const scriptableStream = Cc["@mozilla.org/scriptableinputstream;1"]
            .createInstance(Ci.nsIScriptableInputStream);
          scriptableStream.init(stream);
          let gotChars = -1;
          try {
            const chunk = scriptableStream.read(available);
            gotChars = chunk.length;
            connection._buffer += chunk;
          } catch (e) {
            console.log("zsr parse: read threw:", e?.message || e);
            stream.asyncWait(connection, 0, 0, Services.tm.mainThread);
            return;
          }
          console.log("zsr parse: read", gotChars, "chars; buffer now",
            connection._buffer.length, "starting:", JSON.stringify(connection._buffer.slice(0, 24)));
          const eol = connection._buffer.indexOf("\r\n");
          console.log("zsr parse: eol index =", eol);
          if (eol < 0) {
            if (connection._buffer.length > 8192) {
              writeAndClose(connection, "431 Request Header Fields Too Large",
                "<html><body>Request too large.</body></html>");
              return;
            }
            stream.asyncWait(connection, 0, 0, Services.tm.mainThread);
            return;
          }
          const requestLine = connection._buffer.substring(0, eol);
          const match = /^GET\s+(\S+)(?:\s|$)/.exec(requestLine);
          console.log("zsr parse: requestLine:",
            JSON.stringify(requestLine.replace(/\s+HTTP.*$/, " <line>")),
            "match:", match ? match[1].split("?")[0] : "NO MATCH");
          if (!match) {
            console.log("zsr parse: 400 (regex)");
            writeAndClose(connection, "400 Bad Request",
              "<html><body>Bad request.</body></html>");
            return;
          }
          const qIdx = match[1].indexOf("?");
          const path = (qIdx < 0 ? match[1] : match[1].slice(0, qIdx))
            .replace(/\/+$/, "");
          const query = qIdx < 0 ? "" : match[1].slice(qIdx + 1);
          const params = parseParams(query);
          // Log path and parameter names only, never values.
          const names = [];
          for (const k of params.keys()) names.push(k);
          console.log("zsr parse: got:", path, "params:", names.join(","));
          if (path !== "/callback") {
            writeAndClose(connection, "404 Not Found",
              "<html><body>Not found.</body></html>");
            return;
          }
          writeAndClose(connection, "200 OK",
            "<html><head><title>Spam Report for Zoho Mail</title></head><body style=\"font-family:sans-serif\">" +
            "<h3>Spam Report for Zoho Mail</h3><p>Authentication complete. You can close this tab " +
            "and finish in Thunderbird.</p></body></html>");
          handleCallback(params);
        },
      };
      liveConnections.add(connection);
      try {
        connection._inputStream.asyncWait(connection, 0, 0, Services.tm.mainThread);
        let avail = -1;
        try { avail = connection._inputStream.available(); } catch { /* nonblocking */ }
        console.log("zohoApi listener: wait armed; bytes available:", avail);
        if (avail > 0) {
          // Data already arrived before arming; read it synchronously.
          connection._onInput(connection._inputStream);
        }
      } catch (e) {
        console.error("zohoApi listener: asyncWait arm failed:", e?.message || e);
        try { connection.close(); } catch { /* gone */ }
      }
    },
    onStopListening() {},
  });
  return socket;
}

async function handleCallback(params) {
  if (!pendingConnect) return;
  const dc = pendingConnect.dc;
  try {
    const error = params.get("error");
    if (error) throw new Error(error + (params.get("error_description") ? `: ${params.get("error_description")}` : ""));
    if (params.get("state") !== pendingConnect.state) {
      // A stray request (e.g. an old browser tab retrying a dead connect).
      // Ignore it; keep the real listener waiting.
      console.warn("zohoApi: ignoring callback with foreign state");
      return;
    }
    const code = params.get("code");
    if (!code) {
      console.warn("zohoApi: ignoring request without a code");
      return;
    }

    const json = await tokenExchange(dc, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });
    if (!json.refresh_token) {
      throw new Error("Zoho returned no refresh_token; the consent may need prompt=consent access_type=offline");
    }
    const conn = {
      id: `${dc}|pending`, dc, username: null,
      refreshToken: json.refresh_token,
      accessToken: json.access_token,
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      accounts: [], accountsLoaded: false,
    };
    const accounts = await ensureAccounts(conn);
    conn.username = accounts[0]?.email || "unknown";
    conn.id = `${dc}|${conn.username}`;
    connections.set(conn.id, conn);
    await saveRefreshToken(dc, conn.username, json.refresh_token);
    setConnectResult("done", conn.username);
  } catch (e) {
    setConnectResult("error", e?.message || String(e));
  }
}

// --- message matching ---------------------------------------------------------
// Zoho subjects come back HTML-entity-encoded (&#39;, &amp;, &nbsp;);
// Thunderbird hands us the decoded MIME header form. Decode before comparing.
function decodeEntities(value) {
  let out = String(value || "");
  for (let round = 0; round < 3; round++) {
    const next = _decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}
function _decodeOnce(value) {
  return String(value).replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]+);/g,
    (all, body) => {
      if (body[0] === "#") {
        const cp = body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
          try { return String.fromCodePoint(cp); } catch { return all; }
        }
        return all;
      }
      const named = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0",
        ndash: "\u2013", mdash: "\u2014", hellip: "\u2026",
        ldquo: "\u201C", rdquo: "\u201D", lsquo: "\u2018", rsquo: "\u2019",
      };
      return Object.prototype.hasOwnProperty.call(named, body.toLowerCase())
        ? named[body.toLowerCase()]
        : all;
    });
}

function stripPrefixes(value) {
  return decodeEntities(value)
    // typographic lookalikes next: Zoho's decoding and TB's MIME decoding
    // can disagree on curly quotes, dashes, and non-breaking spaces
    .normalize("NFKD")
    .replace(/[\u2018\u2019\u201B\u02BC\u00B4`]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2000-\u200B\u202F\uFEFF]/g, " ")
    // junk mailers pad subjects with zero-width and emoji decoration
    .replace(/[\u200C-\u200F\u2060-\u2064]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, "")
    // marketing padding brackets around the real subject
    .replace(/^[\[(<{|]\s*/, "")
    .replace(/\s*[\])>}|]$/, "")
    .replace(/^(?:(?:re|fwd?|fw):\s*)+/gi, "")
    .replace(/^[\[(<{|]\s*/, "")
    .replace(/\s*[\])>}|]$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeMsgId(s) {
  if (!s) return "";
  return String(s).trim().replace(/^<+|>+$/g, "").toLowerCase();
}

function emailOf(addr) {
  const m = /<([^>]+)>/.exec(addr || "");
  return (m ? m[1] : addr || "").trim().toLowerCase();
}

const byDateDistance = (dateEpochMs) => (a, b) =>
  Math.abs((Number(a.receivedTime) || 0) - dateEpochMs) -
  Math.abs((Number(b.receivedTime) || 0) - dateEpochMs);

// Zoho folders: folderId=spam alias is not accepted by /messages/view (it
// wants the numeric id). Resolve it once per account via /folders.
const junkFolderIdByAccount = new Map();

async function getJunkFolderId(accountId, conn) {
  if (junkFolderIdByAccount.has(accountId)) return junkFolderIdByAccount.get(accountId);
  const body = await apiFetch(conn, `/api/accounts/${accountId}/folders`);
  for (const f of body?.data || []) {
    const type = String(f.folderType || f.type || "").toLowerCase();
    const name = String(f.folderName || "").toLowerCase();
    if (type === "spam" || type === "junk" || name === "spam" || name === "junk") {
      junkFolderIdByAccount.set(accountId, String(f.folderId));
      return String(f.folderId);
    }
  }
  console.warn("zohoApi: no Spam/Junk folder in",
    JSON.stringify((body?.data || []).map((f) => f.folderName)));
  return null;
}

async function findMessageId(details, conn) {
  // Default view covers the inbox; messages already sitting in server-side
  // Spam (the report-not-spam direction) need the Spam folder explicitly.
  const queries = [
    `/api/accounts/${details.accountId}/messages/view?limit=100&sortBy=date&sortorder=false`,
  ];
  if (details.inJunk) {
    try {
      const folderId = await getJunkFolderId(details.accountId, conn);
      if (folderId) {
        queries.push(
          `/api/accounts/${details.accountId}/messages/view?limit=100&sortBy=date&sortorder=false&folderId=${folderId}`
        );
      }
    } catch (e) {
      console.warn("zohoApi.findMessageId: could not resolve Spam folder id",
        "(missing ZohoMail.folders.READ scope?)", e?.message);
    }
  }
  const messages = [];
  const seen = new Set();
  for (const url of queries) {
    try {
      const body = await apiFetch(conn, url);
      for (const m of body?.data || []) {
        const id = String(m.messageId || "");
        if (id && !seen.has(id)) { seen.add(id); messages.push(m); }
      }
    } catch (e) {
      console.warn("zohoApi.findMessageId: query failed",
        url.includes("folderId=") ? "(spam folder)" : "(inbox)", e?.message);
    }
  }

  // Preferred: confirm candidates against the RFC Message-Id that
  // Thunderbird reports for the displayed message. Subject lines are not
  // dependable (spam mailers mangle them, replies prepend Re:), but the
  // header survives delivery untouched. Pre-filter by sender + time
  // proximity, then verify with at most a handful of header fetches.
  const rfc = normalizeMsgId(details.internetMessageId);
  if (rfc) {
    const cands = messages
      .filter((m) => emailOf(m.fromAddress) === emailOf(details.fromAddress))
      .sort(byDateDistance(details.dateEpochMs))
      .slice(0, 6);
    const matches = [];
    for (const m of cands) {
      try {
        const body = await apiFetch(conn,
          `/api/accounts/${details.accountId}/folders/${m.folderId}/messages/${m.messageId}/header`);
        const hdr = body?.data?.headerContent;
        const found = typeof hdr === "string"
          ? (hdr.match(/message-id:\s*<([^>\r\n]+)>/i) || [])[1]
          : (hdr && Array.isArray(hdr["Message-Id"]) ? hdr["Message-Id"][0] : "");
        if (found && normalizeMsgId(found) === rfc) {
          matches.push({ messageId: String(m.messageId), folderId: String(m.folderId) });
        }
      } catch (e) {
        console.warn("zohoApi.findMessageId: header check failed for",
          m.messageId, e?.message);
      }
    }
    if (matches.length) {
      // Zoho may hold more than one entry for one RFC Message-Id.
      // Report every match so a live copy cannot hide behind another.
      console.log("zohoApi.findMessageId: RFC Message-Id matched",
        matches.length, matches.length === 1 ? "Zoho entry" : "Zoho entries", ":",
        matches.map((m) => `${m.messageId}@folder ${m.folderId}`).join(", "));
      return matches;
    }
    console.warn("zohoApi.findMessageId: RFC Message-Id unmatched",
      cands.length, "candidate(s) checked; falling back to sender+subject");
  }

  const hit = pickMatch(messages, details);
  if (hit) return [{ messageId: hit }];
  console.warn(
    "zohoApi.findMessageId: no match. looking for",
    JSON.stringify({
      from: emailOf(details.fromAddress),
      subject: stripPrefixes(details.subject),
      dateEpochMs: details.dateEpochMs,
    }),
    "in", messages.length, "recent entries; closest by sender:",
    JSON.stringify(
      messages
        .filter((m) => emailOf(m.fromAddress) === emailOf(details.fromAddress))
        .slice(0, 5)
        .map((m) => ({ subject: m.subject, receivedTime: m.receivedTime, folderId: m.folderId }))
    )
  );
  return [];
}

function pickMatch(messages, details) {
  const from = emailOf(details.fromAddress);
  const subject = stripPrefixes(details.subject);
  const WINDOW_MS = 3 * 60 * 60 * 1000; // TB clock vs Zoho receivedTime tolerance

  const near = messages.filter((m) => {
    if (emailOf(m.fromAddress) !== from) return false;
    if (stripPrefixes(m.subject) !== subject) return false;
    return Math.abs((Number(m.receivedTime) || 0) - details.dateEpochMs) <= WINDOW_MS;
  });
  if (near.length) return String(near.sort(byDateDistance(details.dateEpochMs))[0].messageId);

  // Fallback: same sender + normalized subject, ignoring the time window
  // (handles older messages outside the 50-item / 40-minute window).
  const loose = messages.filter(
    (m) => emailOf(m.fromAddress) === from && stripPrefixes(m.subject) === subject
  );
  if (loose.length) return String(loose.sort(byDateDistance(details.dateEpochMs))[0].messageId);

  return null;
}

async function connectInner(dc) {
  if (!DC_TLD[dc]) return { ok: false, error: `unknown data center: ${dc}` };
  const cfg = clientConfig;
  if (!cfg) {
    return { ok: false, error: "no zoho-client.json was loaded (create it in the add-on folder; see docs/zoho-oauth-client.md)" };
  }
  if (!cfg.clientId || !cfg.clientSecret || String(cfg.clientId).startsWith("PASTE")) {
    return { ok: false, error: "zoho-client.json still contains placeholder values" };
  }
  if (pendingConnect && pendingConnect.status === "waiting") {
    return { ok: false, error: "a connect is already in progress" };
  }
  let socket;
  try {
    socket = startListener(dc);
  } catch (e) {
    return { ok: false, error: `cannot listen on port ${REDIRECT_PORT}: ${e?.message}` };
  }
  const stateValue = makeState();
  pendingConnect = { dc, state: stateValue, status: "waiting", message: "", socket, timer: null };
  if (typeof setTimeout === "function") {
    try {
      pendingConnect.timer = setTimeout(() => {
        if (pendingConnect && pendingConnect.status === "waiting") {
                  console.warn("zohoApi: connect timed out (10 min), closing listener");
          setConnectResult("error", "timed out waiting for the browser callback");
        }
      }, 600000);
    } catch (e) { /* no timeout; Cancel still works */ }
  }
  const url =
    `${accountsHost(dc)}/oauth/v2/auth?response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&format=json&access_type=offline&prompt=consent` +
    `&client_id=${encodeURIComponent(cfg.clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${encodeURIComponent(stateValue)}`;
  const opened = openExternally(url);
  if (!opened.ok) {
    closePendingConnect();
    setConnectResult("idle", "");
    return { ok: false, error: `browser launch failed: ${opened.error}` };
  }
  return { ok: true, redirectUri: REDIRECT_URI };
}

// --- experiment API surface ----------------------------------------------------
// Naming contract: the sandbox global holding the ExtensionAPI subclass must be
// named exactly like the namespace (zohoApi), matching the manifest
// experiment_apis.zohoApi.parent.paths entry ["zohoApi"].
let currentRootURI = "";

// Depending on Thunderbird version, extension.rootURI is a string or an
// nsIURI object. Normalize to a spec string ending in a slash.
function rootURISpec(extension) {
  const r = extension && extension.rootURI;
  let spec = "";
  if (typeof r === "string") spec = r;
  else if (r && typeof r.spec === "string") spec = r.spec;
  if (spec && !spec.endsWith("/")) spec += "/";
  return spec;
}

var zohoApi = class extends ExtensionCommon.ExtensionAPI {
  onShutdown() {
    // Close any listener this instance opened so add-on reloads do not
    // strand the port until an app restart.
    closePendingConnect();
  }

  getAPI() {
    currentRootURI = rootURISpec(this.extension);
    console.log("zohoApi: extension root", currentRootURI);
    // Kick off reading stored refresh tokens; calls also lazily await it.
    loadStoredConnections().catch(() => {});
    return {
      zohoApi: {
        // --- manual (pasted) token, kept for alpha-style testing ---------------
        async setConnection({ dc = "com", accessToken, expiresInSeconds = 3600 } = {}) {
          if (!accessToken) return { ok: false, error: "empty token" };
          if (!DC_TLD[dc]) return { ok: false, error: `unknown data center: ${dc}` };
          junkFolderIdByAccount.clear();
          manualConn.dc = dc;
          manualConn.accessToken = accessToken.trim();
          manualConn.expiresAt = Date.now() + expiresInSeconds * 1000;
          manualConn.accountsLoaded = false;
          return { ok: true, expiresAt: manualConn.expiresAt };
        },

        async clearConnection() {
          junkFolderIdByAccount.clear();
          manualConn.dc = null;
          manualConn.accessToken = null;
          manualConn.expiresAt = 0;
          manualConn.accounts = [];
          manualConn.accountsLoaded = false;
          return { ok: true };
        },

        async setClientConfig({ clientId, clientSecret } = {}) {
          if (!clientId || !clientSecret) return { ok: false, error: "empty" };
          clientConfig = {
            clientId: String(clientId).trim(),
            clientSecret: String(clientSecret).trim(),
          };
          return { ok: true };
        },

        // --- one-click connect ---------------------------------------------------
        async connect({ dc = "com" } = {}) {
          try {
            return await connectInner(dc);
          } catch (e) {
            console.warn("zohoApi.connect threw:", e);
            closePendingConnect();
            return { ok: false, error: `internal: ${e?.message || e}` };
          }
        },



        async connectState() {
          if (!pendingConnect) return { status: "idle" };
          return { status: pendingConnect.status, message: pendingConnect.message };
        },

        async connectCancel() {
          setConnectResult("idle", "cancelled");
          return { ok: true };
        },

        // --- connection inventory -------------------------------------------------
        async listConnections() {
          await loadStoredConnections();
          junkFolderIdByAccount.clear();
          const out = [];
          for (const conn of allConns()) {
            let accounts = [];
            let error = null;
            try {
              accounts = await ensureAccounts(conn);
            } catch (e) {
              error = e?.message || String(e);
            }
            out.push({
              id: conn.id, dc: conn.dc, username: conn.username,
              stored: !!conn.refreshToken, accounts, error,
            });
          }
          return out;
        },

        async disconnect({ dc, username } = {}) {
          junkFolderIdByAccount.clear();
          if (!dc && username) {
            for (const [key, conn] of connections) {
              if (conn.username === username) { dc = conn.dc; break; }
            }
          }
          if (!dc || !username) return { ok: false, error: "unknown connection" };
          const conn = connections.get(`${dc}|${username}`);
          if (conn?.refreshToken && clientConfig?.clientId) {
            try {
              // Zoho programmatic revoke: Basic client credentials + the
              // refresh token (revoking it also kills derived access tokens).
              const basic = b64Ascii(`${clientConfig.clientId}:${clientConfig.clientSecret}`);
              await fetch(`${accountsHost(dc)}/oauth/v2/revoke/token`, {
                method: "POST",
                headers: {
                  Authorization: `Basic ${basic}`,
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: `token=${encodeURIComponent(conn.refreshToken)}&token_type=refresh_token`,
              });
            } catch (e) {
              console.warn("zohoApi: server-side revoke failed (local removal still done):", e?.message);
            }
          }
          await removeStoredToken(dc, username);
          connections.delete(`${dc}|${username}`);
          return { ok: true };
        },

        async connectionStatus() {
          await loadStoredConnections();
          const live = allConns().some(
            (c) => (c.accessToken && Date.now() < c.expiresAt) || c.refreshToken
          );
          return { connected: live };
        },

        // --- mailbox and message operations ----------------------------------------
        async listAccounts() {
          await loadStoredConnections();
          const merged = [];
          for (const conn of allConns()) {
            try {
              for (const acc of await ensureAccounts(conn)) {
                if (!merged.some((x) => x.email === acc.email)) merged.push(acc);
              }
            } catch (e) {
              console.warn("zohoApi.listAccounts: connection failed:", conn.id, e?.message);
            }
          }
          return merged;
        },

        async dumpAccounts() {
          try {
            await loadStoredConnections();
            const conn = allConns()[0];
            if (!conn) return { ok: false, error: "not connected" };
            await ensureToken(conn);
            const resp = await fetch(dcHost(conn.dc) + "/api/accounts", {
              method: "GET",
              headers: apiHeaders(conn),
            });
            const text = await resp.text();
            return { ok: true, status: resp.status, body: text };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },

        async report(details) {
          const mode = details.mode === "markNotSpam" ? "markNotSpam" : "moveToSpam";
          try {
            const conn = await resolveConn(details.accountId);
            if (!conn) return { ok: false, error: "no_connection_for_account" };
            const matches = await findMessageId(details, conn);
            if (!matches?.length) return { ok: false, error: "message_not_found" };
            const ids = matches.map((m) => m.messageId);
            // updatemessage accepts an id list; include every duplicate that
            // shares the RFC Message-Id so no live copy hides behind a stale one.
            const resp = await apiFetch(conn, `/api/accounts/${details.accountId}/updatemessage`, {
              method: "PUT",
              body: JSON.stringify({ mode, messageId: ids }),
            });
            console.log("zohoApi: updatemessage", mode, "on", ids.length,
              "entries; response:", JSON.stringify(resp));
            return { ok: true, messageId: ids[0], messageIds: ids, mode };
          } catch (e) {
            console.warn("zohoApi.report failed:", e?.message);
            return { ok: false, error: e?.message || "unknown" };
          }
        },

        async markJunkSelected({ notJunk = false } = {}) {
          // Drive Thunderbird's own junk machinery (folder move, server junk
          // keyword, adaptive filter training) instead of reimplementing it.
          let lastErr = "no mail:3pane window found";
          for (const win of Services.wm.getEnumerator("mail:3pane")) {
            try {
              const view = win.GetDBView ? win.GetDBView() : null;
              const hdrs = win.GetSelectedMsgHdrs ? win.GetSelectedMsgHdrs() : null;
              if (view && hdrs?.length) {
                const cmd = notJunk
                  ? Ci.nsMsgViewCommandType.markNotJunk
                  : Ci.nsMsgViewCommandType.junk;
                view.markMessages(hdrs, cmd);
                return { ok: true, method: "dbview" };
              }
            } catch (e) {
              lastErr = e?.message || lastErr;
            }
            try {
              if (typeof win.goDoCommand === "function") {
                win.goDoCommand(notJunk ? "cmdMarkNotJunk" : "cmdMarkJunk");
                return { ok: true, method: notJunk ? "cmdMarkNotJunk" : "cmdMarkJunk" };
              }
            } catch (e) {
              lastErr = e?.message || lastErr;
            }
          }
          return { ok: false, error: lastErr };
        },
      },
    };
  }
}
