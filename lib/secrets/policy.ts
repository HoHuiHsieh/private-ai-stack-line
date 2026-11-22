/**
 * Input rules for secrets. Pure functions with no server imports, so the client
 * can use them too. The API route is still the authority: it checks again.
 */

export type SecretScope = "private" | "public";

/** Service and secret names: lowercase letters, digits, "-" and "_", 1-64 characters. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Upper bound on a secret value. Longer values are refused, not truncated. */
export const MAX_VALUE_LENGTH = 4096;

export function isValidName(value: unknown): value is string {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

export function isValidValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_VALUE_LENGTH;
}

export function isValidScope(value: unknown): value is SecretScope {
  return value === "private" || value === "public";
}
