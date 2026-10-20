import { notConfiguredSourceStatus } from "./not-configured.mjs";

/**
 * Future adapter contract: discoverOpenReview(options) returns normalized source
 * records plus a manifest-ready source status. Forum IDs, not note/reply IDs,
 * are the canonical provider identifiers.
 */
export async function discoverOpenReview() {
  return notConfiguredSourceStatus({
    id: "openreview",
    interfaceName: "discoverOpenReview(options)",
    nextStep:
      "Configure venue/group scopes and invitation/version handling before enabling network requests.",
  });
}
