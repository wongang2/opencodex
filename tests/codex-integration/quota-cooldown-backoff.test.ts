import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import {
  clearCodexUpstreamHealth,
  getCodexQuotaHealthSnapshot,
  recordCodexUpstreamOutcome,
} from "../../src/codex/routing";
import type { OcxConfig } from "../../src/types";

/**
 * Regression cover for OPS-1718 (2026-09-13): a denied request costs the same subscription quota
 * as a served one, because Codex meters by REQUEST COUNT (~0.045% of the weekly cap per request).
 *
 * Two defects made the proxy pay that price over and over:
 *
 *   1. An exhausted WEEKLY window was cooled down for at most 15 minutes, because the only
 *      reset-derived path deliberately caps far below the announced reset (#433 — correct for a
 *      sub-day burst window, wrong for a weekly one that does not refill early). A six-day
 *      exhaustion therefore became a six-day drumbeat.
 *   2. A denial with no upstream directive always cooled down for a flat 60s, so an exhausted
 *      account was re-opened sixty times an hour and every re-open spent one more denied request.
 *
 * Measured on 2026-09-13: 695 of 827 quota-class denials reached upstream; 2026-08-31 alone burned
 * 351, including 231 inside nine minutes.
 *
 * Aim these at the pre-fix routing.ts and cases 1-4 fail (15-minute cap, flat 60s ladder).
 */

const ACCOUNT = "backoff-fixture";
const START = 1_800_000_000_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

function makeConfig(): OcxConfig {
  return {
    port: 0,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    activeCodexAccountId: ACCOUNT,
    accountPoolStrategy: "fill-first",
    codexAccounts: [{ id: ACCOUNT, email: "backoff@example.test", plan: "team", isMain: false }],
  } as OcxConfig;
}

/** A denial that carries no upstream directive — the path that falls through to the ladder. */
function deny(config: OcxConfig, now: number): void {
  recordCodexUpstreamOutcome(config, ACCOUNT, 429, { fixedAccount: true, now });
}

function cooldownMs(now: number): number {
  const snapshot = getCodexQuotaHealthSnapshot(ACCOUNT, undefined, now);
  if (!snapshot?.cooldownUntil) throw new Error("expected an active cooldown");
  return snapshot.cooldownUntil - now;
}

describe("quota cooldown backoff", () => {
  beforeEach(() => {
    clearCodexUpstreamHealth();
    clearAccountQuota(ACCOUNT);
  });
  afterEach(() => {
    clearCodexUpstreamHealth();
    clearAccountQuota(ACCOUNT);
  });

  test("an exhausted weekly window is held to its own reset, not the 15-minute reset cap", () => {
    const config = makeConfig();
    setAccountQuotaFromParsed(ACCOUNT, {
      weeklyPercent: 100,
      // Seconds, as the upstream snapshot stores them, and days out — the shape that used to be
      // clamped to 15 minutes.
      weeklyResetAt: Math.floor((START + 6 * 24 * 60 * 60_000) / 1000),
    });

    deny(config, START);

    const snapshot = getCodexQuotaHealthSnapshot(ACCOUNT, undefined, START + 1);
    expect(snapshot?.cooldownSource).toBe("window-exhausted");
    // Capped at the generic 24h ceiling rather than the announced six days, but nowhere near the
    // old 15-minute ceiling that produced the drumbeat.
    expect(cooldownMs(START)).toBe(24 * 60 * 60_000);
  });

  test("a weekly window below 100% is untouched — the burst path keeps its 15-minute cap", () => {
    const config = makeConfig();
    setAccountQuotaFromParsed(ACCOUNT, {
      weeklyPercent: 73,
      weeklyResetAt: Math.floor((START + WEEK_MS) / 1000),
    });

    recordCodexUpstreamOutcome(config, ACCOUNT, 429, {
      fixedAccount: true,
      now: START,
      resetAt: START + 60 * 60_000,
    });

    const snapshot = getCodexQuotaHealthSnapshot(ACCOUNT, undefined, START + 1);
    expect(snapshot?.cooldownSource).toBe("reset-derived");
    expect(cooldownMs(START)).toBe(15 * 60_000);
  });

  test("repeated denials escalate instead of re-opening every minute", () => {
    const config = makeConfig();
    const steps = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
    let now = START;

    for (const expected of steps) {
      deny(config, now);
      expect(cooldownMs(now)).toBe(expected);
      // Let this cooldown lapse so the next denial is genuinely new evidence.
      now += expected + 1;
    }

    // The ladder saturates rather than growing without bound.
    deny(config, now);
    expect(cooldownMs(now)).toBe(30 * 60_000);
  });

  test("concurrent denials inside one live cooldown do not climb the ladder", () => {
    const config = makeConfig();
    deny(config, START);
    expect(cooldownMs(START)).toBe(60_000);

    // A burst of callers hitting the same wall a few milliseconds apart is ONE piece of evidence,
    // not five. Without this guard a busy moment would jump straight to the 30-minute step and
    // strand an account that was only briefly throttled.
    for (let i = 1; i <= 5; i += 1) deny(config, START + i);
    expect(cooldownMs(START + 5)).toBe(60_000 - 5);

    // Once the cooldown has lapsed, the next denial is new evidence and does advance.
    const after = START + 60_002;
    deny(config, after);
    expect(cooldownMs(after)).toBe(2 * 60_000);
  });

  test("reaching upstream again resets the ladder", () => {
    const config = makeConfig();
    let now = START;
    for (const expected of [60_000, 2 * 60_000]) {
      deny(config, now);
      expect(cooldownMs(now)).toBe(expected);
      now += expected + 1;
    }

    // A success is the evidence that quota freed up; the next unrelated denial must start over
    // rather than inherit a 5-minute step.
    recordCodexUpstreamOutcome(config, ACCOUNT, 200, { fixedAccount: true, now });
    now += 1;

    deny(config, now);
    expect(cooldownMs(now)).toBe(60_000);
  });

  test("an explicit Retry-After still wins over both the window check and the ladder", () => {
    const config = makeConfig();
    setAccountQuotaFromParsed(ACCOUNT, {
      weeklyPercent: 100,
      weeklyResetAt: Math.floor((START + WEEK_MS) / 1000),
    });

    recordCodexUpstreamOutcome(config, ACCOUNT, 429, {
      fixedAccount: true,
      now: START,
      retryAfter: "90",
    });

    const snapshot = getCodexQuotaHealthSnapshot(ACCOUNT, undefined, START + 1);
    expect(snapshot?.cooldownSource).toBe("retry-after");
    expect(cooldownMs(START)).toBe(90_000);
  });

  test("a spent burst window alone does not trigger the long-window hold", () => {
    const config = makeConfig();
    // 5-hour burst at 100% with the weekly still healthy: this is the case that really does free
    // up on its own, so it must keep the short cooldown.
    setAccountQuotaFromParsed(ACCOUNT, {
      shortPercent: 100,
      shortResetAt: Math.floor((START + 4 * 60 * 60_000) / 1000),
      weeklyPercent: 70,
      weeklyResetAt: Math.floor((START + WEEK_MS) / 1000),
    });

    deny(config, START);

    const snapshot = getCodexQuotaHealthSnapshot(ACCOUNT, undefined, START + 1);
    expect(snapshot?.cooldownSource).toBe("default");
    expect(cooldownMs(START)).toBe(60_000);
  });

  test("an already-elapsed weekly reset does not strand the account", () => {
    const config = makeConfig();
    // A stale snapshot still reading 100% after its window rolled over must not produce a hold.
    setAccountQuotaFromParsed(ACCOUNT, {
      weeklyPercent: 100,
      weeklyResetAt: Math.floor((START - 60_000) / 1000),
    });

    deny(config, START);

    const snapshot = getCodexQuotaHealthSnapshot(ACCOUNT, undefined, START + 1);
    expect(snapshot?.cooldownSource).toBe("default");
    expect(cooldownMs(START)).toBe(60_000);
  });

  test("no stored quota at all falls through to the ladder", () => {
    const config = makeConfig();
    deny(config, START);
    const snapshot = getCodexQuotaHealthSnapshot(ACCOUNT, undefined, START + 1);
    expect(snapshot?.cooldownSource).toBe("default");
    expect(cooldownMs(START)).toBe(60_000);
  });
});
