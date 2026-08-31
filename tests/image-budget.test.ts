import { describe, expect, test } from "bun:test";
import { capConversationImages, DROPPED_IMAGE_NOTE } from "../src/responses/image-budget";

/** A base64 data URL of roughly `mb` megabytes, matching what codex embeds for a screenshot. */
function image(mb: number): Record<string, unknown> {
  return { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(Math.round(mb * 1e6))}` };
}

function toolResult(...parts: unknown[]): Record<string, unknown> {
  return { type: "custom_tool_call_output", output: parts };
}

function message(...parts: unknown[]): Record<string, unknown> {
  return { type: "message", role: "user", content: parts };
}

function countImages(body: unknown): number {
  let n = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== "object") return;
    const rec = v as Record<string, unknown>;
    if (rec.type === "input_image") n += 1;
    for (const key of ["content", "output", "input"]) walk(rec[key]);
  };
  walk(body);
  return n;
}

describe("conversation image budget", () => {
  // The incident this exists for: a slide-review conversation accumulated screenshots until every
  // request tore mid-stream. Measured that day — windows with repeated tears carried 13-27MB of
  // images; windows with none carried 0MB; the healthy all-day control sat at 6.0MB.
  test("caps a slide-review conversation that grew past the budget", () => {
    const body = {
      input: [
        toolResult({ type: "input_text", text: "S01 표지" }, image(7)),
        toolResult({ type: "input_text", text: "S02 목차" }, image(7)),
        toolResult({ type: "input_text", text: "S03 개요" }, image(7)),
        toolResult({ type: "input_text", text: "S04 실적" }, image(7)),
      ],
    };
    const before = countImages(body);
    const res = capConversationImages(body, { budgetBytes: 8_000_000, keepRecent: 1 });

    expect(before).toBe(4);
    expect(res.dropped).toBeGreaterThan(0);
    expect(countImages(res.body)).toBeLessThan(before);
    expect(res.reclaimed).toBeGreaterThan(7_000_000);
  });

  test("keeps the newest screenshots — the model just took them to look at something", () => {
    const body = {
      input: [toolResult(image(7)), toolResult(image(7)), toolResult(image(7))],
    };
    capConversationImages(body, { budgetBytes: 1_000, keepRecent: 2 });

    const survivors = (body.input as Record<string, unknown>[])
      .map(item => (item.output as unknown[])[0] as Record<string, unknown>);
    expect(survivors[0].type).toBe("input_text");   // oldest dropped
    expect(survivors[1].type).toBe("input_image");  // newest two kept
    expect(survivors[2].type).toBe("input_image");
  });

  test("a dropped image leaves a note so the model can re-capture", () => {
    const body = { input: [toolResult(image(7)), toolResult(image(7))] };
    capConversationImages(body, { budgetBytes: 1_000, keepRecent: 1 });

    const first = (body.input[0].output as Record<string, unknown>[])[0];
    expect(first.type).toBe("input_text");
    expect(first.text).toBe(DROPPED_IMAGE_NOTE);
  });

  // The healthy control ran all day at 6.0MB. If the budget touched that traffic it would be
  // degrading working conversations to fix broken ones.
  test("leaves a healthy conversation untouched", () => {
    const body = { input: [toolResult(image(3)), toolResult(image(3))] };
    const res = capConversationImages(body, { budgetBytes: 8_000_000, keepRecent: 3 });

    expect(res.dropped).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.body).toBe(body);          // same reference — nothing allocated
    expect(countImages(body)).toBe(2);
  });

  test("finds images in message content, not just tool results", () => {
    const body = { input: [message(image(7)), message(image(7))] };
    const res = capConversationImages(body, { budgetBytes: 1_000, keepRecent: 1 });

    expect(res.dropped).toBe(1);
  });

  test("handles chat-style nested image_url objects", () => {
    const nested = {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${"A".repeat(7_000_000)}` },
    };
    const body = { input: [message(nested), message(image(7))] };
    const res = capConversationImages(body, { budgetBytes: 1_000, keepRecent: 1 });

    expect(res.dropped).toBe(1);
  });

  test("disabled by budget 0", () => {
    const body = { input: [toolResult(image(7)), toolResult(image(7))] };
    const res = capConversationImages(body, { budgetBytes: 0 });

    expect(res.dropped).toBe(0);
    expect(countImages(body)).toBe(2);
  });

  test("ignores bodies with no images and malformed shapes", () => {
    for (const body of [
      { input: [message({ type: "input_text", text: "hello" })] },
      { input: [] },
      { input: "not an array" },
      {},
      null,
      "string body",
    ] as unknown[]) {
      const res = capConversationImages(body, { budgetBytes: 1_000 });
      expect(res.dropped).toBe(0);
      expect(res.body).toBe(body);
    }
  });

  test("text is never dropped — only images", () => {
    const body = {
      input: [
        toolResult({ type: "input_text", text: "S01 표지" }, image(7)),
        toolResult({ type: "input_text", text: "S02 목차" }, image(7)),
      ],
    };
    capConversationImages(body, { budgetBytes: 1_000, keepRecent: 1 });

    const texts = (body.input as Record<string, unknown>[])
      .map(item => ((item.output as Record<string, unknown>[])[0]).text);
    expect(texts).toEqual(["S01 표지", "S02 목차"]);
  });
});
