import { notConfiguredSourceStatus } from "./not-configured.mjs";

/**
 * Future adapters should be registry-driven and provider-specific (CVF, ACM,
 * publisher issue feeds). Venue aliases are ranking metadata, not search URLs.
 */
export async function discoverVenueProceedings() {
  return notConfiguredSourceStatus({
    id: "venue-proceedings",
    interfaceName: "discoverVenueProceedings(options)",
    nextStep:
      "Add one provider implementation per official proceedings source and retain provider provenance.",
  });
}
