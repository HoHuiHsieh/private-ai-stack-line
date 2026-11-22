import type { McpContext } from "./server";

/**
 * The user who owns a secret: the token's `sub`. Secrets are per user, so a call
 * without a subject is refused rather than stored under a shared placeholder.
 */
export function ownerOf(ctx: McpContext): string {
  const sub = ctx.claims.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("The access token has no subject, so secrets cannot be stored for this caller");
  }
  return sub;
}
