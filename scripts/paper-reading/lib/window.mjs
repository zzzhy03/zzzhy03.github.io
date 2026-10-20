const HOUR_MS = 60 * 60 * 1000;

function parseTimestamp(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty ISO timestamp.`);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }

  return timestamp;
}
function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

export function computeDiscoveryWindow({ state, since, now, overlapHours }) {
  const endMs = parseTimestamp(now ?? new Date().toISOString(), "now");
  const configuredOverlap = overlapHours ?? state?.overlapHours ?? 48;

  if (!Number.isFinite(configuredOverlap) || configuredOverlap < 0) {
    throw new Error("overlapHours must be a non-negative number.");
  }

  let startMs;
  let basis;
  let lastSuccessfulRunAt = null;

  if (since) {
    startMs = parseTimestamp(since, "since");
    basis = "explicit-since";
  } else if (state?.lastSuccessfulRunAt) {
    const watermarkMs = parseTimestamp(
      state.lastSuccessfulRunAt,
      "state.lastSuccessfulRunAt",
    );
    startMs = watermarkMs - configuredOverlap * HOUR_MS;
    basis = "last-successful-run-with-overlap";
    lastSuccessfulRunAt = iso(watermarkMs);
  } else {
    throw new Error(
      "No successful discovery watermark exists. Supply --since <ISO timestamp> for the first run.",
    );
  }

  if (startMs > endMs) {
    throw new Error("Discovery window start must not be after its end.");
  }

  return {
    basis,
    start: iso(startMs),
    end: iso(endMs),
    lastSuccessfulRunAt,
    overlapHours: configuredOverlap,
    semantics: "publishedAt OR updatedAt falls inside the inclusive window",
  };
}

export function classifyWindowMatch(record, window) {
  const startMs = parseTimestamp(window.start, "window.start");
  const endMs = parseTimestamp(window.end, "window.end");
  const publishedMs = record.publishedAt ? Date.parse(record.publishedAt) : Number.NaN;
  const updatedMs = record.updatedAt ? Date.parse(record.updatedAt) : Number.NaN;

  const publishedInWindow =
    Number.isFinite(publishedMs) && publishedMs >= startMs && publishedMs <= endMs;
  const updatedInWindow =
    Number.isFinite(updatedMs) && updatedMs >= startMs && updatedMs <= endMs;

  return {
    inWindow: publishedInWindow || updatedInWindow,
    publishedInWindow,
    updatedInWindow,
    changeKind: publishedInWindow ? "new" : updatedInWindow ? "updated" : null,
  };
}
