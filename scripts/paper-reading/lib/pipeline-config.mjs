export function validatePipelineConfig(config, venueRegistry) {
  if (config.schemaVersion !== 1) throw new Error("pipeline-config schemaVersion must be 1.");
  if (!Number.isFinite(config.daily?.lookbackDays) || config.daily.lookbackDays <= 0) {
    throw new Error("pipeline-config daily.lookbackDays must be positive.");
  }
  if (typeof config.storage?.automaticPrune !== "boolean" || config.storage.pdfRetention !== "until-verified") {
    throw new Error("pipeline-config storage requires automaticPrune (boolean) and pdfRetention='until-verified'.");
  }
  const ids = new Set();
  const venues = new Set(venueRegistry.venues.map((venue) => venue.id));
  if (!Array.isArray(config.conferences)) throw new Error("conferences must be an array.");
  for (const edition of config.conferences) {
    if (!/^[a-z0-9-]+$/.test(edition.id) || ids.has(edition.id)) throw new Error("Conference IDs must be unique kebab IDs.");
    ids.add(edition.id);
    if (!venues.has(edition.venueId) || !Number.isInteger(edition.year)) throw new Error(`Invalid venue/year for ${edition.id}.`);
    if (!["cvf", "openreview", "crossref"].includes(edition.provider)) throw new Error(`Unknown provider for ${edition.id}.`);
    const field = { cvf: "indexUrl", openreview: "venue", crossref: "containerTitle" }[edition.provider];
    if (typeof edition[field] !== "string" || !edition[field].trim()) throw new Error(`${edition.id} requires ${field}.`);
    if (edition.provider === "cvf" && new URL(edition.indexUrl).origin !== "https://openaccess.thecvf.com") throw new Error(`${edition.id} must use the official CVF origin.`);
    if (edition.scanWindow) {
      const { start, end } = edition.scanWindow;
      if (![start, end].every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))) || start > end) throw new Error(`Invalid scanWindow for ${edition.id}.`);
    }
  }
  return config;
}

export function selectConferenceEditions(config, ids, now) {
  for (const id of ids ?? []) {
    if (!config.conferences.some((edition) => edition.id === id)) throw new Error(`Unknown conference edition '${id}'.`);
  }
  return config.conferences.filter((edition) => ids?.length
    ? ids.includes(edition.id)
    : edition.scanWindow && edition.scanWindow.start <= now.slice(0, 10) && edition.scanWindow.end >= now.slice(0, 10));
}

export const DEFAULT_PIPELINE_CONFIG = {
  schemaVersion: 1, daily: { lookbackDays: 3 },
  storage: { automaticPrune: false, pdfRetention: "until-verified" }, conferences: [],
};
