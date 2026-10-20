export function validatePipelineConfig(config, venueRegistry) {
  if (config.schemaVersion !== 1) throw new Error("pipeline-config schemaVersion must be 1.");
  if (!Number.isFinite(config.daily?.lookbackDays) || config.daily.lookbackDays <= 0) {
    throw new Error("pipeline-config daily.lookbackDays must be positive.");
  }
  return config;
}

export const DEFAULT_PIPELINE_CONFIG = {
  schemaVersion: 1, daily: { lookbackDays: 3 },
};
