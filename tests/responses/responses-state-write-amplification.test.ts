/**
 * #2460 — `responses-state.json` was rewritten in full on a fixed 2 s debounce.
 *
 * The snapshot is bounded at 24 MiB, so under sustained traffic every debounce
 * paid a complete re-serialization plus an atomic replacement of a file nothing
 * reads until the next start. Two narrow measures are covered here: a
 * byte-identical payload is not rewritten, and the debounce scales with the size
 * of the snapshot actually being written.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  rememberResponseState,
  responseStateMetrics,
  setResponseStateByteCapForTests,
  sweepOrphanedResponseSpills,
} from "../../src/responses/state";
import { responseSpillDirectory, setSpillIoForTest } from "../../src/responses/spill-store";
import {
  SNAPSHOT_INLINE_RESIDENT_MAX_BYTES,
  setSnapshotInlineResidentCapForTests,
  snapshotCopyWritesForTests,
} from "../../src/responses/state/snapshot-copies";
import { setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function remember(id: string, text: string): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    { id, output: [{ type: "message", role: "assistant", content: text }], status: "completed" },
    undefined,
    { force: true },
  );
}

describe("responses-state snapshot write amplification (#2460)", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];
  let snapshot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-amp-"));
    process.env["OPENCODEX_HOME"] = home;
    snapshot = join(home, "responses-state.json");
    clearResponseStateMemoryForTests();
  });

  afterEach(() => {
    setResponseStateByteCapForTests(null);
    setSnapshotInlineResidentCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  /** Record the delay the store hands to setTimeout when it schedules its next write. */
  function scheduledDelay(schedule: () => void): number {
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return (realSetTimeout as (...a: unknown[]) => unknown)(handler, ms, ...rest);
    }) as unknown as typeof setTimeout;
    try {
      schedule();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(delays).toHaveLength(1);
    return delays[0]!;
  }

  /** Backdate the snapshot so "was it rewritten?" is a mtime comparison, not a clock race. */
  function backdate(): number {
    const past = new Date(Date.now() - 60_000);
    utimesSync(snapshot, past, past);
    return statSync(snapshot).mtimeMs;
  }

  test("a flush that would reproduce the same bytes does not rewrite the file", async () => {
    remember("resp_amp_small", "kept");
    await flushResponseState();
    expect(existsSync(snapshot)).toBe(true);
    const before = backdate();

    // An entry past the 2 MiB per-entry bound is dropped from the selection, so
    // recording it mutates state without changing a single persisted byte.
    remember("resp_amp_oversized", "x".repeat(3 * 1024 * 1024));
    await flushResponseState();

    expect(statSync(snapshot).mtimeMs).toBe(before);
  });

  test("a flush that changes the payload still rewrites the file", async () => {
    remember("resp_amp_first", "first");
    await flushResponseState();
    const before = backdate();

    remember("resp_amp_second", "second");
    await flushResponseState();

    expect(statSync(snapshot).mtimeMs).toBeGreaterThan(before);
  });

  test("a snapshot deleted underneath us is rewritten even when the payload matches", async () => {
    remember("resp_amp_restore", "kept");
    await flushResponseState();
    rmSync(snapshot, { force: true });

    remember("resp_amp_oversized_2", "y".repeat(3 * 1024 * 1024));
    await flushResponseState();

    expect(existsSync(snapshot)).toBe(true);
  });

  // Deletion is the easy half. The cached digest describes what THIS process last
  // wrote, which is not the same claim as "that is what is on disk now" — a second
  // proxy sharing the home, or anything rewriting the file in place, leaves the
  // digest describing bytes that are gone. Before the skip existed, every flush
  // rewrote and so repaired that silently; skipping on the digest alone would turn
  // a self-healing snapshot into a permanently corrupt one, discovered only at the
  // next restart when the continuation state fails to load.
  //
  // Same-length replacement is the case that defeats a size-only check, so that is
  // what this drives.
  test("a snapshot replaced with different bytes of the same length is rewritten", async () => {
    remember("resp_amp_replaced", "kept");
    await flushResponseState();

    const original = readFileSync(snapshot, "utf-8");
    writeFileSync(snapshot, "X".repeat(Buffer.byteLength(original, "utf8")));

    // A mutation whose bounded payload is byte-identical to the last write: the
    // oversized entry is dropped by the per-entry bound, so the digest still matches.
    remember("resp_amp_replaced_oversized", "y".repeat(3 * 1024 * 1024));
    await flushResponseState();

    expect(readFileSync(snapshot, "utf-8")).toBe(original);
  });

  // Content is not the whole invariant. This file holds persisted request and response
  // bodies and is written owner-only; the unconditional rewrite used to restore that on
  // every mutation. Skipping on content alone would let a widened mode persist for the
  // life of the process, which is a durable privacy regression rather than a slow one.
  test.skipIf(process.platform === "win32")("a snapshot whose mode was broadened is rewritten and re-hardened", async () => {
    remember("resp_amp_perm", "sensitive");
    await flushResponseState();
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);

    chmodSync(snapshot, 0o644);

    // Same trick as above: the oversized entry is dropped by the per-entry bound, so
    // the bounded payload is byte-identical and only the mode differs.
    remember("resp_amp_perm_oversized", "y".repeat(3 * 1024 * 1024));
    await flushResponseState();

    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
  });

  test("the scheduled debounce stays at its base value for a small snapshot", async () => {
    remember("resp_amp_tiny", "tiny");
    await flushResponseState();

    const delay = scheduledDelay(() => remember("resp_amp_tiny_2", "tiny"));
    await flushResponseState();

    expect(delay).toBe(2_000);
  });

  // The debounce scales with the bytes the snapshot really rewrites. Large resident rows now
  // leave the file as write-once copies (OPS-1663), so these two cases pin every row inline —
  // the shape Windows and a failed copy write still produce — to keep the scaling rule covered.
  test("the scheduled debounce stretches once the snapshot is large", async () => {
    setSnapshotInlineResidentCapForTests(Number.POSITIVE_INFINITY);
    // Four ~800 KiB entries: each under the 2 MiB per-entry bound, so all four are
    // persisted and the payload lands well past the 1 MiB scaling threshold.
    for (let i = 0; i < 4; i += 1) remember(`resp_amp_big_${i}`, "z".repeat(800 * 1024));
    await flushResponseState();

    const delay = scheduledDelay(() => remember("resp_amp_big_next", "next"));
    await flushResponseState();

    expect(delay).toBeGreaterThan(2_000);
    expect(delay).toBeLessThanOrEqual(30_000);
    // Roughly proportional to size: ~3.2 MiB of payload is ~6 s, not ~2 s.
    expect(delay).toBeGreaterThanOrEqual(5_000);
  });

  // The ceiling is the half of the scaling rule that a proportional formula gets
  // wrong silently: `<= 30_000` passes for any well-behaved input, so it proves
  // the clamp exists only when something actually reaches it. A snapshot at the
  // byte cap is the case that does.
  test("the scheduled debounce clamps to exactly 30s at the snapshot cap", async () => {
    setSnapshotInlineResidentCapForTests(Number.POSITIVE_INFINITY);
    // The scaling rule is 2s per MiB, so a payload at or past 15 MiB computes above
    // the ceiling. 900 KB of text per entry matters: the entry is serialized with the
    // input echoed alongside the output, so ~1.5 MB of text lands past the 2 MiB
    // per-entry bound and is skipped entirely, leaving an empty snapshot.
    for (let i = 0; i < 20; i += 1) remember(`resp_amp_cap_${i}`, "c".repeat(900 * 1024));
    await flushResponseState();
    // Guard the premise: if the snapshot did not actually get large, a passing
    // clamp assertion below would be proving nothing.
    expect(statSync(snapshot).size).toBeGreaterThan(15 * 1024 * 1024);

    const delay = scheduledDelay(() => remember("resp_amp_cap_next", "next"));
    await flushResponseState();

    expect(delay).toBe(30_000);
  });

  // Shutdown is the one moment the debounce must not apply: a pending write that
  // waits out a 30s timer during a graceful stop is a lost turn, and the longer
  // the debounce grows the more there is to lose. The existing tests all flush
  // immediately after each change, so none of them proves the pending case.
  test("a graceful flush writes changes still sitting behind the debounce", async () => {
    remember("resp_amp_drain_seed", "seed");
    await flushResponseState();

    // Two changes with NO flush between them: the debounce timer is pending and
    // neither has reached disk when the graceful flush arrives.
    remember("resp_amp_drain_late", "late");
    remember("resp_amp_drain_late2", "late2");

    await flushResponseState();

    const parsed = JSON.parse(await Bun.file(snapshot).text()) as {
      states: [string, Record<string, unknown>][];
    };
    const ids = parsed.states.map(([id]) => id);
    expect(ids).toContain("resp_amp_drain_late");
    expect(ids).toContain("resp_amp_drain_late2");
  });

  test("the snapshot still round-trips after a skipped write", async () => {
    remember("resp_amp_roundtrip", "payload");
    await flushResponseState();
    remember("resp_amp_roundtrip_oversized", "w".repeat(3 * 1024 * 1024));
    await flushResponseState();

    const parsed = JSON.parse(await Bun.file(snapshot).text()) as {
      version: number;
      states: [string, Record<string, unknown>][];
    };
    expect(parsed.version).toBe(2);
    expect(parsed.states.map(([id]) => id)).toContain("resp_amp_roundtrip");
  });
});

/**
 * OPS-1663 — large resident rows are written once, not on every flush.
 *
 * Every flush replaced the whole snapshot, and resident payloads were nearly all of it, so one
 * new turn re-wrote every row the snapshot already held. Rows above the inline bound now move
 * to a write-once spill copy that the snapshot names through the existing stub row.
 */
describe("responses-state write-once resident copies (OPS-1663)", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];
  let snapshot: string;
  // ~300 KB rows: the text is echoed in input and output, and sits between the 64 KiB inline
  // bound and the 2 MiB per-entry bound, like the measured p50 resident row.
  const body = (tag: string): string => `${tag}:${"r".repeat(150 * 1024)}`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-copies-"));
    process.env["OPENCODEX_HOME"] = home;
    snapshot = join(home, "responses-state.json");
    clearResponseStateMemoryForTests();
    // The copy lane is the synchronous POSIX spill writer; Windows keeps rows inline.
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setPlatformForTests(null);
    setSpillIoForTest(null);
    setSnapshotInlineResidentCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  function spillFiles(): Map<string, number> {
    const dir = responseSpillDirectory();
    const files = new Map<string, number>();
    if (!existsSync(dir)) return files;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".spill.json")) files.set(name, statSync(join(dir, name)).size);
    }
    return files;
  }

  function snapshotRows(): [string, Record<string, unknown>][] {
    return (JSON.parse(readFileSync(snapshot, "utf8")) as { states: [string, Record<string, unknown>][] }).states;
  }

  function replayText(id: string): string {
    return JSON.stringify(expandPreviousResponseInput({ previous_response_id: id, input: "next" }));
  }

  /** Bytes one flush writes for one new turn on top of `seed` existing turns. */
  async function bytesWrittenForOneMoreTurn(seed: number): Promise<{ written: number; copies: number }> {
    for (let i = 0; i < seed; i += 1) remember(`resp_copy_seed_${i}`, body(`seed${i}`));
    await flushResponseState();
    const before = spillFiles();
    const copiesBefore = snapshotCopyWritesForTests();

    remember("resp_copy_next", body("next"));
    await flushResponseState();

    let written = statSync(snapshot).size;
    for (const [name, size] of spillFiles()) if (!before.has(name)) written += size;
    return { written, copies: snapshotCopyWritesForTests() - copiesBefore };
  }

  test("one new turn writes its own row once instead of re-writing every row", async () => {
    setSnapshotInlineResidentCapForTests(Number.POSITIVE_INFINITY);
    const inline = await bytesWrittenForOneMoreTurn(10);
    clearResponseStateForTests();
    setSnapshotInlineResidentCapForTests(null);
    const copied = await bytesWrittenForOneMoreTurn(10);

    // Premise: the inline path really re-wrote all eleven ~300 KB rows.
    expect(inline.written).toBeGreaterThan(11 * 300 * 1024);
    expect(inline.copies).toBe(0);
    // The copy path writes the new row once plus a stub-only snapshot.
    expect(copied.copies).toBe(1);
    expect(statSync(snapshot).size).toBeLessThan(SNAPSHOT_INLINE_RESIDENT_MAX_BYTES);
    expect(copied.written).toBeLessThan(inline.written / 8);
  });

  test("a flush with no new rows writes no copy and leaves the snapshot alone", async () => {
    for (let i = 0; i < 3; i += 1) remember(`resp_copy_idle_${i}`, body(`idle${i}`));
    await flushResponseState();
    expect(snapshotCopyWritesForTests()).toBe(3);
    const past = new Date(Date.now() - 60_000);
    utimesSync(snapshot, past, past);
    const mtime = statSync(snapshot).mtimeMs;

    // A row the selection drops (> 2 MiB) mutates state without changing the payload.
    remember("resp_copy_idle_oversized", "x".repeat(3 * 1024 * 1024));
    await flushResponseState();

    expect(snapshotCopyWritesForTests()).toBe(3);
    expect(statSync(snapshot).mtimeMs).toBe(mtime);
  });

  test("a restart restores every copied row from its stub", async () => {
    for (let i = 0; i < 4; i += 1) remember(`resp_copy_restart_${i}`, body(`restart${i}`));
    remember("resp_copy_restart_small", "small-row");
    await flushResponseState();

    const rows = new Map(snapshotRows());
    for (let i = 0; i < 4; i += 1) {
      const row = rows.get(`resp_copy_restart_${i}`);
      expect(row?.["kind"]).toBe("spill");
      expect(row?.["items"]).toBeUndefined();
      expect(row?.["providerOutputStart"]).toBe(1);
    }
    // Small rows stay inline.
    expect(rows.get("resp_copy_restart_small")?.["items"]).toBeDefined();

    clearResponseStateMemoryForTests();
    for (let i = 0; i < 4; i += 1) expect(replayText(`resp_copy_restart_${i}`)).toContain(`restart${i}:rrrr`);
    expect(replayText("resp_copy_restart_small")).toContain("small-row");
    expect(responseStateMetrics().spillStubCount).toBe(4);
  });

  /** Spill files the snapshot on disk names: what a crash right now would reload. */
  function namedSpillFiles(): string[] {
    return snapshotRows()
      .map(([, row]) => (row["kind"] === "spill" ? (row["spill"] as { fileName: string }).fileName : null))
      .filter((name): name is string => name !== null);
  }

  // Review C1-1 applied to copies: the snapshot on disk names the old copy until a newer
  // snapshot is written, so the old file must outlive the in-memory replacement.
  test("a replaced row keeps its old copy until a snapshot stops naming it", async () => {
    remember("resp_copy_replace", body("old"));
    await flushResponseState();
    const [oldCopy] = [...spillFiles().keys()];
    expect(oldCopy).toBeDefined();

    remember("resp_copy_replace", body("new"));
    expect(namedSpillFiles()).toEqual([oldCopy ?? ""]);
    expect(spillFiles().has(oldCopy ?? "")).toBe(true);

    await flushResponseState();
    const named = namedSpillFiles();
    expect(named).toHaveLength(1);
    expect(named[0]).not.toBe(oldCopy);
    // Released only now, and nothing else is left behind.
    expect([...spillFiles().keys()]).toEqual(named);
    clearResponseStateMemoryForTests();
    expect(replayText("resp_copy_replace")).toContain("new:rrrr");
  });

  // The release must follow a snapshot that is really on disk. If it ran before the write, a
  // failed write would leave the old snapshot naming a copy that is already gone.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a failed snapshot write keeps every copy the old snapshot names",
    async () => {
      remember("resp_copy_write_fail", body("old"));
      await flushResponseState();
      const [oldCopy] = [...spillFiles().keys()];
      // Route the snapshot through a symlink into a directory the writer cannot place temps in.
      const locked = join(home, "locked");
      mkdirSync(locked, { mode: 0o700 });
      renameSync(snapshot, join(locked, "responses-state.json"));
      symlinkSync(join(locked, "responses-state.json"), snapshot);
      chmodSync(locked, 0o500);
      try {
        remember("resp_copy_write_fail", body("new"));
        await flushResponseState();
      } finally {
        chmodSync(locked, 0o700);
      }

      expect(namedSpillFiles()).toEqual([oldCopy ?? ""]);
      expect(spillFiles().has(oldCopy ?? "")).toBe(true);
      clearResponseStateMemoryForTests();
      expect(replayText("resp_copy_write_fail")).toContain("old:rrrr");
    },
  );

  test("a crash between a replacement and the next snapshot restores the previous row", async () => {
    remember("resp_copy_crash", body("old"));
    await flushResponseState();
    remember("resp_copy_crash", body("new"));

    clearResponseStateMemoryForTests();

    expect(replayText("resp_copy_crash")).toContain("old:rrrr");
  });

  test("a snapshot written by the inline-only build loads and is converted on the next flush", async () => {
    // Exactly the row shape the previous build wrote for a resident: no kind, items inline.
    const items = [{ role: "user", content: body("legacy") }, { type: "message", role: "assistant", content: "done" }];
    writeFileSync(snapshot, JSON.stringify({
      version: 2,
      states: [["resp_copy_legacy", { createdAt: Date.now(), items, providerOutputStart: 1 }]],
    }), { mode: 0o600 });

    expect(replayText("resp_copy_legacy")).toContain("legacy:rrrr");
    remember("resp_copy_after_legacy", "small");
    await flushResponseState();

    const legacyRow = new Map(snapshotRows()).get("resp_copy_legacy");
    expect(legacyRow?.["kind"]).toBe("spill");
    clearResponseStateMemoryForTests();
    expect(replayText("resp_copy_legacy")).toContain("legacy:rrrr");
  });

  test("the orphan sweep never takes a live copy, however old its file", async () => {
    remember("resp_copy_sweep", body("sweep"));
    await flushResponseState();
    const [copy] = [...spillFiles().keys()];
    expect(copy).toBeDefined();
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(responseSpillDirectory(), copy ?? ""), old, old);

    sweepOrphanedResponseSpills();

    expect(spillFiles().has(copy ?? "")).toBe(true);
  });

  test("a failed copy write keeps the row inline, so the restart still restores it", async () => {
    setSpillIoForTest({ write: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } });
    remember("resp_copy_fail", body("fallback"));
    await flushResponseState();
    setSpillIoForTest(null);

    expect(new Map(snapshotRows()).get("resp_copy_fail")?.["items"]).toBeDefined();
    expect(spillFiles().size).toBe(0);
    clearResponseStateMemoryForTests();
    expect(replayText("resp_copy_fail")).toContain("fallback:rrrr");
  });
});
