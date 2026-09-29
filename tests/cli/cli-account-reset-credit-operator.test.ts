import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { cmdAccount, type AccountDeps } from "../../src/cli/account";
import type { AccountStdin } from "../../src/cli/account-api";

// No server or live proxy: this fixture refuses every mutating request.
const requests: string[] = [];
let stderr: string[] = [];
let errorSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  requests.length = 0;
  stderr = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args) => { stderr.push(args.map(String).join(" ")); });
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); logSpy.mockRestore(); });
function defaultDeps(): AccountDeps {
  return {
    baseUrl: "http://127.0.0.1:1",
    fetchImpl: (async (_input, init) => {
      const method = init?.method ?? "GET";
      requests.push(method);
      if (method !== "GET") throw new Error("Fixture refuses all mutations");
      return Response.json({ credits: [], available_count: 0 });
    }) as typeof fetch,
  };
}
function consumeRequests(): string[] {
  return requests.filter(method => method !== "GET");
}
async function run(args: string[], deps: AccountDeps) {
  const code = await cmdAccount(args, deps);
  return { code, stderr: stderr.join("\n") };
}
describe("reset credits require an operator terminal", () => {
    // 2026-09-23 incident: an AI agent ran `reset-credits <id> --consume --yes --json` from a
    // tool shell (no TTY) and spent a credit it had not been asked to spend.
    test("R7-f: a non-interactive caller cannot spend a credit, even with --yes", async () => {
      const piped = new PassThrough() as AccountStdin;
      piped.isTTY = false;
      const result = await run(
        ["reset-credits", "chatgpt-1786870895595", "--consume", "--yes", "--json"],
        { ...defaultDeps(), stdinImpl: piped },
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("interactive terminal");
      expect(consumeRequests()).toHaveLength(0);
    });

    test("R7-g: reading the credit list stays open to scripts", async () => {
      const piped = new PassThrough() as AccountStdin;
      piped.isTTY = false;
      const result = await run(["reset-credits", "main", "--json"], { ...defaultDeps(), stdinImpl: piped });

      expect(result.code).toBe(0);
      expect(consumeRequests()).toHaveLength(0);
    });
});
