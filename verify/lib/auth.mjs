/**
 * DSH Web browser-session auth helper.
 *
 * The GUI at http://127.0.0.1:3080 is protected by `dsh-client-connection`
 * browser auth. Two independent ways in:
 *
 *   1. Token URL  : http://127.0.0.1:3080/?token=<launchToken>
 *      -> 303 redirect to `./` + Set-Cookie. The launch token is generated
 *         per *process* (in-memory WeakMap), so it dies with every restart
 *         of `dsh web` and any token copied from an earlier session is stale
 *         (server answers 401 "dsh web authentication required").
 *
 *   2. Durable signed cookie: the server keeps a 32-byte secret in the
 *      credentials record `client-connection/browser-session`
 *      (file: $DSH_HOME/.credentials.yaml). It accepts any request carrying
 *      a valid HMAC cookie, so we can mint one ourselves when the launch
 *      token is stale. This is what makes the acceptance script re-runnable
 *      across GUI restarts.
 *
 * Cookie format (see dsh-client-connection/lib/index.js):
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, body))
 *   payload = { version: 1, authority, issuedAt, expiresAt }
 *   authority = the Host header, e.g. "127.0.0.1:3080"
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const COOKIE_PREFIX = 'dsh-auth-';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

/** Encode a browser-session cookie value exactly like the server does. */
function encodeCookie(payload, secret) {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `v1.${body}.${sig}`;
}

/** Cookie name is a hash of the request authority (Host header). */
export function cookieName(authority) {
  return COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest());
}

/**
 * Read the durable browser-session signing secret from the DSH credentials file.
 * Supports:
 *   - a DSH_WEBAUTH_SECRET env override (base64url, 32 bytes)
 *   - a YAML "flat key: value" scan for `client-connection/browser-session`
 */
export function readSecret({ dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE ?? '', '.dsh') } = {}) {
  const fromEnv = process.env.DSH_WEBAUTH_SECRET;
  if (fromEnv && fromEnv.trim()) return { secret: fromEnv.trim(), source: 'env:DSH_WEBAUTH_SECRET' };

  const file = join(dshHome, '.credentials.yaml');
  if (!existsSync(file)) throw new Error(`credentials file not found: ${file}`);
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  let inRecord = false;
  for (const line of lines) {
    if (/^\s{0,4}client-connection\/browser-session:\s*$/.test(line)) { inRecord = true; continue; }
    if (inRecord) {
      // Record ends at the next top-level key.
      if (/^\S/.test(line) && line.trim() !== '') break;
      const m = /^\s+secret:\s*(\S+)\s*$/.exec(line);
      if (m) return { secret: m[1], source: `${file} (client-connection/browser-session)` };
    }
  }
  throw new Error(`no browser-session secret found in ${file}`);
}

/**
 * Mint a valid browser-session cookie for `authority` (e.g. "127.0.0.1:3080").
 * @returns {{name: string, value: string, cookie: object, source: string}}
 */
export function mintSessionCookie(authority, { maxAgeDays = 1, secretInfo } = {}) {
  const info = secretInfo ?? readSecret();
  const secret = Buffer.from(info.secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (secret.byteLength !== 32) throw new Error(`secret is ${secret.byteLength} bytes, expected 32`);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + maxAgeDays * 24 * 60 * 60 * 1000;
  const payload = { version: 1, authority, issuedAt, expiresAt };
  const value = encodeCookie(payload, secret);
  const name = cookieName(authority);
  return { name, value, source: info.source, payload };
}

/** Cookie object suitable for `context.addCookies()`. */
export function playwrightCookie(authority, opts) {
  const { name, value } = mintSessionCookie(authority, opts);
  const host = authority.split(':')[0];
  return { name, value, domain: host, path: '/', httpOnly: true, sameSite: 'Strict' };
}

/** Quick unauthenticated probe: does the server currently demand auth? */
export async function probeAuth(url, { timeoutMs = 8000 } = {}) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const body = res.status === 401 ? await res.text().catch(() => '') : '';
  return {
    status: res.status,
    location: res.headers.get('location'),
    setCookie: res.headers.get('set-cookie'),
    authRequired: res.status === 401 && /authentication required/i.test(body),
  };
}
