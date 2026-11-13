/**
 * Client-version half of Codex model entitlements: which client version an entitlement question
 * is asked for, the gated-model floor, and the memoized persisted-runtime read. Split out of
 * `model-entitlements.ts` (OPS-2117) so that file stays under the size limit; that module
 * re-exports every public name here, so importers are unchanged.
 */
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "./catalog/native-models";
import { pinnedNativeModelRows } from "./catalog/pinned-models";
import { codexRuntimeStateEpoch, loadPersistedCodexRuntime } from "./runtime";

/** A version string upstream can filter on. Rejects empty and the `0.0.0` placeholder. */
export function isUsableCodexClientVersion(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0.0.0") return false;
  // Bounded: the value reaches an outbound URL, and no real client version is this long.
  if (trimmed.length > 64) return false;
  if (!/^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return false;
  // An all-zero numeric core is the same claim `0.0.0` makes — a client predating every gated
  // model — so `0`, `0.0`, `00.0.0`, and `0.0.0-dev` must fail for the same reason, by value
  // rather than by exact string.
  const core = trimmed.split(/[-+]/, 1)[0]!;
  if (core.split(".").every(segment => Number(segment) === 0)) return false;
  return true;
}

/**
 * Highest `minimal_client_version` this build's bundled roster records for the models that
 * are account-gated. Derived, not hardcoded: if the snapshot is refreshed with a model that
 * requires a newer client, the floor follows it, so the two can never drift apart.
 *
 * Used only as the last tier of version precedence, for background work that has no request
 * and no resolved runtime to speak for. It answers "what does this build believe the gated
 * models need?", which is a claim the repository can actually substantiate.
 */
export function deriveGatedClientVersionFloor(
  rows: ReadonlyArray<Record<string, unknown>>,
  gatedSlugs: ReadonlySet<string> = ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
): string | null {
  const floors = rows
    .filter(row => typeof row.slug === "string" && gatedSlugs.has(row.slug))
    .map(row => (typeof row.minimal_client_version === "string" ? row.minimal_client_version : null))
    .filter((value): value is string => isUsableCodexClientVersion(value));
  return floors.reduce<string | null>(
    (best, candidate) => (best === null || compareClientVersions(candidate, best) > 0 ? candidate : best),
    null,
  );
}

/**
 * Lowest `client_version` MEASURED to actually return the account-gated rows.
 *
 * The bundled snapshot was not sufficient on its own. Until the 2026-09-23 re-pin it recorded
 * `0.142.2` for the gpt-5.6 rows (upstream now records `0.144.0`), and `0.142.2` is a version
 * upstream answers with 200 and five models, none of them gpt-5.6; `0.144.0` and above answer
 * with the gated rows present
 * (devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md, independently
 * reproduced by the #2886 and #3022 reporters). So a floor derived from the snapshot alone
 * asks a question whose honest answer is an empty gated set — and the fail-closed gate then
 * reads that absence as a confirmed denial, which is how 2.36.0 removed sol/terra/luna from
 * accounts that own them (#3022).
 *
 * This is a measurement, not a preference, which is why it composes with the derivation
 * instead of replacing it: see `composeGatedClientVersionFloor`.
 */
const MEASURED_GATED_CLIENT_VERSION_MINIMUM = "0.144.0";

/**
 * Lowest versions measured to return each account-gated model when the account owns it.
 *
 * This is deliberately independent of the bundled upstream snapshot, which can lag or lead the
 * live roster: live measurements show that upstream omits sol/terra/luna below 0.144.0.
 * Daybreak's shipped row records 0.142.2 and has no independent measured minimum, so its omission remains
 * authoritative instead of inheriting a guessed floor from another model.
 */
export const ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS: ReadonlyMap<string, string> = new Map([
  ["gpt-5.6-sol", MEASURED_GATED_CLIENT_VERSION_MINIMUM],
  ["gpt-5.6-terra", MEASURED_GATED_CLIENT_VERSION_MINIMUM],
  ["gpt-5.6-luna", MEASURED_GATED_CLIENT_VERSION_MINIMUM],
]);

/**
 * Fallback when the snapshot records no usable gated floor.
 *
 * Not every gated slug is guaranteed a `minimal_client_version` — `gpt-daybreak-blue-latest` had
 * no row until the 2026-09-23 re-pin — so the derivation can legitimately come back empty as the
 * gated set changes. This is the last resort behind it, and it is still a version upstream can
 * filter on rather than the placeholder that caused #2886.
 */
const GATED_MODEL_CLIENT_VERSION_FLOOR_FALLBACK = "0.142.2";

/**
 * The floor actually used: the highest of what the snapshot derives, what we have measured
 * upstream to honour, and the fallback.
 *
 * Composed rather than hardcoded so the two sources cannot drift into a contradiction. The
 * snapshot may raise the floor; it may never lower it below a measurement. When a future
 * snapshot refresh records `0.144.0` or higher, the derivation takes over naturally and
 * `MEASURED_GATED_CLIENT_VERSION_MINIMUM` goes inert instead of fighting it.
 */
function composeGatedClientVersionFloor(
  rows: ReadonlyArray<Record<string, unknown>>,
  gatedSlugs: ReadonlySet<string> = ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
): string {
  const derived = deriveGatedClientVersionFloor(rows, gatedSlugs) ?? GATED_MODEL_CLIENT_VERSION_FLOOR_FALLBACK;
  return compareClientVersions(derived, MEASURED_GATED_CLIENT_VERSION_MINIMUM) >= 0
    ? derived
    : MEASURED_GATED_CLIENT_VERSION_MINIMUM;
}

// Reads every pinned row (codex-rs snapshot plus roster-captured rows), so a gated slug whose row
// arrives through roster-pinned-models.json still contributes its floor. None does today:
// GPT-6 Sol/Luna and GPT-6.1 Sol/Terra are ungated; Astra Minor has no row or measured minimum.
export const GATED_MODEL_CLIENT_VERSION_FLOOR: string = composeGatedClientVersionFloor(
  pinnedNativeModelRows(),
);

/** Test-only seam: the composition on synthetic rows, so both directions can be proven. */
export function composeGatedClientVersionFloorForTests(
  rows: ReadonlyArray<Record<string, unknown>>,
  gatedSlugs?: ReadonlySet<string>,
): string {
  return composeGatedClientVersionFloor(rows, gatedSlugs);
}

/** Test-only seam: the ordering the floor composition relies on. */
export function compareClientVersionsForTests(left: string, right: string): number {
  return compareClientVersions(left, right);
}

/** Numeric-segment comparison. Only used to pick the highest floor in a known-good set. */
// Prerelease and build suffixes are deliberately NOT ordered. Splitting on [.+-] turns the
// suffix into a non-finite segment that reads as 0, so `0.144.0-rc.1` sorts at or above
// `0.144.0` rather than below it, the inverse of semver. That is tolerable because every
// version this ranks against is a release version: the gated floor, the measured minimum, and
// the snapshot's `minimal_client_version` rows. A prerelease runtime is therefore passed
// through exactly as it was before the floor bound tier 2, so this is not a new hazard. Order
// the suffix properly before reusing this anywhere a prerelease has to sort below its release.
export function compareClientVersions(left: string, right: string): number {
  const l = left.split(/[.+-]/).map(Number);
  const r = right.split(/[.+-]/).map(Number);
  for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
    const a = Number.isFinite(l[i]) ? l[i]! : 0;
    const b = Number.isFinite(r[i]) ? r[i]! : 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/**
 * Version authority, in precedence order:
 *
 * 1. the inbound request's own `client_version` — the only value certainly describing the
 *    client being answered;
* 2. the selected Codex runtime version, for callers with no request of their own — but never
 *    below `GATED_MODEL_CLIENT_VERSION_FLOOR`. Retained sync refreshes runtime evidence before
 *    discovery, which is what makes this usable here; the persisted file itself carries no
 *    freshness guarantee.
 * 3. the floor this build's own bundled roster records for the models being gated
 *    (`GATED_MODEL_CLIENT_VERSION_FLOOR`).
 *
 * Tier 3 exists because background catalog sync has no request and, on a host where Codex
 * has never been resolved, no persisted runtime either — yet it is exactly the path that
 * publishes account-confirmed native rows. Skipping discovery there suppressed the rows this
 * fix is meant to restore. The floor is not invented: it is the version this build's own
 * snapshot states the gated models require, so asking under it is the narrowest question
 * that can still return them.
 *
 * The floor binds tier 2 as well, and that is the whole of #3436. #3022 gave tier 3 the
 * measured minimum but left tier 2 to speak for itself, so a host whose persisted runtime was
 * REAL but OLD — 0.141.0 against a measured 0.144.0 — asked upstream under a version upstream
 * filters on, got an honest roster with no gpt-5.6, and lost sol/terra/luna everywhere. That
 * made an outdated CLI strictly worse than no CLI at all, since the runtime-less host already
 * asked at the floor and kept its models. The clamp only ever raises: a runtime at or above
 * the floor is preserved exactly, because a newer client can drive models the floor cannot
 * name.
 *
 * Which tier answers is a question about WHICH QUESTION IS BEING ASKED, not about background
 * versus request path — `isDirectCallerEntitledToCodexModel` and both authorization paths in
 * `auth-context.ts` are inbound requests that reach tier 2 because they carry no version:
 *
 * - No inbound version: the caller is asking whether the ACCOUNT owns the model. Upstream
 *   only incidentally filters that answer by version, so ask at no less than the floor.
 * - An inbound version: the caller is asking what THAT CLIENT may use. Answer verbatim, even
 *   when it is older than the floor. Clamping there would advertise rows the client told us
 *   it cannot drive (#2548) and would turn an honest `unknown` into a cached `denied`.
 *
 * There is deliberately no `0.0.0`-style fallback. A placeholder describes a client that
 * predates every gated model, which is what made upstream answer with an empty roster and
 * turned absent evidence into a manufactured confirmed negative (#2886).
 */
export function resolveCodexEntitlementClientVersion(
  inbound?: string | null,
  loadRuntime: () => { selectedVersion?: string | null } | null = loadPersistedCodexRuntime,
  options: { readonly bypassRuntimeMemo?: boolean; readonly now?: number } = {},
): string {
  if (isUsableCodexClientVersion(inbound)) return inbound.trim();
  // The memo describes the real runtime file, so a caller supplying a different loader is asking
  // a different question and must not be answered from it. Detected rather than left to the
  // caller, because forgetting the flag would silently cross-answer.
  const bypass = options.bypassRuntimeMemo === true || loadRuntime !== loadPersistedCodexRuntime;
  const selected = bypass
    ? readRuntimeVersion(loadRuntime)
    : memoizedPersistedRuntimeVersion(loadRuntime, options.now ?? Date.now());
  return raisedToGatedFloor(selected);
}

/**
 * The gated floor as a lower bound rather than a fallback.
 *
 * Applied only on the way out of the resolver. `readRuntimeVersion` and
 * `memoizedPersistedRuntimeVersion` keep reporting what is actually on disk, because
 * `selectedVersion` is probe evidence that runtime identity, catalog cache keys,
 * `X-Codex-Version` and install provenance all read for their own reasons. Clamping the
 * persisted value itself would corrupt every one of them to fix one question.
 */
function raisedToGatedFloor(selected: string | null): string {
  if (selected === null) return GATED_MODEL_CLIENT_VERSION_FLOOR;
  return compareClientVersions(selected, GATED_MODEL_CLIENT_VERSION_FLOOR) >= 0
    ? selected
    : GATED_MODEL_CLIENT_VERSION_FLOOR;
}


/**
 * How long a persisted-runtime version read is reused.
 *
 * Tier 2 of the version chain reads `codex-runtime.json` from disk, and it is consulted on
 * every gated Direct authorization and every `/v1/models` resolution — including when the
 * five-minute roster cache is hot, so the entitlement answer needs no I/O at all. Left
 * unmemoized that is a synchronous `readFileSync` on the request path under concurrent gated
 * traffic. `persistCodexRuntime` is the only writer, and it clears the runtime's own resolve
 * cache; this window is short enough that a runtime switch is picked up promptly either way.
 */
const RUNTIME_VERSION_MEMO_MS = 5_000;

let runtimeVersionMemo: { at: number; epoch: number; version: string | null } | null = null;

function readRuntimeVersion(
  loadRuntime: () => { selectedVersion?: string | null } | null,
): string | null {
  try {
    const value = loadRuntime()?.selectedVersion;
    return isUsableCodexClientVersion(value) ? value.trim() : null;
  } catch {
    // An unreadable or malformed runtime file is an absent version, not a failure worth
    // propagating into entitlement resolution.
    return null;
  }
}

export function memoizedPersistedRuntimeVersion(
  loadRuntime: () => { selectedVersion?: string | null } | null,
  now: number,
): string | null {
  const epoch = codexRuntimeStateEpoch();
  // Time bounds staleness; the epoch makes a runtime switch invalidate this immediately, so the
  // window can never answer under the version that was just replaced.
  if (
    runtimeVersionMemo
    && runtimeVersionMemo.epoch === epoch
    && now - runtimeVersionMemo.at < RUNTIME_VERSION_MEMO_MS
  ) {
    return runtimeVersionMemo.version;
  }
  const selected = readRuntimeVersion(loadRuntime);
  runtimeVersionMemo = { at: now, epoch, version: selected };
  return selected;
}

export function resetRuntimeVersionMemoForTests(): void {
  runtimeVersionMemo = null;
}
