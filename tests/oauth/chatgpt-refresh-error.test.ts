import { afterEach, describe, expect, test } from "bun:test";
import { ChatGPTRefreshError, oauthErrorCode, refreshChatGPTToken } from "../../src/oauth/chatgpt";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubTokenEndpoint(status: number, body: unknown): void {
  globalThis.fetch = (async () => Response.json(body, { status })) as typeof fetch;
}

describe("refreshChatGPTToken failures", () => {
  test("incident: a nested error body keeps its code instead of collapsing to [object Object]", async () => {
    stubTokenEndpoint(401, { error: { code: "invalid_grant", message: "refresh token has been rotated" } });
    const error = await refreshChatGPTToken("rt").catch(e => e);
    expect(error).toBeInstanceOf(ChatGPTRefreshError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("invalid_grant");
    expect(error.message).toBe("ChatGPT refresh failed: 401 invalid_grant: refresh token has been rotated");
    expect(error.message).not.toContain("[object Object]");
  });

  test("a bare OAuth error string is the code", async () => {
    stubTokenEndpoint(400, { error: "invalid_grant" });
    const error = await refreshChatGPTToken("rt").catch(e => e);
    expect(error.code).toBe("invalid_grant");
    expect(error.message).toBe("ChatGPT refresh failed: 400 invalid_grant");
  });

  test("a 5xx without a code reports the status only", async () => {
    stubTokenEndpoint(503, "not json");
    const error = await refreshChatGPTToken("rt").catch(e => e);
    expect(error.status).toBe(503);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("ChatGPT refresh failed: 503 HTTP 503");
  });

  test("oauthErrorCode reads string and nested shapes only", () => {
    expect(oauthErrorCode({ error: "invalid_grant" })).toBe("invalid_grant");
    expect(oauthErrorCode({ error: { code: " invalid_grant " } })).toBe("invalid_grant");
    expect(oauthErrorCode({ error: { message: "no code" } })).toBeUndefined();
    expect(oauthErrorCode(undefined)).toBeUndefined();
  });
});
