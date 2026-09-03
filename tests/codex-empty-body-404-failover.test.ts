import { describe, expect, test } from "bun:test";
import { shouldRetryCodexPoolEmptyBody404 } from "../src/server/responses/core";

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
