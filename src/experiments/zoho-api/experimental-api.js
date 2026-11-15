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

// --- connection state (in-memory only; alpha) --------------------------------
const state = {
  dc: null,
  accessToken: null,
  expiresAt: 0, // epoch ms
};

const DC_TLD = {
  "com": "com",
  "eu": "eu",
  "in": "in",
  "com.au": "com.au",
  "com.cn": "com.cn",
};

function dcHost(dc) {
  const tld = DC_TLD[dc];
  if (!tld) throw new Error(`unknown data center: ${dc}`);
  return `https://mail.zoho.${tld}`;
}

function apiHeaders() {
  if (!state.accessToken || Date.now() >= state.expiresAt) {
    const err = new Error("not_connected_or_expired");
    err.name = "NotConnected";
    throw err;
  }
  return {
    // The scheme name below is literal; Zoho requires exactly this form.
    Authorization: `Zoho-oauthtoken ${state.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function apiFetch(path, init = {}) {
  const resp = await fetch(`${dcHost(state.dc)}${path}`, {
    ...init,
    headers: { ...apiHeaders(), ...(init.headers || {}) },
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

async function getJunkFolderId(accountId) {
  if (junkFolderIdByAccount.has(accountId)) return junkFolderIdByAccount.get(accountId);
  const body = await apiFetch(`/api/accounts/${accountId}/folders`);
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

async function findMessageId(details) {
  // Default view covers the inbox; messages already sitting in server-side
  // Spam (the report-not-spam direction) need the Spam folder explicitly.
  const queries = [
    `/api/accounts/${details.accountId}/messages/view?limit=100&sortBy=date&sortorder=false`,
  ];
  if (details.inJunk) {
    try {
      const folderId = await getJunkFolderId(details.accountId);
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
  let messages = [];
  for (const url of queries) {
    try {
      const recent = await apiFetch(url);
      messages = recent?.data || [];
      const hit = pickMatch(messages, details);
      if (hit) return hit;
    } catch (e) {
      console.warn("zohoApi.findMessageId: query failed",
        url.includes("folderId=spam") ? "(spam folder)" : "(inbox)", e?.message);
    }
  }
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
  return null;
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

// --- experiment API surface ----------------------------------------------------
// Naming contract: the sandbox global holding the ExtensionAPI subclass must be
// named exactly like the namespace (zohoApi), matching the manifest
// experiment_apis.zohoApi.parent.paths entry ["zohoApi"].
var zohoApi = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return {
      zohoApi: {
        async setConnection({ dc = "com", accessToken, expiresInSeconds = 3600 } = {}) {
          if (!accessToken) return { ok: false, error: "empty token" };
          if (!DC_TLD[dc]) return { ok: false, error: `unknown data center: ${dc}` };
          state.dc = dc;
          state.accessToken = accessToken.trim();
          state.expiresAt = Date.now() + expiresInSeconds * 1000;
          return { ok: true, expiresAt: state.expiresAt };
        },

        async clearConnection() {
          junkFolderIdByAccount.clear();
          state.dc = null;
          state.accessToken = null;
          state.expiresAt = 0;
          return { ok: true };
        },

        async connectionStatus() {
          return {
            connected: !!state.accessToken && Date.now() < state.expiresAt,
            dc: state.dc,
            expiresAt: state.expiresAt,
          };
        },

        async listAccounts() {
          const body = await apiFetch("/api/accounts");
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
            // entries without primaryEmailAddress (older API variants)
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
        },

        async dumpAccounts() {
          try {
            const resp = await fetch(dcHost(state.dc) + "/api/accounts", {
              method: "GET",
              headers: apiHeaders(),
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
            const messageId = await findMessageId(details);
            if (!messageId) return { ok: false, error: "message_not_found" };
            await apiFetch(`/api/accounts/${details.accountId}/updatemessage`, {
              method: "PUT",
              body: JSON.stringify({ mode, messageId: [messageId] }),
            });
            return { ok: true, messageId, mode };
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
