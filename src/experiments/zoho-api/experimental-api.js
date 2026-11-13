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

ChromeUtils.defineESModuleGetters(this, {
  Services: "resource://gre/modules/Services.sys.mjs",
});
Cu.importGlobalProperties(["fetch"]);

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
function stripPrefixes(value) {
  return String(value || "")
    .replace(/^(?:(?:re|fwd?|fw):\s*)+/gi, "")
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

async function findMessageId(details) {
  const recent = await apiFetch(
    `/api/accounts/${details.accountId}/messages/view?limit=50&sortBy=date&sortorder=false`
  );
  const messages = recent?.data || [];
  const from = emailOf(details.fromAddress);
  const subject = stripPrefixes(details.subject);
  const WINDOW_MS = 40 * 60 * 1000; // TB clock vs Zoho receivedTime tolerance

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
class ZohoApiAPI extends ExtensionAPI {
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
          for (const a of body?.data || []) {
            const accountId = String(a.accountId);
            const primary = String(a.email || "").toLowerCase();
            if (primary) out.push({ email: primary, accountId });
            for (const alias of a.emailAliases || []) {
              const email = String(alias.email || "").toLowerCase();
              if (email) out.push({ email, accountId });
            }
          }
          return out;
        },

        async report(details) {
          try {
            const messageId = await findMessageId(details);
            if (!messageId) return { ok: false, error: "message_not_found" };
            await apiFetch(`/api/accounts/${details.accountId}/updatemessage`, {
              method: "PUT",
              body: JSON.stringify({ mode: "moveToSpam", messageId: [messageId] }),
            });
            return { ok: true, messageId };
          } catch (e) {
            console.warn("zohoApi.report failed:", e?.message);
            return { ok: false, error: e?.message || "unknown" };
          }
        },

        async markJunkSelected() {
          // Drive Thunderbird's own junk machinery (folder move, server junk
          // keyword, adaptive filter training) instead of reimplementing it.
          let lastErr = "no mail:3pane window found";
          for (const win of Services.wm.getEnumerator("mail:3pane")) {
            try {
              const view = win.GetDBView ? win.GetDBView() : null;
              const hdrs = win.GetSelectedMsgHdrs ? win.GetSelectedMsgHdrs() : null;
              if (view && hdrs?.length) {
                view.markMessages(hdrs, Ci.nsMsgViewCommandType.junk);
                return { ok: true, method: "dbview" };
              }
            } catch (e) {
              lastErr = e?.message || lastErr;
            }
            try {
              if (typeof win.goDoCommand === "function") {
                win.goDoCommand("cmdMarkJunk");
                return { ok: true, method: "cmdMarkJunk" };
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
