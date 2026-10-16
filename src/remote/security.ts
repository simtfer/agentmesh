/**
 * Security primitives for the remote Worker Daemon and its clients.
 *
 * Threat model (PLAN §7): the daemon can start real coding agents that run
 * tools on the host, so an unauthenticated caller is equivalent to remote code
 * execution. We therefore require a bearer token on every connection, confine
 * task working directories to an explicit whitelist, and refuse to listen on a
 * non-loopback interface without TLS unless the operator explicitly opts in.
 *
 * Secrets are read from environment variables only. Config files reference the
 * env var NAME (e.g. `tokenEnv: AGENTMESH_DAEMON_TOKEN`), never the value, so
 * nothing sensitive lands in the config or in version control.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export class SecurityError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SecurityError";
  }
}

/** Read a bearer token from the named environment variable. */
export function resolveToken(tokenEnv: string | undefined): string | undefined {
  if (!tokenEnv) return undefined;
  const v = process.env[tokenEnv];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Resolve the full set of currently-valid bearer tokens for credential
 * rotation. `tokenEnv` may name several environment variables (comma-separated),
 * and each variable's value may itself hold several tokens (comma-separated), so
 * an operator can add a new secret alongside the old one, migrate clients, then
 * drop the old var — all without downtime.
 *
 * Only env var NAMES live in config; secret VALUES stay in the environment and
 * never in the config file or version control. Results are trimmed, de-duplicated
 * (first wins) and empties dropped.
 */
export function resolveTokens(tokenEnv: string | undefined): string[] {
  if (!tokenEnv) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of tokenEnv.split(",")) {
    const key = name.trim();
    if (!key) continue;
    const raw = process.env[key];
    if (!raw) continue;
    for (const tok of raw.split(",")) {
      const value = tok.trim();
      if (value && !seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
  }
  return out;
}

/**
 * Constant-time token comparison to avoid leaking the token via timing.
 * Returns false (never throws) on any mismatch or malformed input.
 */
export function tokensEqual(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Constant-time membership test against a set of accepted tokens (rotation).
 * Every candidate is compared (no early return) so the result does not leak
 * which token matched or how many are configured via short-circuit timing.
 */
export function anyTokenEqual(provided: string | undefined, expected: string[]): boolean {
  if (!provided || expected.length === 0) return false;
  let matched = false;
  for (const tok of expected) {
    if (tokensEqual(provided, tok)) matched = true;
  }
  return matched;
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : undefined;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True if a bind host / URL host only reaches the local machine. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true; // default bind treated as loopback-only by callers
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(h)) return true;
  return h.startsWith("127."); // whole 127.0.0.0/8 block is loopback
}

/** True if a daemon endpoint URL targets loopback. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Confine a requested working directory to an explicit whitelist.
 * Both sides are resolved+normalized so `..` segments and trailing separators
 * cannot escape the allowed roots. Comparison is by path segment prefix so
 * `/data/foo` is not accepted for root `/data/foobar`.
 */
export function assertCwdAllowed(cwd: string, allowCwd: string[] | undefined): string {
  const resolved = path.resolve(cwd);
  if (!allowCwd || allowCwd.length === 0) {
    throw new SecurityError(
      "daemon has no workdir whitelist (daemon.allowCwd); refusing remote task",
      "cwd_not_whitelisted",
    );
  }
  for (const root of allowCwd) {
    const r = path.resolve(root);
    if (resolved === r || resolved.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) {
      return resolved;
    }
  }
  throw new SecurityError(
    `working directory not in whitelist: ${resolved}`,
    "cwd_not_whitelisted",
  );
}

export interface TlsMaterial {
  cert: string;
  key: string;
  ca?: string;
}

/**
 * Load TLS cert/key (and optional CA) from file paths or inline PEM strings.
 * Returns undefined when no cert+key are configured (plain HTTP).
 */
export function loadTls(tls?: {
  cert?: string;
  key?: string;
  ca?: string;
}): TlsMaterial | undefined {
  if (!tls?.cert || !tls?.key) return undefined;
  const read = (v: string): string =>
    v.includes("-----BEGIN") ? v : existsSync(v) ? readFileSync(v, "utf8") : v;
  const cert = read(tls.cert);
  const key = read(tls.key);
  if (!cert.includes("-----BEGIN") || !key.includes("-----BEGIN")) {
    throw new SecurityError("TLS cert/key could not be read (missing file or PEM)", "tls_invalid");
  }
  return { cert, key, ...(tls.ca ? { ca: read(tls.ca) } : {}) };
}

/**
 * Fail-safe guard for daemon startup. Listening on a reachable interface
 * without TLS would expose the token (and agent control) in cleartext, so we
 * refuse unless the operator explicitly passes allowInsecure.
 */
export function assertSafeBind(host: string, hasTls: boolean, allowInsecure: boolean): void {
  if (hasTls) return;
  if (isLoopbackHost(host)) return;
  if (allowInsecure) return;
  throw new SecurityError(
    `refusing to bind non-loopback host "${host}" without TLS; ` +
      `configure daemon.tls (cert/key) or pass --allow-insecure to override`,
    "insecure_bind",
  );
}
