import { createHash } from "node:crypto";
import { readBoundedResponseBody } from "../lib/bounded-body";
import type { CodexAccountCredentialRecord, OcxConfig } from "../types";
import { isSelectableCodexPoolAccount } from "./account-id";
import {
  beginCodexAccountGenerationLiveCheck,
  getValidCodexToken,
  loadCodexAccountRecordSnapshot,
} from "./account-store";
import {
  getMainAccountToken,
  getValidMainAccountToken,
  MAIN_CODEX_ACCOUNT_ID,
  type NativeMainRefreshDependencies,
} from "./main-account";
import { withNativeMainCredentialAdmission } from "./native-main-admission";
import {
  ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
  NATIVE_GPT6_ASTRA_MODEL,
  SUPPORTED_NATIVE_OPENAI_SLUGS,
} from "./catalog/native-models";
import { loadPersistedCodexRuntime } from "./runtime";
import { recordDiscoveredNativeModels, validateDiscoveredNativeRows } from "./catalog/discovered-natives";
import { codexCredentialMutationEpoch } from "./credential-mutation-epoch";
import {
  compareClientVersions,
  isUsableCodexClientVersion,
  memoizedPersistedRuntimeVersion,
  resetRuntimeVersionMemoForTests,
  resolveCodexEntitlementClientVersion,
} from "./model-entitlement-client-version";
export {
  ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS,
  GATED_MODEL_CLIENT_VERSION_FLOOR,
  compareClientVersionsForTests,
  composeGatedClientVersionFloorForTests,
  deriveGatedClientVersionFloor,
  isUsableCodexClientVersion,
  resolveCodexEntitlementClientVersion,
} from "./model-entitlement-client-version";
import { ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS } from "./model-entitlement-client-version";
import {
  clearObservedCodexModelDenial,
  forgetObservedCodexModelDenialsForAccount,
  observedDeniedCodexAccountIdsForModel,
  recordObservedCodexModelDenial,
  setObservedDenialGenerationCheck,
  resetObservedCodexModelDenialsForTests,
} from "./observed-model-denials";

const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";

/**
 * Upstream filters this roster by the client version it is told, and `client_version` is a
 * required parameter — a measured `0.60.0` returns zero models where `0.142.2` returns five
 * (devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md). Asking as
 * `0.0.0` therefore describes what a prehistoric client may use, and treating that as the
 * account's entitlement hides models the account genuinely owns (#2886).
 *
 * A version must be supplied by the caller. There is deliberately no default: inventing one
 * either manufactures a confirmed negative (the defect) or advertises models the installed
 * runtime cannot drive (#2548, from the opposite side).
 */
function codexModelsUrl(clientVersion: string): string {
  return `${CODEX_MODELS_ENDPOINT}?client_version=${encodeURIComponent(clientVersion)}`;
}

const MODEL_ROSTER_TTL_MS = 5 * 60_000;
const MODEL_ROSTER_FAILURE_TTL_MS = 15_000;
const MODEL_ROSTER_NEGATIVE_CREDENTIAL_TTL_MS = 5_000;
const MODEL_ROSTER_TIMEOUT_MS = 8_000;
const MODEL_ROSTER_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_ROSTER_CACHE_MAX = 64;

/**
 * Versions retained per account.
 *
 * `client_version` arrives on the inbound `/v1/models` request, so making it part of the cache
 * key handed callers a knob on key cardinality. With a flat per-key budget, one account cycling
 * 64 versions filled its whole class and pushed other accounts' confirmed grants out — the same
 * fail-closed catalog flapping the two-class budget exists to prevent, reached by a different
 * axis. A handful of versions per account is all any real deployment needs (a client, a runtime,
 * the floor), and the budget below counts ACCOUNTS so one noisy account cannot spend another's
 * share.
 */
const MODEL_ROSTER_VERSIONS_PER_ACCOUNT_MAX = 4;

/**
 * Concurrent roster requests allowed per account.
 *
 * The cache is bounded on write, but an in-flight request is not a cache entry: distinct
 * `client_version` values miss the flight key by design, so a caller cycling versions could open
 * arbitrarily many concurrent upstream requests, each holding an eight-second timer. This bounds
 * the concurrency itself. Exceeding it is reported as unconfirmed — the same fail-closed answer a
 * discovery failure produces, and cheaper than either queueing or serving another version's
 * roster.
 */
const MODEL_ROSTER_FLIGHTS_PER_ACCOUNT_MAX = 4;

/**
 * Distinct caller-selected roster versions admitted per account in one roster window.
 *
 * The cache budget and the flight budget both bound STATE, not WORK. A caller that cycles
 * `client_version` and waits for each answer misses the cache by design and misses the flight
 * key by design, so it can renew an authenticated upstream request under EVERY stored account
 * token as often as it likes, and the gated-model checks it displaces fail closed while it does.
 *
 * DISTINCT VERSIONS are counted, never attempts. One legitimate client retrying a single version
 * through an upstream outage comes back every 15s on the failure TTL; charging each attempt would
 * spend the whole allowance on that one version and then refuse it for the rest of the 5-minute
 * window, turning a recovered upstream into several more minutes without gated models.
 */
const MODEL_ROSTER_VERSION_MISSES_PER_ACCOUNT_MAX = 4;

interface AccountVersionMissBudget {
  credentialIdentity: string;
  /** Version -> when this version stops occupying the allowance. */
  versions: Map<string, number>;
}

/**
 * One row per ACCOUNT, not per credential identity.
 *
 * A Pool access-token refresh increments the generation, so an identity-keyed map would gain a
 * permanent row per generation for the lifetime of the process: a protection against renewable
 * work would have introduced an unbounded cache. A generation change replaces the row instead,
 * which is also the right budget semantics — new credential, new allowance.
 */
const accountModelsMisses = new Map<string, AccountVersionMissBudget>();
const DIRECT_CALLER_ACCOUNT_PREFIX = "__direct_codex__:";

export interface CodexModelEntitlementCredentialSnapshot {
  readonly accountId: string;
  readonly accessToken: string;
  readonly chatgptAccountId: string;
  /** Stable local identity for rejecting a catalog commit after credential replacement. */
  readonly credentialIdentity: string;
}

export type CodexModelEntitlementProvenance =
  | { readonly kind: "parsed-empty" }
  | { readonly kind: "http-error"; readonly httpStatus: number }
  | { readonly kind: "network-error" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unparseable" };

export type CodexModelEntitlementStatus =
  | { readonly status: "unavailable" }
  | { readonly status: "fresh" }
  | { readonly status: "unconfirmed-empty" }
  | { readonly status: "failed"; readonly reason: "http-error"; readonly httpStatus: number }
  | {
      readonly status: "failed";
      readonly reason: Exclude<CodexModelEntitlementProvenance["kind"], "parsed-empty" | "http-error">;
      readonly httpStatus?: never;
    }
  | { readonly status: "expired-refresh-in-flight" };

interface CachedAccountModels {
  readonly credentialIdentity: string;
  /**
   * Client version this roster was fetched under. Upstream filters by it, so a roster is
   * only an answer for that version — an entry fetched under one must never satisfy a read
   * for another (#2886).
   */
  readonly clientVersion: string;
  readonly expiresAt: number;
  readonly models: ReadonlySet<string>;
  readonly accessProgramsByModel?: ReadonlyMap<string, CodexAvailableAccessPrograms>;
  readonly availabilityNuxByModel?: ReadonlyMap<string, { message: string }>;
  readonly confirmed: boolean;
  readonly provenance?: CodexModelEntitlementProvenance;
}

export interface CodexModelEntitlementSnapshot {
  readonly modelsByAccount: ReadonlyMap<string, ReadonlySet<string>>;
  readonly accessProgramsByAccount?: ReadonlyMap<string, ReadonlyMap<string, CodexAvailableAccessPrograms>>;
  readonly availabilityNuxByAccount?: ReadonlyMap<string, ReadonlyMap<string, { message: string }>>;
  readonly clientVersionByAccount: ReadonlyMap<string, string>;
  readonly confirmedAccountIds: ReadonlySet<string>;
  readonly credentialIdentities: ReadonlyMap<string, string>;
}

export type CodexAvailableAccessPrograms = Readonly<Record<string, readonly string[]>> | null;

export type CodexModelEntitlementState = "granted" | "denied" | "unknown";

export interface CodexModelEntitlementResolveOptions {
  readonly fetcher?: typeof fetch;
  /**
   * Client version to ask upstream about. Absent means no trustworthy version was
   * available, and discovery is skipped rather than asked under a placeholder.
   */
  readonly clientVersion?: string | null;
  /**
   * Test-only seam for the persisted-runtime half of the version precedence chain, so a case
   * can reach the no-trustworthy-version branch without depending on the host's own runtime
   * state file.
   */
  readonly loadPersistedRuntime?: () => { selectedVersion?: string | null } | null;
  readonly nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
  readonly now?: number;
  readonly signal?: AbortSignal;
  /** Test-only credential seam; production callers enumerate local main + Pool credentials. */
  readonly credentials?: readonly CodexModelEntitlementCredentialSnapshot[];
  /** Test-only seam for proving lifecycle exclusions happen before credential reads. */
  readonly credentialSnapshot?: typeof accountCredentialSnapshot;
  /** Accounts whose credentials must not be read while another lifecycle owns them. */
  readonly excludeAccountIds?: ReadonlySet<string>;
  /** Ensure-only fence; ordinary request resolvers retain their established flight identity. */
  readonly credentialMutationEpoch?: number;
  /**
   * Internal plumbing from `withNativeMainCredentialAdmission`: releases the
   * native-main lifecycle lease once the credential phase settles, before any
   * upstream roster fetch, so a profile drain never waits on network work.
   */
  readonly releaseNativeMainCredentialLease?: () => void;
}

export interface CodexEntitlementFreshnessOptions extends Pick<
  CodexModelEntitlementResolveOptions,
  | "clientVersion"
  | "credentialSnapshot"
  | "fetcher"
  | "loadPersistedRuntime"
  | "nativeMainRefreshDependencies"
  | "now"
  | "signal"
> {
  readonly waitMs?: number;
  /** Test seam for the native-main admission fence around the refresh workset. */
  readonly nativeMainCredentialAdmission?: typeof withNativeMainCredentialAdmission;
}

const accountModelsCache = new Map<string, CachedAccountModels>();
const accountModelsFlights = new Map<string, Promise<CachedAccountModels>>();

interface NegativeCredentialMemo {
  readonly credentialIdentity: string | null;
  readonly mutationEpoch: number;
  readonly expiresAt: number;
}

interface EntitlementEnsureFlight {
  readonly startedAt: number;
  readonly promise: Promise<void>;
  readonly clientVersion: string;
  readonly identityVector: ReadonlyMap<string, string | null>;
  readonly workset: readonly string[];
}

const negativeCredentialMemo = new Map<string, NegativeCredentialMemo>();
const entitlementEnsureFlights = new Map<string, EntitlementEnsureFlight>();

/**
 * Cache key. The roster is version-specific, so the version has to be part of the identity —
 * with an account-only key, two versions in flight for one account race to overwrite each
 * other, and the unversioned projection readers in `catalog/metadata.ts` then publish
 * whichever landed last.
 */
function cacheKeyFor(accountId: string, clientVersion: string): string {
  return `${accountId}\u0000${clientVersion}`;
}

/** Account component of a cache key, for eviction budgets and per-account invalidation. */
function accountIdOfCacheKey(key: string): string {
  const separator = key.indexOf("\u0000");
  return separator === -1 ? key : key.slice(0, separator);
}

/**
 * Direct-caller entries are evicted separately from main/Pool entries.
 *
 * Direct keys are per-credential (`__direct_codex__:<hash>`) and unbounded in practice, while
 * main/Pool keys are the evidence the CATALOG projects from. Sharing one LRU let 64 distinct
 * Direct callers evict `__main__` and the Pool accounts, which makes the gated row vanish from
 * the catalog until rediscovery — fail-closed flapping rather than a leak, but still a visible
 * model disappearing for a reason the operator cannot see. Two budgets keep one class of caller
 * from erasing the other's evidence.
 */
function boundedCacheSet(accountId: string, value: CachedAccountModels): void {
  const key = cacheKeyFor(accountId, value.clientVersion);
  accountModelsCache.delete(key);
  accountModelsCache.set(key, value);
  const isDirect = (candidate: string): boolean =>
    accountIdOfCacheKey(candidate).startsWith(DIRECT_CALLER_ACCOUNT_PREFIX);

  // First, bound THIS account's versions, so a caller cycling client_version evicts only its
  // own older entries and never reaches another account's evidence.
  const ownKeys = [...accountModelsCache.keys()].filter(k => accountIdOfCacheKey(k) === accountId);
  for (const stale of ownKeys.slice(0, Math.max(0, ownKeys.length - MODEL_ROSTER_VERSIONS_PER_ACCOUNT_MAX))) {
    accountModelsCache.delete(stale);
  }

  // Then bound the class by DISTINCT ACCOUNTS. Counting keys would let one account's versions
  // consume the budget; counting accounts keeps each account's share independent of how many
  // versions any other account is using.
  const evictClass = (direct: boolean): void => {
    const accountsInOrder: string[] = [];
    for (const key of accountModelsCache.keys()) {
      if (isDirect(key) !== direct) continue;
      const account = accountIdOfCacheKey(key);
      if (!accountsInOrder.includes(account)) accountsInOrder.push(account);
    }
    // Never evict the account just written, even if it is the least-recently-inserted.
    for (const victim of accountsInOrder.slice(0, Math.max(0, accountsInOrder.length - MODEL_ROSTER_CACHE_MAX))) {
      if (victim === accountId) continue;
      for (const key of [...accountModelsCache.keys()]) {
        if (accountIdOfCacheKey(key) === victim) accountModelsCache.delete(key);
      }
    }
  };
  evictClass(accountId.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX));
}

/**
 * An identity resolver scoped to one caller's pass, reading each backing store at most once.
 *
 * The identity check itself is unchanged -- same prefix rule, same tombstone and missing-credential
 * rejection, same `pool:<generation>:<chatgptAccountId>` shape -- but the READ is hoisted. Per-id
 * resolution reloads and reparses the whole `codex-accounts.json` every call, so a loop over cache
 * entries paid one full-store read per entry: the denial reader admits 64 accounts with four client
 * versions each, which is up to 256 synchronous reads to score a single warm flagship request.
 *
 * Both stores are read lazily, so a pass that touches only Direct callers, or only native main,
 * still opens nothing it does not need. Neither backing read is memoized across passes: a resolver
 * lives for one synchronous loop, and that loop has no suspension point, so nothing this process
 * does can change the file underneath it. A snapshot is therefore not staler than per-entry reads
 * would have been -- it is strictly more coherent, because a foreign writer landing mid-loop can no
 * longer give the earlier entries one generation and the later ones another.
 */
function credentialIdentityResolver(): (accountId: string) => string | undefined {
  let records: Readonly<Record<string, CodexAccountCredentialRecord>> | undefined;
  let mainRead = false;
  let mainIdentity: string | undefined;
  return (accountId: string): string | undefined => {
    if (accountId.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX)) {
      return `direct:${accountId.slice(DIRECT_CALLER_ACCOUNT_PREFIX.length)}`;
    }
    if (accountId === MAIN_CODEX_ACCOUNT_ID) {
      if (!mainRead) {
        const token = getMainAccountToken();
        mainIdentity = token ? `main:${token.chatgptAccountId}` : undefined;
        mainRead = true;
      }
      return mainIdentity;
    }
    records ??= loadCodexAccountRecordSnapshot();
    const record = records[accountId];
    if (!record?.credential || record.deletedAt != null) return undefined;
    return `pool:${record.generation}:${record.credential.chatgptAccountId}`;
  };
}

/** Single-id resolution. Identical to one call through a fresh {@link credentialIdentityResolver}. */
function currentCredentialIdentity(accountId: string): string | undefined {
  return credentialIdentityResolver()(accountId);
}

async function accountCredentialSnapshot(
  accountId: string,
  options: Pick<
    CodexModelEntitlementResolveOptions,
    "nativeMainRefreshDependencies" | "releaseNativeMainCredentialLease" | "signal"
  > = {},
): Promise<CodexModelEntitlementCredentialSnapshot | null> {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    try {
      const token = await getValidMainAccountToken({
        signal: options.signal,
        ...(options.nativeMainRefreshDependencies ?? {}),
      });
      return token
        ? {
          accountId,
          accessToken: token.accessToken,
          chatgptAccountId: token.chatgptAccountId,
          credentialIdentity: `main:${token.chatgptAccountId}`,
        }
        : null;
    } catch (error) {
      // A failed main refresh removes only its own roster row; cancellation still propagates.
      if (options.signal?.aborted) throw error;
      return null;
    } finally {
      // The lifecycle lease fences only this credential read; releasing here —
      // on success and on a credential-ownership failure alike — keeps a
      // profile drain from waiting on the roster fetches that follow.
      options.releaseNativeMainCredentialLease?.();
    }
  }
  try {
    const token = await getValidCodexToken(accountId);
    return {
      accountId,
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      credentialIdentity: `pool:${token.generation}:${token.chatgptAccountId}`,
    };
  } catch {
    return null;
  }
}

const AVAILABILITY_MESSAGE_MAX_CODE_UNITS = 2_000;
// Codex parses the catalog with a strict JSON reader that rejects a lone surrogate escape.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Trim and cap a prompt without leaving half of a surrogate pair at the cut or anywhere else. */
function boundedAvailabilityMessage(message: string): string {
  return message.trim().slice(0, AVAILABILITY_MESSAGE_MAX_CODE_UNITS).replace(LONE_SURROGATE, "").trim();
}

/** Keep valid roster slugs while dropping malformed program and availability metadata. */
function parseAccountModels(text: string): {
  discoveredRows: Record<string, unknown>[];
  models: ReadonlySet<string>;
  accessProgramsByModel: ReadonlyMap<string, CodexAvailableAccessPrograms>;
  availabilityNuxByModel: ReadonlyMap<string, { message: string }>;
} | null {
  try {
    const payload = JSON.parse(text) as { models?: unknown };
    if (!Array.isArray(payload.models)) return null;
    const accessProgramsByModel = new Map<string, CodexAvailableAccessPrograms>();
    const availabilityNuxByModel = new Map<string, { message: string }>();
    const models = payload.models.flatMap(entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as { slug?: unknown; supported_in_api?: unknown; visibility?: unknown; available_access_programs?: unknown; availability_nux?: unknown };
      if (typeof row.slug !== "string" || row.supported_in_api !== true || row.visibility === "hide") return [];
      const nux = row.availability_nux;
      if (nux && typeof nux === "object" && !Array.isArray(nux)) {
        const message = (nux as { message?: unknown }).message;
        const bounded = typeof message === "string" ? boundedAvailabilityMessage(message) : "";
        if (bounded) availabilityNuxByModel.set(row.slug, { message: bounded });
      }
      const programs = row.available_access_programs;
      if (programs === null) accessProgramsByModel.set(row.slug, null);
      else if (programs && typeof programs === "object" && !Array.isArray(programs)) {
        const record = programs as Record<string, unknown>;
        if (Array.isArray(record.cyber) && record.cyber.every(item => typeof item === "string")) {
          const validPrograms = Object.fromEntries(Object.entries(record).filter(([, value]) =>
            Array.isArray(value) && value.every(item => typeof item === "string"))) as Record<string, string[]>;
          accessProgramsByModel.set(row.slug, validPrograms);
        }
      }
      return [row.slug];
    });
    return { models: new Set(models), accessProgramsByModel, availabilityNuxByModel,
      discoveredRows: validateDiscoveredNativeRows(payload.models) };
  } catch {
    return null;
  }
}

function unconfirmedAccountModels(
  credential: CodexModelEntitlementCredentialSnapshot,
  clientVersion: string,
  now: number,
  provenance: CodexModelEntitlementProvenance,
): CachedAccountModels {
  return {
    credentialIdentity: credential.credentialIdentity,
    clientVersion,
    expiresAt: now + MODEL_ROSTER_FAILURE_TTL_MS,
    models: new Set(),
    confirmed: false,
    provenance,
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** Fetch one bounded, version-scoped roster; failures and empty results remain unconfirmed for a short retry. */
async function fetchAccountModels(
  credential: CodexModelEntitlementCredentialSnapshot,
  fetcher: typeof fetch,
  now: number,
  clientVersion: string,
): Promise<CachedAccountModels> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Codex model discovery timed out", "TimeoutError")), MODEL_ROSTER_TIMEOUT_MS);
  try {
    const headers = new Headers({
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
    });
    if (credential.chatgptAccountId) headers.set("ChatGPT-Account-Id", credential.chatgptAccountId);
    const response = await fetcher(codexModelsUrl(clientVersion), {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return unconfirmedAccountModels(credential, clientVersion, now, {
        kind: "http-error",
        httpStatus: response.status,
      });
    }
    const body = await readBoundedResponseBody(response, {
      signal: controller.signal,
      maxBytes: MODEL_ROSTER_MAX_BYTES,
      fatalUtf8: true,
    });
    if (!body.displaySafe || body.truncated) {
      return unconfirmedAccountModels(credential, clientVersion, now, { kind: "unparseable" });
    }
    const parsed = parseAccountModels(body.text);
    if (parsed === null) {
      return unconfirmedAccountModels(credential, clientVersion, now, { kind: "unparseable" });
    }
    // A roster is a confirmation only when it lists something usable. `models` is a Set, and an
    // empty Set is truthy, so `models !== null` used to call `{"models":[]}` — and a response
    // whose every row was hidden or api-disabled — a confirmed answer, and lock it in for the
    // five-minute success TTL. Absence of evidence is not evidence of absence: an entitled
    // account asked under too old a client version answers with no gated rows, and treating
    // that as authoritative is exactly how 2.36.0 denied sol/terra/luna to accounts that own
    // them (#3022). No usable rows means unconfirmed, on the 15s failure TTL, asked again.
    const { models, accessProgramsByModel, availabilityNuxByModel } = parsed;
    const usable = models.size > 0;
    if (!usable) {
      return unconfirmedAccountModels(credential, clientVersion, now, { kind: "parsed-empty" });
    }
    recordDiscoveredNativeModels(parsed.discoveredRows, clientVersion, now);
    const hasUnknownGatedAbsence = [...ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS]
      // Reachable only through tier 1, an inbound client_version below the floor. Every other
      // resolution is now structurally >= every recorded minimum, because the floor is the max
      // of the derived value and the same measured constant these minimums hold. So this is the
      // escape hatch for a self-declared old client, not live protection on the background path:
      // there, an absence really was asked for at an adequate version and is a denial. If
      // upstream ever raises its true requirement above the measured constant, that constant is
      // the only thing standing between an entitled account and a five-minute cached denial.
      .some(([modelId, minimum]) => (
        !models.has(modelId) && compareClientVersions(clientVersion, minimum) < 0
      ));
    return {
      credentialIdentity: credential.credentialIdentity,
      clientVersion,
      expiresAt: now + (!hasUnknownGatedAbsence
        ? MODEL_ROSTER_TTL_MS
        : MODEL_ROSTER_FAILURE_TTL_MS),
      models,
      accessProgramsByModel,
      availabilityNuxByModel,
      confirmed: true,
    };
  } catch (error) {
    const provenance = isTimeoutError(error) || isTimeoutError(controller.signal.reason)
      ? { kind: "timeout" } as const
      : { kind: "network-error" } as const;
    return unconfirmedAccountModels(credential, clientVersion, now, provenance);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Client version the discovery-only roster request claims.
 *
 * Upstream filters `/models` by client version AND by a rollout gate the row's own
 * `minimal_client_version` does not describe: on 2026-09-30 `gpt-6.1-sol` carried
 * `minimal_client_version: "0.153.0"` yet was served only to `client_version >= 0.159.0`, while the
 * installed Codex was 0.158.0-alpha. Asking under the installed version (what the entitlement path
 * must do, #2886) therefore could not see the model at all. Discovery asks as a client newer than
 * any release so it sees the whole roster; this proxy already serves pinned rows to older
 * clients, so the version only widens what we learn, never what an account may call.
 */
export const CODEX_ROSTER_DISCOVERY_CLIENT_VERSION = "99.0.0";

export type CodexNativeRosterDiscoveryOutcome = "recorded" | "not-modified" | "unavailable";

export interface CodexNativeRosterDiscoveryOptions extends Pick<
  CodexModelEntitlementResolveOptions,
  "credentials" | "fetcher" | "signal" | "now" | "nativeMainRefreshDependencies"
> {
  /** Checked right before publication; false means the caller's scheduler generation is gone. */
  readonly isCurrent?: () => boolean;
}

/**
 * Last ETag per credential identity, so an unchanged roster costs a 304 when upstream honours it.
 * A 304 carries no rows and so cannot renew a discovery's last-seen time; a model visible only
 * under the discovery version would then expire after its retention while still being served.
 * The ETag is therefore used only within a day of the full fetch that earned it.
 */
const discoveryEtags = new Map<string, { etag: string; fetchedAt: number }>();
const DISCOVERY_ETAG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Background discovery of native rows this build does not pin, independent of entitlement.
 *
 * It never writes the entitlement cache: a roster fetched under the discovery version answers a
 * different question than "may this client call this model", and letting it satisfy entitlement
 * reads would reintroduce the cross-version leak #2548/#2886 closed. The first account that
 * answers is enough to learn a row; whether a given account may call it stays with the
 * entitlement path and, for ungated rows, with the upstream status the request receives.
 */
export async function discoverCodexNativeRoster(
  config: Pick<OcxConfig, "codexAccounts">,
  options: CodexNativeRosterDiscoveryOptions = {},
): Promise<CodexNativeRosterDiscoveryOutcome> {
  const fetcher = options.fetcher ?? fetch;
  const run = async (excluded: ReadonlySet<string>, releaseMainLease?: () => void) => {
    const credentials: CodexModelEntitlementCredentialSnapshot[] = [...(options.credentials ?? [])];
    for (const accountId of options.credentials ? [] : normalizedCandidateAccountIds(config)) {
      if (excluded.has(accountId)) continue;
      const credential = await accountCredentialSnapshot(accountId, {
        nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
        signal: options.signal,
      }).catch(() => null);
      if (credential) credentials.push(credential);
    }
    releaseMainLease?.();
    for (const credential of credentials) {
      const outcome = await fetchDiscoveryRoster(credential, fetcher, options).catch(() => "unavailable" as const);
      if (outcome !== "unavailable") return outcome;
    }
    return "unavailable" as const;
  };
  try {
    return await withNativeMainCredentialAdmission(run);
  } catch {
    return "unavailable";
  }
}

async function fetchDiscoveryRoster(
  credential: CodexModelEntitlementCredentialSnapshot,
  fetcher: typeof fetch,
  options: Pick<CodexNativeRosterDiscoveryOptions, "signal" | "now" | "isCurrent">,
): Promise<CodexNativeRosterDiscoveryOutcome> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Codex model discovery timed out", "TimeoutError")), MODEL_ROSTER_TIMEOUT_MS);
  try {
    const headers = new Headers({ Authorization: `Bearer ${credential.accessToken}`, Accept: "application/json" });
    if (credential.chatgptAccountId) headers.set("ChatGPT-Account-Id", credential.chatgptAccountId);
    const now = options.now ?? Date.now();
    const cached = discoveryEtags.get(credential.credentialIdentity);
    if (cached && now - cached.fetchedAt < DISCOVERY_ETAG_MAX_AGE_MS) headers.set("If-None-Match", cached.etag);
    const response = await fetcher(codexModelsUrl(CODEX_ROSTER_DISCOVERY_CLIENT_VERSION), {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 304) return "not-modified";
    if (!response.ok) return "unavailable";
    const body = await readBoundedResponseBody(response, {
      signal: controller.signal,
      maxBytes: MODEL_ROSTER_MAX_BYTES,
      fatalUtf8: true,
    });
    if (!body.displaySafe || body.truncated) return "unavailable";
    const parsed = parseAccountModels(body.text);
    if (parsed === null || parsed.models.size === 0) return "unavailable";
    if (controller.signal.aborted || options.isCurrent?.() === false) return "unavailable";
    recordDiscoveredNativeModels(parsed.discoveredRows, CODEX_ROSTER_DISCOVERY_CLIENT_VERSION, now);
    const nextEtag = response.headers.get("etag");
    if (nextEtag && nextEtag.length <= 256) discoveryEtags.set(credential.credentialIdentity, { etag: nextEtag, fetchedAt: now });
    else discoveryEtags.delete(credential.credentialIdentity);
    if (discoveryEtags.size > 64) discoveryEtags.delete(discoveryEtags.keys().next().value!);
    return "recorded";
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function resetCodexNativeRosterDiscoveryForTests(): void {
  discoveryEtags.clear();
}

function directCallerCredential(headers: Headers): CodexModelEntitlementCredentialSnapshot | null {
  const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "");
  if (!match) return null;
  const accessToken = match[1]!;
  const chatgptAccountId = headers.get("chatgpt-account-id")?.trim() ?? "";
  const fingerprint = createHash("sha256")
    .update(accessToken)
    .update("\0")
    .update(chatgptAccountId)
    .digest("hex");
  return {
    accountId: `${DIRECT_CALLER_ACCOUNT_PREFIX}${fingerprint}`,
    accessToken,
    chatgptAccountId,
    credentialIdentity: `direct:${fingerprint}`,
  };
}

async function modelsForCredential(
  credential: CodexModelEntitlementCredentialSnapshot,
  fetcher: typeof fetch,
  now: number,
  clientVersion: string,
  trustedClientVersion: string,
  credentialMutationEpoch?: number,
): Promise<CachedAccountModels> {
  const cached = accountModelsCache.get(cacheKeyFor(credential.accountId, clientVersion));
  if (
    cached
    && cached.credentialIdentity === credential.credentialIdentity
    && cached.expiresAt > now
  ) return cached;

  const flightKey = `${credential.accountId}\u0000${credential.credentialIdentity}\u0000${clientVersion}`
    + (credentialMutationEpoch === undefined ? "" : `\u0000${credentialMutationEpoch}`);
  const existing = accountModelsFlights.get(flightKey);
  if (existing) return existing;

  // Bound concurrency per account before opening another upstream request.
  let liveForAccount = 0;
  for (const key of accountModelsFlights.keys()) {
    if (accountIdOfCacheKey(key) === credential.accountId) liveForAccount += 1;
  }
  if (liveForAccount >= MODEL_ROSTER_FLIGHTS_PER_ACCOUNT_MAX) {
    return {
      credentialIdentity: credential.credentialIdentity,
      clientVersion,
      expiresAt: now,
      models: new Set(),
      confirmed: false,
    };
  }
  // Cache hits, joined flights and capacity refusals start no upstream request. Charge only
  // after capacity admission; the locally selected runtime version remains exempt.
  if (
    !credential.accountId.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX)
    && clientVersion !== trustedClientVersion
    && !admitVersionMiss(credential, clientVersion, now)
  ) {
    return {
      credentialIdentity: credential.credentialIdentity,
      clientVersion,
      expiresAt: now,
      models: new Set(),
      confirmed: false,
    };
  }
  const flight = fetchAccountModels(credential, fetcher, now, clientVersion)
    .then(result => {
      if (
        currentCredentialIdentity(credential.accountId) === credential.credentialIdentity
        && (credentialMutationEpoch === undefined
          || codexCredentialMutationEpoch() === credentialMutationEpoch)
      ) {
        boundedCacheSet(credential.accountId, result);
      }
      return result;
    })
    .finally(() => {
      if (accountModelsFlights.get(flightKey) === flight) accountModelsFlights.delete(flightKey);
    });
  accountModelsFlights.set(flightKey, flight);
  return flight;
}

/** Whether this caller-selected version may open a new upstream request for the account. */
function admitVersionMiss(
  credential: CodexModelEntitlementCredentialSnapshot,
  clientVersion: string,
  now: number,
): boolean {
  const stored = accountModelsMisses.get(credential.accountId);
  const budget = stored && stored.credentialIdentity === credential.credentialIdentity
    ? stored
    : { credentialIdentity: credential.credentialIdentity, versions: new Map<string, number>() };
  for (const [version, expiresAt] of budget.versions) {
    if (expiresAt <= now) budget.versions.delete(version);
  }
  const alreadyCharged = budget.versions.has(clientVersion);
  const admitted = alreadyCharged
    || budget.versions.size < MODEL_ROSTER_VERSION_MISSES_PER_ACCOUNT_MAX;
  // A repeat keeps its ORIGINAL expiry. Refreshing it here would let a caller hold one version
  // open indefinitely, and it is the retry case this distinction exists to protect.
  if (admitted && !alreadyCharged) budget.versions.set(clientVersion, now + MODEL_ROSTER_TTL_MS);
  if (budget.versions.size === 0) accountModelsMisses.delete(credential.accountId);
  else accountModelsMisses.set(credential.accountId, budget);
  return admitted;
}

function candidateAccountIds(config: Pick<OcxConfig, "codexAccounts">): string[] {
  return [
    MAIN_CODEX_ACCOUNT_ID,
    ...(config.codexAccounts ?? [])
      .filter(isSelectableCodexPoolAccount)
      .map(account => account.id),
  ];
}

function normalizedCandidateAccountIds(config: Pick<OcxConfig, "codexAccounts">): string[] {
  return [...new Set(candidateAccountIds(config))].sort();
}

function freshNegativeCredentialMemo(
  accountId: string,
  credentialIdentity: string | null,
  mutationEpoch: number,
  now: number,
): boolean {
  const memo = negativeCredentialMemo.get(accountId);
  if (
    memo
    && memo.credentialIdentity === credentialIdentity
    && memo.mutationEpoch === mutationEpoch
    && memo.expiresAt > now
  ) return true;
  if (memo) negativeCredentialMemo.delete(accountId);
  return false;
}

function boundedNegativeCredentialMemoSet(accountId: string, memo: NegativeCredentialMemo): void {
  negativeCredentialMemo.delete(accountId);
  negativeCredentialMemo.set(accountId, memo);
  for (const oldest of [...negativeCredentialMemo.keys()].slice(0, Math.max(
    0,
    negativeCredentialMemo.size - MODEL_ROSTER_CACHE_MAX,
  ))) negativeCredentialMemo.delete(oldest);
}

function needsEntitlementRefresh(
  accountId: string,
  credentialIdentity: string | null,
  clientVersion: string,
  mutationEpoch: number,
  now: number,
): boolean {
  const cached = accountModelsCache.get(cacheKeyFor(accountId, clientVersion));
  if (cached && cached.credentialIdentity !== credentialIdentity) {
    invalidateCodexModelEntitlementsForAccount(accountId);
    // The credential itself changed, so evidence gathered under the previous one answers for a
    // different subscription. This is the only call site that knows that: the two gated-model
    // sites in `core-codex-account.ts` invalidate a STALE roster for an unchanged credential,
    // and clearing observed refusals there would discard the very evidence #4906 is about.
    forgetObservedCodexModelDenialsForAccount(accountId);
  } else if (cached && cached.expiresAt > now) {
    return false;
  }
  return !freshNegativeCredentialMemo(accountId, credentialIdentity, mutationEpoch, now);
}

function entitlementEnsureFlightKey(
  candidateAccountIds: readonly string[],
  clientVersion: string,
  mutationEpoch: number,
  identityVector: readonly (readonly [string, string | null])[],
  workset: readonly string[],
): string {
  return JSON.stringify([candidateAccountIds, clientVersion, mutationEpoch, identityVector, workset]);
}

async function refreshCodexEntitlementWorkset(
  config: Pick<OcxConfig, "codexAccounts">,
  workset: readonly string[],
  identityVector: ReadonlyMap<string, string | null>,
  clientVersion: string,
  mutationEpoch: number,
  options: CodexEntitlementFreshnessOptions,
): Promise<void> {
  const run = async (
    excludedAccountIds: ReadonlySet<string>,
    releaseMainLease?: () => void,
  ): Promise<void> => {
    // An excluded main is filtered before the snapshot phase, not just before the
    // roster fetch: it never produces an absence observation, so a denied
    // admission cannot memoize a credential read that never happened.
    const admittedWorkset = excludedAccountIds.size === 0
      ? workset
      : workset.filter(accountId => !excludedAccountIds.has(accountId));
    const credentialSnapshot = options.credentialSnapshot ?? accountCredentialSnapshot;
    const observations = await Promise.all(admittedWorkset.map(async accountId => {
      const credential = await credentialSnapshot(accountId, {
        ...options,
        releaseNativeMainCredentialLease: releaseMainLease,
      });
      return {
        accountId,
        credential,
        absenceObservedAt: options.now ?? Date.now(),
      };
    }));
    // The lease fences only the credential phase; release before roster fetches
    // so a profile drain never waits on upstream network work.
    releaseMainLease?.();
    const credentials = observations.flatMap(observation => observation.credential
      ? [observation.credential]
      : []);
    if (credentials.length > 0) {
      await resolveCodexModelEntitlements(config, {
        ...options,
        clientVersion,
        credentialMutationEpoch: mutationEpoch,
        credentials,
      });
    }

    for (const observation of observations) {
      if (observation.credential) continue;
      const capturedIdentity = identityVector.get(observation.accountId) ?? null;
      if (codexCredentialMutationEpoch() !== mutationEpoch) continue;
      if ((currentCredentialIdentity(observation.accountId) ?? null) !== capturedIdentity) continue;
      boundedNegativeCredentialMemoSet(observation.accountId, {
        credentialIdentity: capturedIdentity,
        mutationEpoch,
        expiresAt: observation.absenceObservedAt + MODEL_ROSTER_NEGATIVE_CREDENTIAL_TTL_MS,
      });
    }
  };
  if (!workset.includes(MAIN_CODEX_ACCOUNT_ID)) return run(new Set<string>());
  const admission = options.nativeMainCredentialAdmission ?? withNativeMainCredentialAdmission;
  return admission(run);
}

function waitForEntitlementEnsureFlight(
  flight: EntitlementEnsureFlight,
  waitMs: number,
): Promise<void> {
  const remaining = Math.max(0, waitMs - Math.max(0, Date.now() - flight.startedAt));
  if (remaining === 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, remaining);
    void flight.promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Refreshes only missing, expired, or credential-mismatched local entitlement entries.
 * Management deadlines bound the wait, not the upstream work, so a timed-out poll still warms
 * the cache for the first poll after the shared flight settles.
 */
export async function ensureCodexEntitlementFreshness(
  config: Pick<OcxConfig, "codexAccounts">,
  options: CodexEntitlementFreshnessOptions = {},
): Promise<void> {
  try {
    const now = options.now ?? Date.now();
    const clientVersion = resolveCodexEntitlementClientVersion(
      options.clientVersion,
      options.loadPersistedRuntime ?? loadPersistedCodexRuntime,
    );
    const candidates = normalizedCandidateAccountIds(config);
    const mutationEpoch = codexCredentialMutationEpoch();
    // Same hoist as the denial pass: this prologue is synchronous and reads once per candidate.
    const identityOf = credentialIdentityResolver();
    const identityEntries = candidates.map(accountId => (
      [accountId, identityOf(accountId) ?? null] as const
    ));
    const identityVector = new Map(identityEntries);
    const workset = candidates.filter(accountId => needsEntitlementRefresh(
      accountId,
      identityVector.get(accountId) ?? null,
      clientVersion,
      mutationEpoch,
      now,
    ));
    if (workset.length === 0) return;

    const key = entitlementEnsureFlightKey(
      candidates,
      clientVersion,
      mutationEpoch,
      identityEntries,
      workset,
    );
    let flight = entitlementEnsureFlights.get(key);
    if (!flight) {
      const startedAt = Date.now();
      let created!: EntitlementEnsureFlight;
      const promise = refreshCodexEntitlementWorkset(
        config,
        workset,
        identityVector,
        clientVersion,
        mutationEpoch,
        options,
      ).catch(() => {
        // Entitlement discovery is fail-closed: callers project only confirmed cache entries.
      }).finally(() => {
        if (entitlementEnsureFlights.get(key) === created) entitlementEnsureFlights.delete(key);
      });
      created = { startedAt, promise, clientVersion, identityVector, workset };
      entitlementEnsureFlights.set(key, created);
      flight = created;
    }
    const requestedWaitMs = options.waitMs ?? 3_000;
    const waitMs = Number.isFinite(requestedWaitMs) ? Math.max(0, requestedWaitMs) : 0;
    await waitForEntitlementEnsureFlight(flight, waitMs);
  } catch {
    // The shared management boundary must degrade to the last confirmed fail-closed projection.
  }
}

export function getCodexModelEntitlementStatus(
  config: Pick<OcxConfig, "codexAccounts">,
  now = Date.now(),
  clientVersion?: string | null,
): CodexModelEntitlementStatus {
  const version = resolveCodexEntitlementClientVersion(clientVersion);
  const identityOf = credentialIdentityResolver();
  const accounts = candidateAccountIds(config).flatMap(accountId => {
    const credentialIdentity = identityOf(accountId);
    return credentialIdentity ? [{ accountId, credentialIdentity }] : [];
  });
  if (accounts.length === 0) return { status: "unavailable" };

  const entries = accounts.map(({ accountId, credentialIdentity }) => ({
    accountId,
    credentialIdentity,
    entry: accountModelsCache.get(cacheKeyFor(accountId, version)),
  }));
  const hasRefreshFlight = (accountId: string, credentialIdentity: string): boolean => {
    return [...entitlementEnsureFlights.values()].some(flight => (
      flight.clientVersion === version
      && flight.identityVector.get(accountId) === credentialIdentity
      && flight.workset.includes(accountId)
    ));
  };
  if (entries.some(({ accountId, credentialIdentity, entry }) => (
    entry
    && entry.credentialIdentity === credentialIdentity
    && entry.expiresAt <= now
    && hasRefreshFlight(accountId, credentialIdentity)
  ))) return { status: "expired-refresh-in-flight" };
  const live = entries.flatMap(({ credentialIdentity, entry }) => (
    entry && entry.credentialIdentity === credentialIdentity && entry.expiresAt > now ? [entry] : []
  ));
  // Deliberate failure-first aggregation keeps a partial Pool refresh failure visible.
  const failed = live.find(entry => entry.provenance && entry.provenance.kind !== "parsed-empty");
  if (failed?.provenance?.kind === "http-error") {
    return { status: "failed", reason: "http-error", httpStatus: failed.provenance.httpStatus };
  }
  if (failed?.provenance?.kind === "network-error") return { status: "failed", reason: "network-error" };
  if (failed?.provenance?.kind === "timeout") return { status: "failed", reason: "timeout" };
  if (failed?.provenance?.kind === "unparseable") return { status: "failed", reason: "unparseable" };
  if (live.some(entry => entry.provenance?.kind === "parsed-empty")) {
    return { status: "unconfirmed-empty" };
  }
  if (live.some(entry => entry.confirmed)) return { status: "fresh" };
  return { status: "unavailable" };
}

/**
 * Fetch the authenticated model roster for every locally usable Codex account.
 *
 * [Decision Log]
 * - 목적과 의도: Account-gated native models must be advertised and selected only for accounts
 *   whose own authenticated upstream catalog confirms the model.
 * - 기존 구현 및 제약 조건: The injected Codex catalog is static, while Pool may contain
 *   accounts with different entitlements. A global allowlist therefore exposed unusable rows.
 * - 검토한 주요 대안: Infer access from plan labels, learn only after a failed prompt, or rewrite
 *   Daybreak to its current physical model.
 * - 선택한 방식: Cache bounded authenticated `/models` rosters per credential generation and
 *   fail closed for unconfirmed accounts.
 * - 다른 대안 대신 이 방식을 선택한 이유: Plan names do not prove grants, post-failure
 *   learning spends a real turn, and model rewriting changes the requested product identity.
 * - 장점, 단점 및 영향: Catalog and routing share exact account evidence. Cold gated requests
 *   pay one bounded discovery call per account; discovery failure temporarily hides the gated row.
 */
export async function resolveCodexModelEntitlements(
  config: Pick<OcxConfig, "codexAccounts">,
  options: CodexModelEntitlementResolveOptions = {},
): Promise<CodexModelEntitlementSnapshot> {
  const now = options.now ?? Date.now();
  const fetcher = options.fetcher ?? fetch;
  const clientVersion = resolveCodexEntitlementClientVersion(
    options.clientVersion,
    options.loadPersistedRuntime ?? loadPersistedCodexRuntime,
  );
  const allowedAccountIds = candidateAccountIds(config)
    .filter(accountId => !options.excludeAccountIds?.has(accountId));
  const credentialSnapshot = options.credentialSnapshot ?? accountCredentialSnapshot;
  const credentials = options.credentials
    ? [...options.credentials].filter(credential => !options.excludeAccountIds?.has(credential.accountId))
    : (await Promise.all(allowedAccountIds.map(accountId => credentialSnapshot(accountId, options))))
      .filter((value): value is CodexModelEntitlementCredentialSnapshot => value !== null);
  // The credential phase is the only part the native-main lease fences. The
  // real snapshot releases it as soon as the main token settles; this boundary
  // release keeps the guarantee when a seam snapshot never invokes it.
  options.releaseNativeMainCredentialLease?.();
  const results = await Promise.all(credentials.map(async credential => ({
    credential,
    result: await modelsForCredential(
      credential,
      fetcher,
      now,
      clientVersion,
      resolveCodexEntitlementClientVersion(
        null,
        options.loadPersistedRuntime ?? loadPersistedCodexRuntime,
      ),
      options.credentialMutationEpoch,
    ),
  })));
  return {
    modelsByAccount: new Map(results.map(({ credential, result }) => [credential.accountId, result.models])),
    accessProgramsByAccount: new Map(results.flatMap(({ credential, result }) => (
      result.confirmed && result.accessProgramsByModel
        ? [[credential.accountId, result.accessProgramsByModel] as const] : []
    ))),
    availabilityNuxByAccount: new Map(results.flatMap(({ credential, result }) => (
      result.confirmed && result.availabilityNuxByModel
        ? [[credential.accountId, result.availabilityNuxByModel] as const] : []
    ))),
    clientVersionByAccount: new Map(results.map(({ credential, result }) => (
      [credential.accountId, result.clientVersion]
    ))),
    confirmedAccountIds: new Set(results.flatMap(({ credential, result }) => result.confirmed ? [credential.accountId] : [])),
    credentialIdentities: new Map(results.map(({ credential }) => [credential.accountId, credential.credentialIdentity])),
  };
}

function codexModelEntitlementStateForRoster(
  models: ReadonlySet<string> | undefined,
  confirmed: boolean,
  clientVersion: string | undefined,
  modelId: string,
): CodexModelEntitlementState {
  if (!models || !confirmed) return "unknown";
  // Positive evidence is authoritative regardless of which client version asked for it.
  if (models.has(modelId)) return "granted";
  const minimum = ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS.get(modelId);
  if (minimum && (!clientVersion || compareClientVersions(clientVersion, minimum) < 0)) {
    return "unknown";
  }
  return "denied";
}

/** Per-account tri-state authority. Positive projections admit only `granted`. */
export function codexModelEntitlementStateForAccount(
  snapshot: CodexModelEntitlementSnapshot,
  accountId: string,
  modelId: string,
): CodexModelEntitlementState {
  return codexModelEntitlementStateForRoster(
    snapshot.modelsByAccount.get(accountId),
    snapshot.confirmedAccountIds.has(accountId),
    snapshot.clientVersionByAccount?.get(accountId),
    modelId,
  );
}

/** Fail-closed entitlement check for a Direct request's own forwarded ChatGPT credential. */
export async function isDirectCallerEntitledToCodexModel(
  headers: Headers,
  modelId: string,
  options: Pick<CodexModelEntitlementResolveOptions, "fetcher" | "now" | "clientVersion"> = {},
): Promise<boolean> {
  if (!ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(modelId)) return true;
  const credential = directCallerCredential(headers);
  if (!credential) return false;
  const clientVersion = resolveCodexEntitlementClientVersion(options.clientVersion);
  const result = await modelsForCredential(
    credential,
    options.fetcher ?? fetch,
    options.now ?? Date.now(),
    clientVersion,
    clientVersion,
  );
  return codexModelEntitlementStateForRoster(
    result.models,
    result.confirmed,
    result.clientVersion,
    modelId,
  ) === "granted";
}

export function entitledCodexAccountIdsForModel(
  snapshot: CodexModelEntitlementSnapshot,
  modelId: string | undefined,
): ReadonlySet<string> | undefined {
  if (!modelId || !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(modelId)) return undefined;
  return new Set([...snapshot.modelsByAccount.keys()].flatMap(accountId => (
    codexModelEntitlementStateForAccount(snapshot, accountId, modelId) === "granted"
      ? [accountId]
      : []
  )));
}

export function availableAccountGatedNativeModels(
  snapshot: CodexModelEntitlementSnapshot,
  eligibleAccountIds?: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(modelId => (
    [...snapshot.modelsByAccount.keys()].some(accountId => (
      (!eligibleAccountIds || eligibleAccountIds.has(accountId))
      && codexModelEntitlementStateForAccount(snapshot, accountId, modelId) === "granted"
    ))
  )));
}

/**
 * Native models that stay unconditionally VISIBLE while their per-account availability still
 * varies.
 *
 * This is deliberately not `ACCOUNT_GATED_NATIVE_OPENAI_MODELS` and must never become it. That set
 * fails closed on ABSENCE of evidence: membership hides the row from the catalog and refuses the
 * request before dispatch, which is exactly what the owner decision of 2026-09-04 removed the
 * flagships from. A timed-out fetch or a shard that has not caught up would make the model vanish
 * from the picker, and "opencodex lost my model" is a worse failure than one upstream 400.
 *
 * This set carries the opposite polarity. It admits only a CONFIRMED DENIAL as evidence, and it
 * feeds an ordering preference rather than a refusal, so absent or stale evidence changes nothing.
 * That is the distinction #4768 asked for: a pool holding a Plus account and a Free account should
 * stop handing Sol/Astra to the Free account whose own authenticated roster already says it cannot
 * serve them, without gating the model on evidence that may never arrive.
 */
export const ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  NATIVE_GPT6_ASTRA_MODEL,
]);

/**
 * Native models whose exact upstream refusal is remembered as an ordering preference (OPS-2117).
 *
 * Wider than {@link ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS} on purpose. That set governs the
 * ROSTER path, and a roster that lags a release (GPT-6.1 Sol/Terra) must not shrink the pool, so
 * new flagships stay out of it. An exact refusal is different evidence: the account's own Codex
 * surface named the model and declined it. Keeping refusals behind the roster list meant every
 * model released after the list was written (gpt-6-sol, gpt-6.1-sol, gpt-6.1-terra ...) was
 * never learned, and a Free account kept receiving Sol 6.1 turns it refuses every time
 * (2026-11-14 06:39~06:57, four Paseo Codex turns failed while main still had paid credits).
 * Any native OpenAI slug qualifies, so a new release is covered without editing a hand list.
 */
export function isRefusalLearnableNativeOpenAiModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  if (ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS.has(modelId)) return true;
  // Account-gated models fail closed through the eligibility path instead.
  return SUPPORTED_NATIVE_OPENAI_SLUGS.has(modelId) && !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(modelId);
}

/**
 * Accounts whose OWN authenticated roster definitively omits `modelId`, read synchronously from
 * evidence discovery has already gathered.
 *
 * Synchronous and cache-only by contract. The gated path may await `resolveCodexModelEntitlements`
 * because a gated model is rare and already pays a bounded discovery call; the flagships are the
 * most commonly requested models in the product, and putting an authenticated upstream fetch per
 * account on that request path would trade one occasional 400 for latency on every turn. The cache
 * this reads is warmed anyway: `modelsForCredential` stores each account's FULL roster, and
 * background catalog sync (`src/codex/catalog/retained-sync.ts`) and convergence already resolve
 * entitlements for every pool account.
 *
 * Returns `undefined` rather than an empty set when nothing is denied, so a caller cannot confuse
 * "no account is denied" with "no evidence exists" — both mean the same thing here, which is that
 * selection must be left exactly as it was.
 *
 * Only `denied` counts. `unknown` covers an unconfirmed account, a roster fetched under a client
 * version too old to return the model, and an expired or credential-stale entry; none of those is
 * proof that the account lacks the model, and treating them as proof is how 2.36.0 removed
 * sol/terra/luna from accounts that owned them (#3022).
 */
export function cachedDeniedCodexAccountIdsForModel(
  modelId: string | undefined,
  now = Date.now(),
  options: { excludeAccountIds?: ReadonlySet<string> } = {},
): ReadonlySet<string> | undefined {
  if (!modelId || !isRefusalLearnableNativeOpenAiModel(modelId)) return undefined;
  // Roster absence is denial evidence only inside the roster-preferred set; outside it a lagging
  // roster may simply predate the release. Roster GRANTS still count everywhere.
  const rosterDenialAdmissible = ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS.has(modelId);
  const denied = new Set<string>();
  const granted = new Set<string>();
  // One resolver for the whole pass: the loop below runs once per cached (account, client version)
  // entry, and resolving an identity per entry meant a full account-store read per entry.
  const identityOf = credentialIdentityResolver();
  for (const [key, entry] of accountModelsCache) {
    const accountId = accountIdOfCacheKey(key);
    // A forwarded Direct credential is one request's caller, never a pool candidate.
    if (accountId.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX)) continue;
    // The caller's read fence, honoured BEFORE `identityOf` below, because that is the read: for
    // native main it resolves the physical stored token. A request that is forbidden to read main
    // -- a profile switch draining it, or a request-owned credential that owns no main state --
    // must not reread account storage just to score an ordering preference. Dropping the account
    // leaves it UNKNOWN rather than denied, which is the same outcome as having no cached roster
    // for it and changes no selection. The resolver reads lazily for the same reason: an excluded
    // account `continue`s here, so its store is never opened at all.
    if (options.excludeAccountIds?.has(accountId)) continue;
    if (entry.expiresAt <= now) continue;
    // A credential we can currently read AND that differs is proof the entry answers for a
    // different account than this id now names, so its denial is not evidence about the current
    // one. An UNREADABLE credential is not proof of anything, and the same unknown-is-not-denied
    // discipline that governs rosters governs identities: it leaves the entry in place rather
    // than manufacturing a reason to ignore it.
    const identity = identityOf(accountId);
    if (identity !== undefined && identity !== entry.credentialIdentity) continue;
    const state = codexModelEntitlementStateForRoster(
      entry.models,
      entry.confirmed,
      entry.clientVersion,
      modelId,
    );
    if (state === "granted") granted.add(accountId);
    else if (state === "denied" && rosterDenialAdmissible) denied.add(accountId);
  }
  // The roster is not the only evidence, and on this path it is usually the weaker one. A cached
  // roster expires in five minutes and nothing on the flagship request path refetches it, so
  // absent an ongoing catalog sync the loop above contributes nothing at all. An upstream
  // refusal does not expire on that schedule and is not a snapshot of a pending answer: it is
  // the account's own Codex surface naming this model and declining it (#4906).
  // The caller's read fence is passed IN rather than applied to the result, so an excluded
  // account is skipped before the credential-generation validation reads account storage
  // (#4952). An excluded account must stay UNKNOWN rather than denied, so a profile switch or
  // a request-owned credential produces the same selection it does today.
  const observedDenied = observedDeniedCodexAccountIdsForModel(modelId, now, {
    ...(options.excludeAccountIds ? { excludeAccountIds: options.excludeAccountIds } : {}),
  });
  for (const accountId of observedDenied ?? []) denied.add(accountId);
  // One account holds one entry per client version, and upstream filters the roster by that
  // version. So the same account can legitimately carry a granted entry under a current client
  // and a denied one under an older client that predates the model. Positive evidence is
  // authoritative regardless of which version asked for it -- the same rule
  // `codexModelEntitlementStateForRoster` applies within a single entry -- so a grant anywhere
  // clears the denial rather than being outvoted by whichever entry the map happened to yield
  // last. It outranks an observed refusal for the same reason: a confirmed roster that lists the
  // model is the newer answer, and a rollout that reaches an account must not be held back by a
  // refusal it has already superseded.
  for (const accountId of granted) denied.delete(accountId);
  return denied.size > 0 ? denied : undefined;
}

/**
 * Record an authenticated upstream refusal as this account's own evidence about `modelId`.
 *
 * Scoped to {@link ENTITLEMENT_PREFERRED_NATIVE_OPENAI_MODELS} because that is the set whose
 * availability varies per account while the row stays visible, and it is the set
 * {@link cachedDeniedCodexAccountIdsForModel} will read back. A model outside it either has no
 * per-account variance or is gated by the fail-closed roster path, where an ordering preference
 * would change nothing.
 *
 * The caller must have matched the exact allow-listed refusal body first. A status alone is not
 * admissible here: 400 covers every malformed request too, and remembering one of those as an
 * entitlement fact would steer routing away from a perfectly capable account.
 */
// Denial evidence is credential-scoped (#4952). The store stays a leaf module, so the
// liveness predicate is injected here, where the account store is already a dependency.
setObservedDenialGenerationCheck(beginCodexAccountGenerationLiveCheck);

export function recordCodexModelDenialEvidence(
  accountId: string | null | undefined,
  modelId: string | undefined,
  generation: number | null | undefined,
  now = Date.now(),
): void {
  if (!accountId || !modelId) return;
  if (!isRefusalLearnableNativeOpenAiModel(modelId)) return;
  // A caller that cannot name a credential generation records ACCOUNT-scoped evidence rather
  // than none. The one production context in that position is `main-pool`, whose credential
  // lives in `auth.json` and has no pool generation; discarding its refusals would revert
  // #4906 for the stored main login (#4952). Request-owned `main` never reaches here — its
  // `accountId` is null and the guard above returns.
  recordObservedCodexModelDenial(accountId, modelId, typeof generation === "number" ? generation : undefined, now);
}

/** Drop the refusal evidence for a pair the account has just served successfully. */
export function clearCodexModelDenialEvidence(
  accountId: string | null | undefined,
  modelId: string | undefined,
  generation: number | null | undefined,
): void {
  if (!accountId || !modelId) return;
  // Mirror of the write: an account-scoped success clears account-scoped evidence. It cannot
  // clear a credential-scoped entry that names a newer generation, and vice versa (#4952).
  clearObservedCodexModelDenial(accountId, modelId, typeof generation === "number" ? generation : undefined);
}

/** Synchronous projection for management/catalog readers after a discovery pass. */
export function cachedAvailableAccountGatedNativeModels(
  now = Date.now(),
  eligibleAccountIds?: ReadonlySet<string>,
  clientVersion?: string | null,
): ReadonlySet<string> {
  // Entries fetched under a different client version answer a different question, so a caller
  // that knows which version it is projecting for must say so — otherwise a newer client's
  // roster leaks into an older client's projection (#2548 from the opposite direction).
  //
  // Omitting the argument deliberately does NOT filter. This is a synchronous read of
  // whatever discovery already proved, and its callers (catalog metadata) are not
  // request-scoped: resolving a version here would silently discard every entry fetched under
  // a different one, which is a suppression this function has no evidence to justify.
  const version = isUsableCodexClientVersion(clientVersion) ? clientVersion.trim() : null;
  return new Set([...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(modelId => (
    [...accountModelsCache].some(([accountId, entry]) => (
      (!eligibleAccountIds || eligibleAccountIds.has(accountIdOfCacheKey(accountId)))
      && !accountIdOfCacheKey(accountId).startsWith(DIRECT_CALLER_ACCOUNT_PREFIX)
      && (version === null || entry.clientVersion === version)
      && entry.expiresAt > now
      && codexModelEntitlementStateForRoster(
        entry.models,
        entry.confirmed,
        entry.clientVersion,
        modelId,
      ) === "granted"
    ))
  )));
}

export function isCodexModelEntitlementSnapshotCurrent(snapshot: CodexModelEntitlementSnapshot): boolean {
  for (const [accountId, identity] of snapshot.credentialIdentities) {
    // Deliberately per-id, unlike the passes above. This is a fail-closed publication gate asking
    // whether a snapshot is STILL current, so the freshest possible answer per account is the
    // point of the read. A pass-wide snapshot would be a coherence win everywhere else and a
    // small weakening here: it could answer "current" for a later account from a record a
    // concurrent reauth had already replaced.
    if (currentCredentialIdentity(accountId) !== identity) return false;
  }
  return true;
}

export function invalidateCodexModelEntitlementsForAccount(accountId: string | null | undefined): void {
  if (!accountId) return;
  // Every version's entry for this account, since a credential change invalidates the
  // account's entitlement evidence regardless of which client version asked for it.
  for (const key of [...accountModelsCache.keys()]) {
    if (accountIdOfCacheKey(key) === accountId) accountModelsCache.delete(key);
  }
  accountModelsMisses.delete(accountId);
}

export function resetCodexModelEntitlementCacheForTests(): void {
  accountModelsCache.clear();
  accountModelsFlights.clear();
  accountModelsMisses.clear();
  negativeCredentialMemo.clear();
  entitlementEnsureFlights.clear();
  resetRuntimeVersionMemoForTests();
  resetObservedCodexModelDenialsForTests();
}

/** Test-only snapshot for proving publication fences, which cache lookup intentionally masks. */
export function codexEntitlementNegativeMemoForTests(
  accountId: string,
): Readonly<{
  credentialIdentity: string | null;
  mutationEpoch: number;
  expiresAt: number;
}> | null {
  const memo = negativeCredentialMemo.get(accountId);
  return memo ? { ...memo } : null;
}

/**
 * Test-only seam for the memoized tier-2 read.
 *
 * The memo is deliberately reachable only through the DEFAULT loader (a supplied loader is
 * auto-bypassed, so it cannot be cross-answered), which leaves no way to observe memo behavior
 * from a test without either touching the real state file or exposing this.
 */
export function memoizeRuntimeVersionForTests(
  loadRuntime: () => { selectedVersion?: string | null } | null,
  now: number,
): string | null {
  return memoizedPersistedRuntimeVersion(loadRuntime, now);
}

export function seedCodexModelEntitlementsForTests(
  accountId: string,
  models: readonly string[],
  now = Date.now(),
  clientVersion = "0.146.0",
  credentialIdentity = `test:${accountId}`,
): void {
  boundedCacheSet(accountId, {
    credentialIdentity,
    clientVersion,
    expiresAt: now + MODEL_ROSTER_TTL_MS,
    models: new Set(models),
    confirmed: true,
  });
}
