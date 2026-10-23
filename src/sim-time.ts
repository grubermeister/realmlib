/**
 * Simulation time value type.
 *
 * There is no simulated clock here: this module only validates and brands a
 * caller-supplied millisecond count.
 */

declare const simTimeBrand: unique symbol;

/**
 * Integer count of simulated milliseconds since an arbitrary simulation origin.
 * Not a Unix timestamp or wall-clock time. Represented at runtime as a number.
 */
export type SimTime = number & { readonly [simTimeBrand]: true };

/**
 * Brands a nonnegative safe integer millisecond count as {@link SimTime}.
 * The value is returned unchanged.
 *
 * @throws {TypeError} if `milliseconds` is not a number.
 * @throws {RangeError} if `milliseconds` is negative (including -0), fractional, NaN,
 *   infinite, or greater than `Number.MAX_SAFE_INTEGER`.
 */
export function simTime(milliseconds: number): SimTime {
  if (typeof milliseconds !== "number") {
    throw new TypeError(`SimTime must be a number, received ${typeof milliseconds}`);
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || Object.is(milliseconds, -0)) {
    throw new RangeError(
      `SimTime must be a nonnegative safe integer of milliseconds, received ${Object.is(milliseconds, -0) ? "-0" : milliseconds}`,
    );
  }
  return milliseconds as SimTime;
}
