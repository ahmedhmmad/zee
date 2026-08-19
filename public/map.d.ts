/**
 * Types for the parts of the browser map module that the tests import.
 *
 * public/ is plain browser JavaScript and is deliberately outside tsconfig's
 * include list - it never goes through tsc, and adding it would mean type
 * checking a file that runs against DOM globals the server build knows
 * nothing about.
 *
 * But a .ts test importing it still needs a declaration, or `tsc --noEmit`
 * fails on an implicit any. Only what the tests actually use is declared here;
 * the rest of the module's exports are intentionally absent, because nothing
 * type checked should be reaching for them.
 */

/** A stable CSS `hsl(...)` colour derived from a ride's id. */
export function rideColour(seed: unknown): string;
