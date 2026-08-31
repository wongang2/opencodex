/**
 * Conversation image budget for /responses requests.
 *
 * Codex embeds every browser screenshot in the conversation as a base64 PNG — one measured
 * `custom_tool_call_output` line was 7MB. Those images are replayed on EVERY later request, so a
 * task that renders and inspects screens (reviewing slides, checking a rendered page) grows the
 * outbound payload without bound until upstream tears the stream mid-response. The client sees
 * `stream disconnected before completion: ... codex websocket closed before a Responses terminal
 * event`, the window freezes, and retrying sends the same oversized payload again — so the
 * conversation stays dead. Moving the work to a fresh window does not help: the same task
 * re-accumulates screenshots and dies the same way.
 *
 * Measured 2026-08-31 across one day of real traffic. Every window with REPEATED tears was
 * image-heavy — 13.3MB→9 tears, 18.1MB→4, 18.7MB→2, 27.5MB cumulative→5. Every window carrying
 * 0MB of images tore exactly once (ordinary transient failures). The healthy control that ran
 * all day sat at 6.0MB.
 *
 * Token counts do not capture this: a 540k-token conversation stayed healthy while a 368k-token
 * one died. Images cost few tokens but many bytes, and neither local nor remote compaction strips
 * them — compaction rewrites reasoning and text, and the screenshots survive it.
 *
 * So we cap the images the request carries. Newest screenshots are what the model actually needs
 * (it just took them to look at something); the oldest ones are historical and safe to summarize
 * away. Each dropped image is replaced by a short text note so the model knows a screenshot was
 * there and can re-capture if it truly needs it.
 *
 * Defaults are deliberately loose — the healthy control was 6MB, so an 8MB budget never touches
 * normal work and only engages in the range where tearing was actually observed. Set
 * `OCX_IMAGE_BUDGET_BYTES=0` to disable.
 */

const DEFAULT_BUDGET_BYTES = 8_000_000;
const DEFAULT_KEEP_RECENT = 3;

/** Replaces a dropped image so the model knows what was there. */
export const DROPPED_IMAGE_NOTE =
  "[older screenshot omitted to keep this request within the upstream size limit — re-capture it if you still need to look at it]";

interface ImageSite {
  /** The content array holding the image part. */
  readonly parts: unknown[];
  /** Index of the image part inside `parts`. */
  readonly index: number;
  /** Approximate wire cost of this image in bytes. */
  readonly bytes: number;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Wire cost of one image part. base64 length dominates; anything else is noise. */
function imageBytes(part: Record<string, unknown>): number {
  const url = part.image_url;
  if (typeof url === "string") return url.length;
  // Chat-style parts nest the string one level deeper.
  if (isRec(url) && typeof url.url === "string") return url.url.length;
  return 0;
}

function isImagePart(part: unknown): part is Record<string, unknown> {
  if (!isRec(part)) return false;
  if (part.type === "input_image" || part.type === "image_url" || part.type === "image") return true;
  return false;
}

/**
 * Walk the request in wire order and collect every image part, so callers can drop the oldest.
 *
 * Images live in two shapes: message content (`input[].content[]`) and tool results
 * (`input[].output[]`). A screenshot returned by a tool lands in the second, which is exactly the
 * shape that grows during slide review — missing it would leave the whole feature inert.
 */
function collectImageSites(input: unknown[]): ImageSite[] {
  const sites: ImageSite[] = [];
  for (const item of input) {
    if (!isRec(item)) continue;
    for (const key of ["content", "output"] as const) {
      const parts = item[key];
      if (!Array.isArray(parts)) continue;
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (!isImagePart(part)) continue;
        sites.push({ parts, index: i, bytes: imageBytes(part) });
      }
    }
  }
  return sites;
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface ImageBudgetResult {
  readonly body: unknown;
  /** How many images were replaced by a note. */
  readonly dropped: number;
  /** Bytes reclaimed. */
  readonly reclaimed: number;
}

/**
 * Cap the total image payload a /responses request carries.
 *
 * Keeps the newest `keepRecent` images unconditionally (the model just took them), then keeps
 * older ones newest-first while they fit the budget. Everything beyond becomes a text note.
 * Returns the original body untouched when nothing needs dropping, so the common path allocates
 * nothing and cannot perturb a healthy request.
 */
export function capConversationImages(
  body: unknown,
  opts?: { budgetBytes?: number; keepRecent?: number },
): ImageBudgetResult {
  const budget = opts?.budgetBytes ?? readEnvInt("OCX_IMAGE_BUDGET_BYTES", DEFAULT_BUDGET_BYTES);
  const keepRecent = opts?.keepRecent ?? readEnvInt("OCX_IMAGE_KEEP_RECENT", DEFAULT_KEEP_RECENT);
  if (budget <= 0) return { body, dropped: 0, reclaimed: 0 };
  if (!isRec(body) || !Array.isArray(body.input)) return { body, dropped: 0, reclaimed: 0 };

  const sites = collectImageSites(body.input);
  if (sites.length === 0) return { body, dropped: 0, reclaimed: 0 };

  const total = sites.reduce((sum, s) => sum + s.bytes, 0);
  if (total <= budget) return { body, dropped: 0, reclaimed: 0 };

  // Decide newest-first, then drop what did not make the cut.
  const keep = new Set<ImageSite>();
  let used = 0;
  for (let i = sites.length - 1; i >= 0; i -= 1) {
    const site = sites[i];
    const isRecent = sites.length - 1 - i < keepRecent;
    if (isRecent || used + site.bytes <= budget) {
      keep.add(site);
      used += site.bytes;
    }
  }

  let dropped = 0;
  let reclaimed = 0;
  for (const site of sites) {
    if (keep.has(site)) continue;
    site.parts[site.index] = { type: "input_text", text: DROPPED_IMAGE_NOTE };
    dropped += 1;
    reclaimed += site.bytes;
  }
  return { body, dropped, reclaimed };
}
