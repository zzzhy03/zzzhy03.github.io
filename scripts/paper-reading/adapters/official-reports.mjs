import { notConfiguredSourceStatus } from "./not-configured.mjs";

/**
 * Official reports require an explicit allowlist of first-party organization,
 * lab, project, or author feeds. News/search-result pages must not become the
 * primary source record.
 */
export async function discoverOfficialReports() {
  return notConfiguredSourceStatus({
    id: "official-reports",
    interfaceName: "discoverOfficialReports(options)",
    nextStep:
      "Create a reviewed first-party feed allowlist with release/version extraction before enabling it.",
  });
}
