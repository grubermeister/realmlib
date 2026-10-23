/**
 * Seeded, snapshot-restorable pseudorandom streams (xoshiro128** 1.1).
 *
 * Not cryptographically secure. Nothing is seeded implicitly: every stream
 * starts from an explicit seed or snapshot. A private draw scope (see
 * {@link beginRandomDraws}) lets an operation consume draws from a working
 * copy that is published to the stream only on success.
 */

/** JSON-compatible state of one stream; restoring it reproduces the next draws. */
export interface RandomSnapshot {
  readonly algorithm: "xoshiro128ss-v1";
  readonly words: readonly [number, number, number, number];
}

/** A source of draws only. */
export interface RandomSource {
  /** Returns a number in [0, 1) derived from exactly one 32-bit output. */
  nextFloat(): number;
}

/** A mutable stream: each direct `nextFloat()` call advances it immediately. */
export interface SeededRandom extends RandomSource {
  /** Returns a fresh copy of the stream's current state. */
  snapshot(): RandomSnapshot;
}

const ALGORITHM = "xoshiro128ss-v1";
const MAX_UINT32 = 0xffff_ffff;
const TWO_POW_32 = 0x1_0000_0000;

type Words = [number, number, number, number];

/** Private mutable state of a stream. `words` is replaced, never shared. */
interface StreamState {
  words: Words;
  /** `true` while an operation's draw scope holds the stream. */
  busy: boolean;
}

const stateByStream = new WeakMap<SeededRandom, StreamState>();

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Advances `s` in place and returns the next unsigned 32-bit output. */
function nextUint32(s: Words): number {
  const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] = (s[2] ^ s[0]) >>> 0;
  s[3] = (s[3] ^ s[1]) >>> 0;
  s[1] = (s[1] ^ s[2]) >>> 0;
  s[0] = (s[0] ^ s[3]) >>> 0;
  s[2] = (s[2] ^ t) >>> 0;
  s[3] = rotl(s[3], 11);
  return result;
}

function nextFloatFrom(s: Words): number {
  return nextUint32(s) / TWO_POW_32;
}

/** realmlib's v1 seed expansion: four successive SplitMix32-style outputs. */
function expandSeed(seed: number): Words {
  const words: number[] = [];
  let x = seed;
  for (let i = 0; i < 4; i++) {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    words.push((z ^ (z >>> 16)) >>> 0);
  }
  return words as Words;
}

function validateUint32(value: unknown, what: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`${what} must be a number, received ${typeof value}`);
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32 || Object.is(value, -0)) {
    throw new RangeError(`${what} must be an unsigned 32-bit integer (0 through ${MAX_UINT32}), received ${Object.is(value, -0) ? "-0" : value}`);
  }
  return value;
}

function wordsFromSnapshot(snapshot: object): Words {
  const { algorithm, words } = snapshot as { algorithm?: unknown; words?: unknown };
  if (typeof algorithm !== "string") {
    throw new TypeError(`Random snapshot algorithm must be a string, received ${typeof algorithm}`);
  }
  if (algorithm !== ALGORITHM) {
    throw new RangeError(`Unsupported random snapshot algorithm ${JSON.stringify(algorithm)}; expected ${JSON.stringify(ALGORITHM)}`);
  }
  if (!Array.isArray(words)) {
    throw new TypeError("Random snapshot words must be an array");
  }
  if (words.length !== 4) {
    throw new RangeError(`Random snapshot must have exactly 4 words, received ${words.length}`);
  }
  const copy = words.map((word: unknown, index) => validateUint32(word, `Random snapshot word ${index}`)) as Words;
  if (copy.every((word) => word === 0)) {
    throw new RangeError("Random snapshot state must not be all zero");
  }
  return copy;
}

/**
 * Creates an independent stream from an unsigned 32-bit seed, or restores one
 * exactly from a {@link RandomSnapshot} (without re-running seed expansion).
 * Inputs are copied, never coerced.
 *
 * @throws {TypeError} if the seed, snapshot, or a snapshot field has the wrong type.
 * @throws {RangeError} if the seed or a word is out of range (including -0),
 *   the algorithm is unknown, the word count is not 4, or the state is all zero.
 */
export function createSeededRandom(seedOrSnapshot: number | RandomSnapshot): SeededRandom {
  let words: Words;
  if (typeof seedOrSnapshot === "object" && seedOrSnapshot !== null) {
    words = wordsFromSnapshot(seedOrSnapshot);
  } else {
    words = expandSeed(validateUint32(seedOrSnapshot, "Random seed"));
  }
  const state: StreamState = { words, busy: false };

  function nextFloat(): number {
    if (state.busy) {
      throw new Error("Random stream is held by an executing operation; draw through the handler's random source");
    }
    return nextFloatFrom(state.words);
  }

  function snapshot(): RandomSnapshot {
    const [w0, w1, w2, w3] = state.words;
    return { algorithm: ALGORITHM, words: [w0, w1, w2, w3] };
  }

  const stream: SeededRandom = { nextFloat, snapshot };
  stateByStream.set(stream, state);
  return stream;
}

/**
 * Draws for one operation, taken from a private working copy of a stream.
 * Package-internal: not exported from the package root.
 */
export interface RandomDraws {
  /** Draw-only view of the working copy; throws once `end()` has been called. */
  readonly source: RandomSource;
  /** A fresh copy of the working copy's current state. */
  snapshot(): RandomSnapshot;
  /** Publishes the working copy to the stream. Does not throw. */
  commit(): void;
  /** Invalidates `source` and releases the stream. Discards uncommitted draws. */
  end(): void;
}

/**
 * Returns the private draw-scope entry point of a stream created by
 * {@link createSeededRandom}, checking the stream without holding it.
 * Package-internal.
 *
 * @throws {TypeError} if `stream` was not created by `createSeededRandom`.
 */
export function randomDrawsFor(stream: SeededRandom): () => RandomDraws {
  const state = typeof stream === "object" && stream !== null ? stateByStream.get(stream) : undefined;
  if (state === undefined) {
    throw new TypeError("Random source must be created by createSeededRandom()");
  }
  return () => beginRandomDraws(state);
}

/** Holds `state` and starts drawing from a copy of it. Throws if already held. */
function beginRandomDraws(state: StreamState): RandomDraws {
  if (state.busy) {
    throw new Error("Random stream is already held by an executing operation; nested use is not supported");
  }
  state.busy = true;
  let active = true;
  const working: Words = [...state.words];

  function nextFloat(): number {
    if (!active) throw new Error("Random source is no longer valid: its operation has ended");
    return nextFloatFrom(working);
  }

  function snapshot(): RandomSnapshot {
    const [w0, w1, w2, w3] = working;
    return { algorithm: ALGORITHM, words: [w0, w1, w2, w3] };
  }

  function commit(): void {
    if (active) state.words = working;
  }

  function end(): void {
    if (!active) return;
    active = false;
    state.busy = false;
  }

  return { source: { nextFloat }, snapshot, commit, end };
}
