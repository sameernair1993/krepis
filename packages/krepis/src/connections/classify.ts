/** Error classification by shape, so it works across driver copies and majors (no `instanceof`). */

interface ErrorShape {
  name?: unknown;
  code?: unknown;
  codeName?: unknown;
  errorLabels?: unknown;
  hasErrorLabel?: unknown;
}

const AUTH_FAILED = 18;

export function hasLabel(error: unknown, label: string): boolean {
  const e = error as ErrorShape | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.hasErrorLabel === 'function') return Boolean((e.hasErrorLabel as (l: string) => boolean).call(e, label));
  return Array.isArray(e.errorLabels) && e.errorLabels.includes(label);
}

/** A login rejected by the server: wrong or rotated credentials, or a removed user (SCRAM reports both as 18). */
export function isAuthFailure(error: unknown): boolean {
  const e = error as ErrorShape | null;
  if (!e || typeof e !== 'object') return false;
  return e.code === AUTH_FAILED || e.codeName === 'AuthenticationFailed';
}

/** A network-level failure (refused, reset, timed out), as opposed to a server reply. */
export function isNetworkError(error: unknown): boolean {
  const e = error as ErrorShape | null;
  return !!e && typeof e === 'object' && typeof e.name === 'string' && e.name.startsWith('MongoNetwork');
}

export function errorCode(error: unknown): number | null {
  const code = (error as ErrorShape | null)?.code;
  return typeof code === 'number' ? code : null;
}

export function errorCodeName(error: unknown): string | null {
  const e = error as ErrorShape | null;
  if (typeof e?.codeName === 'string') return e.codeName;
  return typeof e?.name === 'string' ? e.name : null;
}
