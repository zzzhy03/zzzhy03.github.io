#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { exportState, inventoryState, restoreState } from "./state.mjs";

export function main(argv) {
  const [command, ...rest] = argv;
  if (!["inventory", "export", "restore"].includes(command)) {
    throw new Error("Usage: cli.mjs inventory --root ROOT | export --root ROOT --destination DIR --context FILE | restore --bundle DIR --target ROOT --manifest-sha256 HASH --context FILE");
  }
  const allowed = {
    inventory: new Set(["root"]),
    export: new Set(["root", "destination", "context"]),
    restore: new Set(["bundle", "target", "manifest-sha256", "context"]),
  }[command];
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].replace(/^--/, "");
    if (!rest[index].startsWith("--") || !allowed.has(key) || options[key] || !rest[index + 1]) throw new Error("Unknown, duplicate or missing argument.");
    options[key] = rest[index + 1];
  }
  if ([...allowed].some((key) => !options[key])) throw new Error("Missing required argument.");
  if (command === "inventory") return inventoryState(options.root);
  const context = JSON.parse(readFileSync(options.context, "utf8"));
  if (command === "export") return exportState({ root: options.root, destination: options.destination, context });
  return restoreState({ bundle: options.bundle, target: options.target, manifestSha256: options["manifest-sha256"], expectedContext: context });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
