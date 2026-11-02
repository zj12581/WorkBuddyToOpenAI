/**
 * Credential handling: locate the desktop client's auth file, keep the access
 * token fresh, and expose the upstream request headers.
 *
 * The auth file is the desktop client's own session store. It is read-only
 * except when the token is refreshed, at which point it is rewritten atomically
 * (same behaviour as the client itself), so the two never disagree about the
 * current session.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const UPSTREAM_DEFAULT = 'https://copilot.tencent.com';

/** Candidate auth directories, in priority order, across platforms. */
function authDirCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    // Windows
    path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    path.join(appdata, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    // macOS
    path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    // Linux
    path.join(os.homedir(), '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    // Fallbacks seen in some installs
    path.join(os.homedir(), '.codebuddy', 'auth'),
  ];
}

function authFileCandidates(extra) {
  const list = [];
  if (extra) list.push(extra);
  if (process.env.WORKBUDDY_AUTH_FILE) list.push(process.env.WORKBUDDY_AUTH_FILE);
  for (const d of authDirCandidates()) {
    try {
      for (const f of fs.readdirSync(d)) if (f.endsWith('.info')) list.push(path.join(d, f));
    } catch { /* directory absent */ }
  }
  return list;
}

function resolveAuthFile(extra) {
  const cands = authFileCandidates(extra);
  const picked = cands.find(p => /workbuddy/i.test(path.basename(p))) || cands[0];
  if (!picked) {
    throw new Error('no WorkBuddy/CodeBuddy auth file found - sign in with the desktop client first, '
      + 'or set WORKBUDDY_AUTH_FILE / authFile in the config');
  }
  return picked;
}

function buildHeaders(auth, account, userAgent) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + (auth.accessToken || ''),
    'X-User-Id': String(account.uid || ''),
    'X-Domain': auth.domain || 'www.workbuddy.cn',
    'X-Product': 'SaaS',
    'User-Agent': userAgent || 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1',
  };
  if (account.enterpriseId) {
    h['X-Enterprise-Id'] = String(account.enterpriseId);
    h['X-Tenant-Id'] = String(account.enterpriseId);
  }
  return h;
}

/**
 * Holds the current session. Re-reads the auth file when it changes on disk (the
 * desktop client may refresh it behind our back) and refreshes the token itself
 * when it is about to expire.
 */
class Credential {
  /**
   * @param options {
   *   authFile?: string,   explicit auth file path
   *   upstream?: string,   upstream base URL
   *   userAgent?: string,
   *   exposeIdentity?: boolean,
   *   onLog?: (msg: string) => void
   * }
   */
  constructor(options) {
    const opts = options || {};
    this.upstream = opts.upstream || UPSTREAM_DEFAULT;
    this.userAgent = opts.userAgent || 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1';
    this.exposeIdentity = !!opts.exposeIdentity;
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
    this.file = resolveAuthFile(opts.authFile);
    this._cache = null;
    this._mtime = 0;
    this._refreshing = null;
  }

  read() {
    let st;
    try { st = fs.statSync(this.file); }
    catch (e) { throw new Error('auth file unreadable: ' + e.message); }
    if (!this._cache || st.mtimeMs !== this._mtime) {
      this._cache = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._mtime = st.mtimeMs;
    }
    return this._cache;
  }

  auth() { return this.read().auth || {}; }
  account() { return this.read().account || {}; }

  /** True when the access token is expired or within 60s of expiring. */
  expired() {
    const exp = Number(this.auth().expiresAt || 0);
    return exp ? Date.now() >= exp - 60_000 : false;
  }

  headers() {
    return buildHeaders(this.auth(), this.account(), this.userAgent);
  }

  /** Refresh the access token and write the result back atomically. */
  async refresh() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const store = this.read();
      const auth = store.auth || {};
      const headers = this.headers();
      headers['X-Refresh-Token'] = auth.refreshToken || '';
      headers['X-Auth-Refresh-Source'] = 'plugin';

      const res = await fetch(this.upstream + '/v2/plugin/auth/token/refresh', {
        method: 'POST', headers, body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (data.code !== 0 || !data.data) {
        throw new Error('token refresh failed: ' + JSON.stringify(data).slice(0, 300));
      }
      const fresh = data.data;
      fresh.domain = fresh.domain || auth.domain;
      const now = Date.now();
      if (!fresh.expiresAt && fresh.expiresIn) fresh.expiresAt = now + fresh.expiresIn * 1000;
      if (!fresh.refreshExpiresAt && fresh.refreshExpiresIn) fresh.refreshExpiresAt = now + fresh.refreshExpiresIn * 1000;
      store.auth = fresh;

      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this._cache = store;
      this._mtime = fs.statSync(this.file).mtimeMs;
      this.onLog('token refreshed, new expiry ' + new Date(Number(fresh.expiresAt || 0)).toISOString());
      return fresh;
    })().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  /** Refresh if needed, then return the headers to use for one request. */
  async ensureFresh() {
    if (this.expired()) {
      try { await this.refresh(); }
      catch (e) { this.onLog('refresh failed, continuing with the existing token: ' + e.message); }
    }
    return this.headers();
  }

  /** Non-sensitive session summary. Identity fields are opt-in. */
  summary() {
    const account = this.account();
    const auth = this.auth();
    const out = {
      file: this.file,
      domain: auth.domain || null,
      token_expires_at: auth.expiresAt ? new Date(Number(auth.expiresAt)).toISOString() : null,
      token_expired: this.expired(),
    };
    if (this.exposeIdentity) {
      out.nickname = account.nickname || null;
      out.uid = account.uid || null;
    } else {
      out.identity = 'redacted';
    }
    return out;
  }
}

module.exports = {
  Credential,
  resolveAuthFile,
  authFileCandidates,
  authDirCandidates,
  buildHeaders,
  UPSTREAM_DEFAULT,
};
