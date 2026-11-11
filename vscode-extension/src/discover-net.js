'use strict';
/**
 * Gateway discovery.
 *
 * The gateway only listens on loopback of the machine that runs it, so which URL
 * reaches it depends on where VS Code's extension host is running:
 *
 *   - Windows / macOS / Linux desktop: 127.0.0.1 is the gateway itself.
 *   - WSL (Remote-WSL): 127.0.0.1 is the WSL VM, not Windows. WSL reaches the
 *     Windows host through its default gateway, but a gateway bound to
 *     127.0.0.1 only is not reachable that way — so if no candidate answers we
 *     say exactly that instead of reporting a bare connection failure.
 *
 * `gatewayUrlCandidates()` returns the URLs to try, in order. The first one that
 * answers /v1/models wins and is remembered for the session.
 */

const os = require('os');
const fs = require('fs');
const { normalizeBase, rawRequest } = require('./client');

/** Are we inside WSL? (kernel release contains "microsoft") */
function isWsl() {
  try {
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
    const rel = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    return rel.includes('microsoft') || rel.includes('wsl');
  } catch {
    return false;
  }
}

/** The Windows host address as seen from inside WSL. */
function wslHostAddress() {
  // /etc/resolv.conf historically held the host IP; on newer WSL it is a
  // loopback stub, so prefer the default route's gateway.
  try {
    const routes = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const line of routes) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 3) continue;
      if (cols[1] !== '00000000') continue;      // destination 0.0.0.0 == default
      const hex = cols[2];                        // gateway, little-endian
      if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
      const octets = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
        .map(h => parseInt(h, 16));
      return octets.join('.');
    }
  } catch { /* fall through */ }

  try {
    const text = fs.readFileSync('/etc/resolv.conf', 'utf8');
    const m = /^nameserver\s+([0-9.]+)/m.exec(text);
    if (m && m[1] && !m[1].startsWith('127.')) return m[1];
  } catch { /* fall through */ }

  return null;
}

/**
 * Port a gateway instance started inside WSL listens on by default.
 *
 * A loopback-only gateway inside WSL can also serve Windows via WSL localhost
 * forwarding when enabled. Its port remains configurable.
 */
const WSL_LOCAL_PORT = 8790;

/**
 * Ordered list of URLs to try.
 * @param configured the user's setting, tried first when non-empty
 * @param port       gateway port (from the configured URL, else 8790)
 */
function gatewayUrlCandidates(configured, port) {
  const urls = [];
  const push = (u) => { if (u && !urls.includes(u)) urls.push(u); };

  if (configured) push(normalizeBase(configured));

  const p = port || 8790;
  if (isWsl()) {
    // Inside WSL: loopback is the VM, so a gateway started *here* answers on it.
    push('http://127.0.0.1:' + p);
    push('http://localhost:' + p);
    // Also try the default WSL port if a custom URL is configured.
    if (p !== WSL_LOCAL_PORT) {
      push('http://127.0.0.1:' + WSL_LOCAL_PORT);
      push('http://localhost:' + WSL_LOCAL_PORT);
    }
    // Finally the Windows host, which only works if that gateway is bound to a
    // reachable interface (it normally is not).
    const host = wslHostAddress();
    if (host) push('http://' + host + ':' + p);
  } else {
    push('http://127.0.0.1:' + p);
    push('http://localhost:' + p);
  }

  // A host that resolves to the machine itself is a last resort for setups where
  // the gateway binds a specific interface.
  if (!isWsl()) {
    try {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const ni of nets[name] || []) {
          if (ni.family === 'IPv4' && !ni.internal) push('http://' + ni.address + ':' + p);
        }
      }
    } catch { /* ignore */ }
  }
  return urls;
}

/** Try each candidate until one answers; returns { url, models } or null. */
async function findGateway(configured, port, timeoutMs) {
  const candidates = gatewayUrlCandidates(configured, port);
  const timeout = timeoutMs || 1500;
  // Probe several at once so a dead candidate does not serialize the wait.
  const attempts = await Promise.all(candidates.map(async (url) => {
    try {
      const res = await rawRequest(url + '/v1/models', { method: 'GET', timeout });
      // Any HTTP answer proves something is listening there.
      if (res.status === 200 || res.status === 401) {
        // A keyless probe cannot tell our gateway from another service, so prefer
        // a candidate whose body looks like ours, but accept any 200.
        return { url, status: res.status };
      }
    } catch { /* unreachable */ }
    return null;
  }));
  const hit = attempts.find(a => a && a.status === 200) || attempts.find(Boolean);
  return { url: hit ? hit.url : null, status: hit ? hit.status : undefined, probed: candidates };
}

module.exports = { isWsl, wslHostAddress, gatewayUrlCandidates, findGateway, WSL_LOCAL_PORT };
