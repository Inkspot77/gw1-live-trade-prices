/**
 * HTTP Basic Auth — the minimum viable gate for exposing this dashboard
 * beyond a trusted LAN.
 *
 * Basic Auth sends credentials base64-encoded on every request: trivially
 * decodable, not encrypted. It stops a stranger who finds the port from using
 * the dashboard; it does NOT protect the credentials from anyone who can see
 * the raw traffic. Pairing it with TLS (a reverse proxy such as Caddy, which
 * provisions HTTPS automatically, or an SSH/WireGuard tunnel) is what actually
 * protects the credentials in transit — see deploy/DEPLOY.md.
 */

import { timingSafeEqual, createHash } from 'node:crypto';

const REALM = 'EctoWatch';

/**
 * Hashing first means the timing-safe compare always runs on fixed-length
 * (32-byte) buffers regardless of the input length, so a longer or shorter
 * guess never leaks anything through comparison time.
 */
function hash(value) {
  return createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  return timingSafeEqual(hash(a), hash(b));
}

/**
 * @param {{user: string, pass: string} | null} credentials  null disables auth
 */
export function createAuthGate(credentials) {
  if (!credentials) {
    return { enabled: false, check: () => true, demandAuth: () => {} };
  }
  const { user, pass } = credentials;

  return {
    enabled: true,

    /** @returns {boolean} true if the request's credentials are correct */
    check(req) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Basic ')) return false;

      let decoded;
      try {
        decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      } catch {
        return false;
      }
      const sep = decoded.indexOf(':');
      if (sep === -1) return false;

      // Both checks always run — short-circuiting on a wrong username would
      // leak, via response timing, whether the username alone was correct.
      const userOk = safeEqual(decoded.slice(0, sep), user);
      const passOk = safeEqual(decoded.slice(sep + 1), pass);
      return userOk && passOk;
    },

    /** Sends the 401 that makes a browser pop its native credential prompt. */
    demandAuth(res) {
      res.writeHead(401, {
        'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'authentication required' }));
    },
  };
}
