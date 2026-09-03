import { describe, expect, test } from "bun:test";
import {
  shouldRetryCodexPoolEmptyBody404,
  shouldRetryCodexPoolQuotaBehind5xx,
} from "../src/server/responses/core";

/**
 * 2026-09-04 incident, Paseo window 5e4c9796.
 *
 * Every turn after 23:43:52 came back `404` in 68-116ms with an empty body, while a fresh
 * conversation on the same account and model returned 200 (a 663KB body did too). Codex pins
 * a thread to one pool account, and the pool failover only covered 400 (account-model) and
 * quota, so the 404 fell straight through: the window was marked `error` and could never
 * answer again. The representative typed "계속해" into a dead window and got the same 404
 * every time.
 */
describe("empty-body 404 triggers one alternate-account attempt", () => {
  test("the incident response qualifies for failover", async () => {
    // What the upstream actually returned: status 404, zero bytes, no headers of substance.
    expect(await shouldRetryCodexPoolEmptyBody404(new Response(null, { status: 404 }))).toBe(true);
  });

  test("whitespace-only body counts as empty", async () => {
    expect(await shouldRetryCodexPoolEmptyBody404(new Response("\n  \n", { status: 404 }))).toBe(true);
  });

  test("a 404 that explains itself stays terminal", async () => {
    // Retrying these across the pool would burn every account to reach the same failure.
    const explained = Response.json({ error: { message: "The model `gpt-nope` does not exist" } }, { status: 404 });
    expect(await shouldRetryCodexPoolEmptyBody404(explained)).toBe(false);
  });

  test("other statuses are not this failure mode", async () => {
    for (const status of [200, 400, 402, 429, 500, 502, 503]) {
      expect(await shouldRetryCodexPoolEmptyBody404(new Response(null, { status }))).toBe(false);
    }
  });

  test("the response body stays readable for the caller", async () => {
    // The predicate clones before reading; the original must still reach the client, since a
    // failed failover has to surface the upstream error unchanged.
    const response = new Response("", { status: 404 });
    await shouldRetryCodexPoolEmptyBody404(response);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("");
  });

  test("an unreadable body does not throw", async () => {
    const broken = new Response(
      new ReadableStream({ start(controller) { controller.error(new Error("boom")); } }),
      { status: 404 },
    );
    expect(await shouldRetryCodexPoolEmptyBody404(broken)).toBe(false);
  });
});

/**
 * Measured over 9 days of the usage ledger (2026-08-26 .. 2026-09-04): 851 requests ended in
 * a terminal 502, and 387 of them carried "The usage limit has been reached". The account was
 * out of quota, but the status said gateway error, so no quota machinery ran and the other
 * account sat idle. That silent mismatch is the bulk of "코덱스가 맨날 오류난다".
 */
describe("quota refusals hiding behind a 5xx reach the quota failover", () => {
  test("the measured incident body qualifies", async () => {
    const measured = new Response("The usage limit has been reached", { status: 502 });
    expect(await shouldRetryCodexPoolQuotaBehind5xx(measured)).toBe(true);
  });

  test("the same refusal wrapped in JSON qualifies", async () => {
    const wrapped = Response.json(
      { error: { message: "The usage limit has been reached. Try again later." } },
      { status: 503 },
    );
    expect(await shouldRetryCodexPoolQuotaBehind5xx(wrapped)).toBe(true);
  });

  test("a genuine gateway hiccup stays a retryable transient, not a quota hop", async () => {
    // Overload is what the transient-5xx retry is for; hopping accounts would waste the pool.
    const overloaded = new Response("Our servers are currently overloaded. Please try again later.", { status: 502 });
    expect(await shouldRetryCodexPoolQuotaBehind5xx(overloaded)).toBe(false);
  });

  test("an empty 502 is not treated as quota", async () => {
    expect(await shouldRetryCodexPoolQuotaBehind5xx(new Response(null, { status: 502 }))).toBe(false);
  });

  test("non-5xx statuses are handled by the existing quota predicate", async () => {
    for (const status of [200, 402, 404, 429]) {
      const r = new Response("The usage limit has been reached", { status });
      expect(await shouldRetryCodexPoolQuotaBehind5xx(r)).toBe(false);
    }
  });

  test("the body stays readable for the caller", async () => {
    const response = new Response("The usage limit has been reached", { status: 502 });
    await shouldRetryCodexPoolQuotaBehind5xx(response);
    expect(response.bodyUsed).toBe(false);
  });
});
