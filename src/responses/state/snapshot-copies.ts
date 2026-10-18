import { windowsSecretAclApplies } from "../../lib/windows-secret-acl";
import { deleteResponseSpill, writeResponseSpillDurably, type ResponseSpillRef } from "../spill-store";
import type { ResidentResponseState, StoredResponseState } from "../state";
import { selectSnapshotEntries } from "./snapshot-select";

/**
 * Write-once spill copies for the resident rows of `responses-state.json` (OPS-1663).
 *
 * The snapshot is replaced in full on every flush, and the resident payloads are almost all of
 * it: measured on one macOS host on 2026-10-18, 67 resident rows (p50 330 KB, max 1.5 MB) were
 * 23 MB of a 23.3 MB file, against 533 spill stubs at 0.19 MB. Each flush therefore rewrote the
 * same 23 MB to add the one or two rows that were actually new — about 46 MB a minute at the
 * 30 s debounce ceiling, for state nothing reads until the next start.
 *
 * A selected resident whose row is larger than SNAPSHOT_INLINE_RESIDENT_MAX_BYTES is written
 * once to the spill directory, and the snapshot carries the ordinary `kind: "spill"` stub that
 * already exists for demoted entries. Later flushes reuse that file for as long as the map holds
 * the same resident object, so the per-flush rewrite shrinks to stubs plus small rows, and each
 * large row costs one write over its lifetime.
 *
 * What does not change:
 * - Selection. `selectSnapshotEntries` still prices residents at their full size against
 *   SNAPSHOT_TOTAL_MAX_BYTES and the 2 MiB per-entry bound, so the set a restart restores is the
 *   same set as before, and the copies themselves stay inside that 24 MiB budget.
 * - The format. A copy row is a version-2 spill stub that every loader already reads, so an
 *   old snapshot loads unchanged here and a rollback reads this one. After a restart the row is
 *   a spill entry that owns its file, exactly like a demoted entry.
 * - Crash order (review C1-1). A copy is unlinked only after a snapshot that no longer names it
 *   has been written; a crash before that reloads the previous snapshot, whose file is still on
 *   disk. A crash after a copy is written but before a snapshot names it leaves an orphan for
 *   `recoverOrphanedResponseSpills`; the live process lists every copy as owned so its own
 *   sweep never takes one.
 *
 * Copies are not priced against MAX_SPILLED_RESPONSE_BYTES: the snapshot budget bounds them, as
 * it bounded the same bytes when they lived inside `responses-state.json`. Windows keeps the
 * inline rows, because a synchronous spill write there waits on `icacls`.
 */
export const SNAPSHOT_INLINE_RESIDENT_MAX_BYTES = 64 * 1024;

/**
 * Bound on new copy bytes one snapshot pass writes. The spill write is synchronous; the first
 * flush after an upgrade would otherwise copy the whole resident cohort (up to 24 MiB) in one
 * event-loop turn. Rows past the budget stay inline for that pass and are copied by a later one.
 */
export const SNAPSHOT_COPY_WRITE_BUDGET_BYTES = 8 * 1024 * 1024;

interface SnapshotCopy {
  id: string;
  ref: ResponseSpillRef;
}

/** Every copy file this process owns, keyed by file name. Holds no payload. */
const copiesByFileName = new Map<string, SnapshotCopy>();
/** Identity index: a copy is valid only for the resident object it was written from. */
let copyByEntry = new WeakMap<ResidentResponseState, SnapshotCopy>();
let inlineCapOverride: number | null = null;
let copyWritesForTests = 0;

function inlineCap(): number {
  return inlineCapOverride ?? SNAPSHOT_INLINE_RESIDENT_MAX_BYTES;
}

/** Test-only: change/restore the inline row bound (Infinity keeps every resident inline). */
export function setSnapshotInlineResidentCapForTests(bytes: number | null): void {
  inlineCapOverride = bytes;
}

/** Test-only: number of copy files written since the last reset. */
export function snapshotCopyWritesForTests(): number {
  return copyWritesForTests;
}

function liveCopyFor(id: string, entry: ResidentResponseState): SnapshotCopy | undefined {
  const copy = copyByEntry.get(entry);
  if (!copy || copy.id !== id || copiesByFileName.get(copy.ref.fileName) !== copy) return undefined;
  return copy;
}

function writeCopy(id: string, entry: ResidentResponseState): SnapshotCopy | undefined {
  try {
    const ref = writeResponseSpillDurably(id, {
      createdAt: entry.createdAt,
      ...(entry.clientThreadId ? { clientThreadId: entry.clientThreadId } : {}),
      items: entry.items,
      ...(entry.providerOutputStart !== undefined ? { providerOutputStart: entry.providerOutputStart } : {}),
      ...(entry.providers ? { providers: entry.providers } : {}),
    });
    const copy: SnapshotCopy = { id, ref };
    copiesByFileName.set(ref.fileName, copy);
    copyByEntry.set(entry, copy);
    copyWritesForTests += 1;
    return copy;
  } catch {
    // The row stays inline: the snapshot keeps exactly what it would have held before.
    return undefined;
  }
}

function stubRow(id: string, entry: ResidentResponseState, ref: ResponseSpillRef): [string, unknown] {
  return [id, {
    kind: "spill",
    createdAt: entry.createdAt,
    ...(entry.clientThreadId ? { clientThreadId: entry.clientThreadId } : {}),
    ...(entry.providerOutputStart !== undefined ? { providerOutputStart: entry.providerOutputStart } : {}),
    ...(entry.providers ? { providers: entry.providers } : {}),
    spill: ref,
  }];
}

/**
 * `selectSnapshotEntries`, with each selected large resident row replaced by a stub for its
 * write-once copy. `referenced` is the set of copy files the returned rows name; pass it to
 * `releaseUnreferencedSnapshotCopies` once a snapshot built from these rows is on disk.
 */
export function selectPersistedSnapshotEntries(
  states: ReadonlyMap<string, StoredResponseState>,
  totalMaxBytes: number,
  residentEntryMaxBytes: number,
): { entries: Array<[string, unknown]>; referenced: Set<string> } {
  const selected = selectSnapshotEntries(states, totalMaxBytes, residentEntryMaxBytes);
  const referenced = new Set<string>();
  if (windowsSecretAclApplies()) return { entries: selected, referenced };
  let budget = SNAPSHOT_COPY_WRITE_BUDGET_BYTES;
  const entries = selected.map((row): [string, unknown] => {
    const [id] = row;
    const state = states.get(id);
    if (state?.kind !== "resident" || state.sizeBytes <= inlineCap()) return row;
    let copy = liveCopyFor(id, state);
    if (!copy && budget >= state.sizeBytes) {
      copy = writeCopy(id, state);
      if (copy) budget -= copy.ref.payloadBytes;
    }
    if (!copy) return row;
    referenced.add(copy.ref.fileName);
    return stubRow(id, state, copy.ref);
  });
  return { entries, referenced };
}

/**
 * Unlink every copy the snapshot now on disk does not name. Call only after that snapshot was
 * written (or verified byte-identical): until then the previous snapshot may still name them.
 */
export function releaseUnreferencedSnapshotCopies(referenced: ReadonlySet<string>): void {
  for (const [fileName, copy] of copiesByFileName) {
    if (referenced.has(fileName)) continue;
    copiesByFileName.delete(fileName);
    deleteResponseSpill(copy.ref);
  }
}

/** File names the orphan sweep must treat as owned. */
export function snapshotCopyFileNames(): IterableIterator<string> {
  return copiesByFileName.keys();
}

/** Memory-only reset (a simulated restart): the files stay for the reload or the orphan sweep. */
export function resetSnapshotCopiesForTests(): void {
  copiesByFileName.clear();
  copyByEntry = new WeakMap();
  copyWritesForTests = 0;
}
