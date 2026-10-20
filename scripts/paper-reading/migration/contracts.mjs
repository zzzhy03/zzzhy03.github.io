import path from "node:path";
import { assertNoCredentials, jsonBytes, relativePath, SHA256, sha256 } from "./files.mjs";

// A contract is data reviewed by the caller, not permission to execute an
// arbitrary command found in a repository. Reading/restoring never executes it.
export function portableJob(job, { root, directory } = {}) {
  if (!job || !Array.isArray(job.inputs) || !Array.isArray(job.outputs) || !job.outputs.length ||
      new Set(job.outputs).size !== job.outputs.length ||
      !Array.isArray(job.validate) || !job.validate.length) {
    throw new Error("A unit requires input records, output paths and a validation argv.");
  }
  job.inputs.forEach((input) => {
    relativePath(input.path);
    if (!SHA256.test(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 0) {
      throw new Error("Invalid portable input record.");
    }
  });
  job.outputs.forEach(relativePath);
  if (job.instructions !== undefined && (typeof job.instructions !== "string" ||
      !job.instructions.trim() || job.instructions.length > 50_000)) {
    throw new Error("Task-authored instructions must be bounded nonempty text.");
  }
  const argv = (values) => {
    if (!Array.isArray(values) || !values.length ||
        values.some((value) => typeof value !== "string" || !value || value.includes("\0"))) {
      throw new Error("A command requires a nonempty argv.");
    }
    const result = values.map((value, index) => index === 0 && value === process.execPath ? "node" : value);
    if (result.some((value) => path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) ||
        /^--?[^=]+=([/\\]|[A-Za-z]:)/.test(value) ||
        [root, directory].filter(Boolean).some((local) => value.includes(path.resolve(local))) ||
        /^--?(token|password|api[-_]?key|authorization)(=|$)/i.test(value))) {
      throw new Error("Portable argv must use relative paths and no embedded credentials or machine directories.");
    }
    return result;
  };
  const result = {
    schemaVersion: 1, id: job.id, stage: job.stage, dependencies: [...(job.dependencies ?? [])].sort(),
    inputs: job.inputs.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    outputs: [...job.outputs],
    ...(job.instructions !== undefined ? { instructions: job.instructions } : {}),
    ...(job.command ? { command: argv(job.command) } : {}),
    validate: argv(job.validate),
  };
  const bytes = jsonBytes(result);
  if (bytes.length > 1024 * 1024) throw new Error("Portable unit contract exceeds 1 MiB.");
  assertNoCredentials(bytes, { json: true });
  return result;
}

export function jobRequest(job) {
  return {
    id: job.id, stage: job.stage, dependencies: job.dependencies ?? [],
    inputSha256: sha256(jsonBytes({ inputs: job.inputs, outputs: job.outputs,
      command: job.command ?? null, validate: job.validate,
      ...(job.instructions !== undefined ? { instructions: job.instructions } : {}) })),
  };
}

export const commandArgv = (argv) => argv[0] === "node" ? [process.execPath, ...argv.slice(1)] : argv;
