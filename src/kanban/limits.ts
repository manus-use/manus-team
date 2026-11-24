/**
 * How big the parts of a task may be, wherever it is written: by a run's worker
 * CLI, in chat, or at the operator's terminal. A leaf module, importing nothing,
 * so the pure chat parser and the worker API share the numbers without the
 * parser loading the API.
 */

/**
 * `text` cut to at most `max` UTF-8 bytes, on a whole character: what a
 * writer that must never refuse for length keeps (wake spec §19.3).
 */
export function cutToBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max) break;
    bytes += n;
    end += ch.length;
  }
  return text.slice(0, end);
}

/** Sizes, in UTF-8 bytes, of what a worker may send; chat and the terminal keep to them too. */
export const WORKER_LIMITS = {
  title: 512,
  body: 64 * 1024,
  contractField: 8 * 1024,
  summary: 16 * 1024,
  /** Serialized. */
  metadata: 16 * 1024,
  reason: 8 * 1024,
  comment: 16 * 1024,
  /** Ids, names, kinds and keys. */
  name: 256,
  /** Parents named in one create or block. */
  parents: 50,
  /** Objects and lists inside one another in metadata, the outermost counted. */
  metadataDepth: 64,
} as const;
