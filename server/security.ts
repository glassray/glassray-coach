import { createHash, timingSafeEqual } from 'node:crypto';

/** Hostnames that count as loopback for the Host/Origin guard (DNS-rebinding defense). */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when an HTTP Host header (with any port) points at a loopback name. */
export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
};

/** True when an Origin header value is an http(s) loopback origin. */
export const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTNAMES.has(url.hostname)
    );
  } catch {
    return false;
  }
};

/** Constant-time bearer-key comparison — hashes both sides first so differing lengths never short-circuit. */
export const timingSafeKeyEquals = (presented: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(expected).digest(),
  );

/** Extracts the token from a `Bearer <token>` Authorization header, or null. */
export const bearerToken = (authorization: string | undefined): string | null => {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  return match?.[1] ?? null;
};
