#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const MANIFEST_PATH = path.join(PLUGIN_ROOT, "agent-profiles/manifest.json");
const HOSTS = ["codex", "claude"];
const CODEX_BIN = process.env.HERDER_CODEX_BIN || "codex";

class UsageError extends Error {}
class ConflictError extends Error {
  constructor(conflicts) {
    super("Installed Codex profiles differ from the bundled Herder profiles.");
    this.conflicts = conflicts;
  }
}

function usage() {
  return `Usage: install-herder.mjs [options]

Options:
  --host codex|claude|all  Profiles to install or verify (required)
  --scope project|user     Codex installation scope (default: project)
  --project-root path      Override the Codex project root
  --dry-run                Verify and report without writing
  --force                  Back up and replace differing Codex profiles
  --help                    Show this help
`;
}

function parseArgs(argv) {
  const options = {
    host: undefined,
    scope: "project",
    projectRoot: undefined,
    dryRun: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (["--host", "--scope", "--project-root"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} requires a value.`);
      index += 1;
      if (arg === "--host") options.host = value;
      if (arg === "--scope") options.scope = value;
      if (arg === "--project-root") options.projectRoot = value;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && ![...HOSTS, "all"].includes(options.host)) {
    throw new UsageError("--host must be codex, claude, or all.");
  }
  if (!options.help && !["project", "user"].includes(options.scope)) {
    throw new UsageError("--scope must be project or user.");
  }
  if (options.projectRoot && options.scope !== "project") {
    throw new UsageError("--project-root is valid only with --scope project.");
  }
  return options;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid bundled profile manifest: ${error.message}`);
  }
  if (manifest.schema_version !== 1 || manifest.profile_set !== "herder") {
    throw new Error("Unsupported bundled Herder profile manifest.");
  }
  return manifest;
}

function validateFiles(manifest, host) {
  const entry = manifest.hosts?.[host];
  const expectedMode = host === "codex" ? "copy" : "bundled";
  if (entry?.mode !== expectedMode || !Array.isArray(entry.files) || entry.files.length !== 3) {
    throw new Error(`Manifest must define exactly three ${host} profiles in ${expectedMode} mode.`);
  }

  const expectedPrefix = host === "codex" ? "agent-profiles/codex/" : "agents/";
  const seen = new Set();
  for (const file of entry.files) {
    if (typeof file.source !== "string" || !file.source.startsWith(expectedPrefix)) {
      throw new Error(`Unsafe ${host} profile source in manifest.`);
    }
    const suffix = file.source.slice(expectedPrefix.length);
    if (!suffix || suffix.includes("/") || suffix.includes("\\")) {
      throw new Error(`Nested or unsafe ${host} profile source in manifest.`);
    }
    if (!/^[0-9a-f]{64}$/i.test(file.sha256 || "")) {
      throw new Error(`Invalid SHA-256 for ${file.source}.`);
    }
    const identity = host === "codex" ? file.target : file.identifier;
    if (typeof identity !== "string" || seen.has(identity)) {
      throw new Error(`Invalid or duplicate ${host} profile identity.`);
    }
    if (host === "codex" && path.basename(identity) !== identity) {
      throw new Error(`Unsafe Codex target in manifest: ${identity}`);
    }
    if (host === "claude" && !identity.startsWith("herder:")) {
      throw new Error(`Claude profile identifier is not in the Herder namespace: ${identity}`);
    }
    seen.add(identity);
  }
  return entry.files;
}

function gitRoot(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("Project-scoped Codex installation requires a Git repository or --project-root.");
  }
}

function codexDestination(options) {
  if (options.scope === "user") {
    return path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "agents");
  }
  const root = options.projectRoot ? path.resolve(options.projectRoot) : gitRoot(process.cwd());
  return path.join(root, ".codex", "agents");
}

function codexMultiAgentV2Status() {
  try {
    const output = execFileSync(CODEX_BIN, ["features", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(/^multi_agent_v2\s+.*\s+(true|false)\s*$/m);
    if (!match) return { state: "unavailable", detail: "this Codex release does not report multi_agent_v2" };
    return { state: match[1] === "true" ? "enabled" : "disabled", detail: null };
  } catch (error) {
    return { state: "unavailable", detail: `could not run ${CODEX_BIN} features list: ${error.message}` };
  }
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadProfiles(manifest, hosts, options) {
  const profiles = [];
  for (const host of hosts) {
    const files = validateFiles(manifest, host);
    const destination = host === "codex" ? codexDestination(options) : null;
    for (const file of files) {
      const sourcePath = path.join(PLUGIN_ROOT, file.source);
      const bytes = await readFile(sourcePath);
      if (sha256(bytes) !== file.sha256.toLowerCase()) {
        throw new Error(`Checksum mismatch for bundled profile ${file.source}.`);
      }
      profiles.push({
        host,
        bytes,
        source: sourcePath,
        target: destination ? path.join(destination, file.target) : null,
        identifier: file.identifier || null,
      });
    }
  }
  return profiles;
}

async function classifyCodex(profiles) {
  const result = { install: [], unchanged: [], conflicts: [] };
  for (const profile of profiles.filter((item) => item.host === "codex")) {
    if (!(await exists(profile.target))) {
      result.install.push(profile);
      continue;
    }
    const current = await readFile(profile.target);
    if (current.equals(profile.bytes)) result.unchanged.push(profile);
    else result.conflicts.push(profile);
  }
  return result;
}

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function installCodex(profiles, { force, dryRun }) {
  const classified = await classifyCodex(profiles);
  if (dryRun) return classified;
  if (classified.conflicts.length > 0 && !force) {
    throw new ConflictError(classified.conflicts);
  }

  const changing = [...classified.install, ...classified.conflicts];
  const prepared = [];
  const backups = [];
  const installedTargets = [];
  const stamp = backupStamp();

  try {
    for (const profile of changing) {
      const directory = path.dirname(profile.target);
      await mkdir(directory, { recursive: true });
      const temporary = path.join(
        directory,
        `.${path.basename(profile.target)}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`,
      );
      await writeFile(temporary, profile.bytes, { flag: "wx", mode: 0o600 });
      prepared.push({ ...profile, temporary });
    }

    for (const profile of prepared) {
      if (await exists(profile.target)) {
        const backupDir = path.join(path.dirname(profile.target), ".herder-backups", stamp);
        await mkdir(backupDir, { recursive: true });
        const backup = path.join(backupDir, path.basename(profile.target));
        await copyFile(profile.target, backup);
        backups.push({ target: profile.target, backup });
        await rm(profile.target);
      }
      await rename(profile.temporary, profile.target);
      installedTargets.push(profile.target);
    }
  } catch (error) {
    for (const profile of prepared) await rm(profile.temporary, { force: true }).catch(() => {});
    for (const target of installedTargets) {
      if (!backups.some((backup) => backup.target === target)) {
        await rm(target, { force: true }).catch(() => {});
      }
    }
    for (const { target, backup } of backups.reverse()) {
      await copyFile(backup, target).catch(() => {});
    }
    throw error;
  }
  return classified;
}

function printCodexRequirement(feature) {
  if (feature.state === "enabled") {
    console.log("Codex requirement: multi_agent_v2 is enabled.");
  } else if (feature.state === "disabled") {
    console.log("WARNING: Codex multi_agent_v2 is disabled. Herder Fire cannot run until it is enabled.");
  } else {
    console.log(`WARNING: Could not verify Codex multi_agent_v2 (${feature.detail}). Herder Fire requires a Codex release that exposes it.`);
  }
  if (feature.state !== "enabled") console.log("Run: codex features enable multi_agent_v2");
  console.log("Required custom-role schema (replace a boolean multi_agent_v2 entry; do not define both forms):");
  console.log("[features.multi_agent_v2]");
  console.log("enabled = true");
  console.log("hide_spawn_agent_metadata = false");
  console.log('tool_namespace = "herder_agents"');
  console.log("Then start a new Codex session before using $herder:fire.");
}

function printResult(profiles, result, options, feature) {
  console.log(`Plugin: ${PLUGIN_ROOT}`);
  const mode = options.dryRun ? "Would install" : "Installed";
  for (const profile of result.install) console.log(`${mode}: ${profile.target}`);
  for (const profile of result.conflicts) {
    if (options.dryRun && !options.force) console.log(`Conflict (would preserve): ${profile.target}`);
    else console.log(`${mode} (replaced): ${profile.target}`);
  }
  for (const profile of result.unchanged) console.log(`Unchanged: ${profile.target}`);
  for (const profile of profiles.filter((item) => item.host === "claude")) {
    console.log(`Bundled: ${profile.identifier}`);
  }
  if (feature) {
    printCodexRequirement(feature);
    if (!options.dryRun) {
      console.log("Start a new Codex session if the agent directory did not exist when the current session began.");
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const manifest = parseManifest(await readFile(MANIFEST_PATH));
  const hosts = options.host === "all" ? HOSTS : [options.host];
  const feature = hosts.includes("codex") ? codexMultiAgentV2Status() : null;
  const profiles = await loadProfiles(manifest, hosts, options);
  const result = await installCodex(profiles, options);
  printResult(profiles, result, options, feature);
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error) => {
    if (error instanceof ConflictError) {
      console.error(error.message);
      for (const conflict of error.conflicts) console.error(`Conflict: ${conflict.target}`);
      console.error("Re-run with --force only if replacing these customized profiles is intended.");
      process.exitCode = 3;
      return;
    }
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    console.error(`herder-install: ${error.message}`);
    process.exitCode = 1;
  });
}
