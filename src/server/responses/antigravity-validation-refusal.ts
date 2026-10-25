import { ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX } from "../../adapters/google-errors";
import { readBoundedResponseBody } from "../../lib/bounded-body";

/** Inspect only the Google adapter's normalized, already bounded 403 response. */
export async function isAntigravityValidationRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status !== 403 || signal?.aborted) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), {
      maxBytes: 1024,
      totalTimeoutMs: 1000,
      firstByteTimeoutMs: 1000,
      inactivityTimeoutMs: 1000,
      signal,
    });
    return !signal?.aborted && body.displaySafe && !body.truncated && !body.timedOut && !body.oversized
      && body.text.startsWith(`${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}: `);
  } catch {
    return false;
  }
}

/** Google's NOT_FOUND text for a model the signed-in account is not entitled to. */
const ANTIGRAVITY_ENTITLEMENT_MISS_TEXT = "Requested entity was not found";

/**
 * Google gates some Antigravity models per account: a Workspace account answers 404 NOT_FOUND
 * for a model a consumer sibling serves (observed 10/17 and 10/21 on gemini-4-argon-*). The
 * same text also answers a model id no account serves, so callers may spend exactly one
 * sibling try on it, never a roster walk.
 */
export async function isAntigravityEntitlementMiss(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status !== 404 || signal?.aborted) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), {
      maxBytes: 1024,
      totalTimeoutMs: 1000,
      firstByteTimeoutMs: 1000,
      inactivityTimeoutMs: 1000,
      signal,
    });
    return !signal?.aborted && body.displaySafe && !body.truncated && !body.timedOut && !body.oversized
      && body.text.startsWith("Antigravity invalid request: ")
      && body.text.includes(ANTIGRAVITY_ENTITLEMENT_MISS_TEXT);
  } catch {
    return false;
  }
}
