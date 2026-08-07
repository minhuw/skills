#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "../..");
const CATALOG_PATH = path.join(PLUGIN_ROOT, "agent-profiles/profiles.json");
const MANIFEST_PATH = path.join(PLUGIN_ROOT, "agent-profiles/manifest.json");
const ROLES = ["plan-accountant", "plan-implementer", "plan-reviewer", "plan-judge", "plan-saver"];
const HOSTS = ["codex", "claude", "pi"];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;
const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

class UsageError extends Error {}

function usage() {
  return `Usage:
  profile-registry.mjs list [--host codex|claude|pi] [--pretty]
  profile-registry.mjs resolve --host codex|claude|pi [--profile name] [--pretty]
  profile-registry.mjs build
  profile-registry.mjs check
`;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || ["-h", "--help"].includes(command)) return { help: true };
  if (!["list", "resolve", "build", "check"].includes(command)) throw new UsageError(`Unknown command: ${command}`);
  const options = { command, host: undefined, profile: undefined, pretty: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--pretty") options.pretty = true;
    else if (["--host", "--profile"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new UsageError(`${argument} requires a value`);
      index += 1;
      if (argument === "--host") options.host = value;
      else options.profile = value;
    } else throw new UsageError(`Unknown argument: ${argument}`);
  }
  if (options.host && !HOSTS.includes(options.host)) throw new UsageError("--host must be codex, claude, or pi");
  if (command === "resolve" && !options.host) throw new UsageError("resolve requires --host");
  if (!["resolve"].includes(command) && options.profile) throw new UsageError("--profile is valid only with resolve");
  if (["build", "check"].includes(command) && options.host) throw new UsageError(`--host is not valid with ${command}`);
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function profileHash(profile) {
  return sha256(stableJson(profile));
}

function parseCatalog(bytes) {
  let catalog;
  try {
    catalog = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid profile catalog: ${error.message}`);
  }
  if (catalog.schema_version !== 1 || !catalog.defaults || !Array.isArray(catalog.profiles)) {
    throw new Error("Unsupported profile catalog");
  }
  const unknownCatalogFields = Object.keys(catalog).filter((field) => !["schema_version", "defaults", "profiles"].includes(field));
  if (unknownCatalogFields.length) throw new Error(`Unknown profile catalog fields: ${unknownCatalogFields.join(", ")}`);
  if (Object.keys(catalog.defaults).length !== HOSTS.length || HOSTS.some((host) => !Object.hasOwn(catalog.defaults, host))) {
    throw new Error("Profile defaults must define exactly codex, claude, and pi");
  }
  const names = new Set();
  for (const profile of catalog.profiles) {
    const unknownProfileFields = Object.keys(profile).filter((field) => !["name", "description", "hosts", "orchestrator", "roles"].includes(field));
    if (unknownProfileFields.length) throw new Error(`Unknown fields for profile ${JSON.stringify(profile.name)}: ${unknownProfileFields.join(", ")}`);
    if (typeof profile.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile.name) || names.has(profile.name)) {
      throw new Error(`Invalid or duplicate profile name: ${JSON.stringify(profile.name)}`);
    }
    names.add(profile.name);
    if (typeof profile.description !== "string" || !profile.description.trim()) throw new Error(`Missing description for ${profile.name}`);
    if (!Array.isArray(profile.hosts) || profile.hosts.length === 0 || profile.hosts.some((host) => !HOSTS.includes(host))) {
      throw new Error(`Invalid hosts for ${profile.name}`);
    }
    if (new Set(profile.hosts).size !== profile.hosts.length) throw new Error(`Duplicate host for ${profile.name}`);
    const orchestrator = profile.orchestrator;
    if (!orchestrator || typeof orchestrator !== "object" || !MODEL_PATTERN.test(orchestrator.model || "")) {
      throw new Error(`Invalid orchestrator model for ${profile.name}`);
    }
    if (!EFFORTS.has(orchestrator.effort)) throw new Error(`Invalid orchestrator effort for ${profile.name}`);
    const unknownOrchestratorFields = Object.keys(orchestrator).filter((key) => !["model", "effort"].includes(key));
    if (unknownOrchestratorFields.length) {
      throw new Error(`Unknown orchestrator fields for ${profile.name}: ${unknownOrchestratorFields.join(", ")}`);
    }
    const roleNames = Object.keys(profile.roles || {});
    if (roleNames.length !== ROLES.length || ROLES.some((role) => !Object.hasOwn(profile.roles, role))) {
      throw new Error(`Profile ${profile.name} must define exactly: ${ROLES.join(", ")}`);
    }
    for (const role of ROLES) {
      const mapping = profile.roles[role];
      if (!mapping || typeof mapping !== "object" || !MODEL_PATTERN.test(mapping.model || "")) {
        throw new Error(`Invalid model for ${profile.name}/${role}`);
      }
      if (!EFFORTS.has(mapping.effort)) throw new Error(`Invalid effort for ${profile.name}/${role}`);
      if (mapping.service_tier !== undefined && !["fast", "standard"].includes(mapping.service_tier)) {
        throw new Error(`Invalid service tier for ${profile.name}/${role}`);
      }
      const unknown = Object.keys(mapping).filter((key) => !["model", "effort", "service_tier"].includes(key));
      if (unknown.length) throw new Error(`Unknown mapping fields for ${profile.name}/${role}: ${unknown.join(", ")}`);
    }
  }
  for (const host of HOSTS) {
    const defaultName = catalog.defaults[host];
    const profile = catalog.profiles.find((candidate) => candidate.name === defaultName);
    if (!profile || !profile.hosts.includes(host)) throw new Error(`Invalid ${host} default profile: ${JSON.stringify(defaultName)}`);
  }
  return catalog;
}

function codexIdentity(profileName, role) {
  return `${profileName.replaceAll("-", "_")}_${role.replaceAll("-", "_")}`;
}

function claudeIdentity(profileName, role) {
  return `${profileName}-${role}`;
}

function piIdentity(role) {
  return `herder.${role}`;
}

function roleTemplate(host, role) {
  if (role === "plan-accountant") {
    return host === "codex"
      ? "agent-profiles/templates/codex/plan_accountant.toml"
      : "agent-profiles/templates/claude/plan-accountant.md";
  }
  return host === "codex"
    ? `agent-profiles/codex/${role.replaceAll("-", "_")}.toml`
    : `agents/${role}.md`;
}

function replaceSingle(text, expression, replacement, label) {
  const matches = text.match(new RegExp(expression.source, expression.flags.includes("g") ? expression.flags : `${expression.flags}g`)) || [];
  if (matches.length !== 1) throw new Error(`${label} must match exactly once`);
  return text.replace(expression, replacement);
}

function renderCodex(template, profileName, role, mapping) {
  const identity = codexIdentity(profileName, role);
  let text = replaceSingle(template, /^name\s*=.*$/m, `name = ${JSON.stringify(identity)}`, "Codex name");
  text = replaceSingle(text, /^model\s*=.*$/m, `model = ${JSON.stringify(mapping.model)}`, "Codex model");
  text = replaceSingle(text, /^model_reasoning_effort\s*=.*$/m, `model_reasoning_effort = ${JSON.stringify(mapping.effort)}`, "Codex effort");
  const serviceLine = /^service_tier\s*=.*(?:\r?\n|$)/m;
  text = text.replace(serviceLine, "");
  if (mapping.service_tier) {
    text = text.replace(/^model\s*=.*$/m, (line) => `${line}\nservice_tier = ${JSON.stringify(mapping.service_tier)}`);
  }
  return text;
}

function renderClaude(template, profileName, role, mapping) {
  const identity = claudeIdentity(profileName, role);
  let text = replaceSingle(template, /^name:\s*.*$/m, `name: ${identity}`, "Claude name");
  text = replaceSingle(text, /^model:\s*.*$/m, `model: ${mapping.model}`, "Claude model");
  text = replaceSingle(text, /^effort:\s*.*$/m, `effort: ${mapping.effort}`, "Claude effort");
  return text;
}

async function generatedState(catalog) {
  const manifest = {
    schema_version: 2,
    profile_set: "herder",
    catalog_sha256: sha256(stableJson(catalog)),
    defaults: catalog.defaults,
    profiles: {},
    hosts: {
      codex: { mode: "copy", files: [] },
      claude: { mode: "bundled", files: [] },
      pi: { mode: "package", files: [] },
    },
  };
  const files = new Map();
  for (const role of ROLES) {
    const codexSource = `agent-profiles/codex/${role.replaceAll("-", "_")}.toml`;
    const claudeSource = `agents/${role}.md`;
    const codexBytes = await readFile(path.join(PLUGIN_ROOT, codexSource));
    const claudeBytes = await readFile(path.join(PLUGIN_ROOT, claudeSource));
    manifest.hosts.codex.files.push({ source: codexSource, target: path.basename(codexSource), legacy: true, sha256: sha256(codexBytes) });
    manifest.hosts.claude.files.push({ source: claudeSource, identifier: `herder:${role}`, legacy: true, sha256: sha256(claudeBytes) });
    const piSource = `../../pi/herder/agents/${role}.md`;
    const piBytes = await readFile(path.resolve(PLUGIN_ROOT, piSource));
    manifest.hosts.pi.files.push({ source: piSource, identifier: piIdentity(role), role, generic: true, sha256: sha256(piBytes) });
  }
  for (const profile of catalog.profiles) {
    const hash = profileHash(profile);
    const entry = { description: profile.description, sha256: hash, orchestrator: profile.orchestrator, hosts: {} };
    for (const host of profile.hosts) {
      const roles = {};
      for (const role of ROLES) {
        const mapping = profile.roles[role];
        if (host === "codex") {
          const template = await readFile(path.join(PLUGIN_ROOT, roleTemplate(host, role)), "utf8");
          const target = `${codexIdentity(profile.name, role)}.toml`;
          const source = `agent-profiles/generated/codex/${target}`;
          const bytes = renderCodex(template, profile.name, role, mapping);
          files.set(source, bytes);
          manifest.hosts.codex.files.push({ source, target, profile: profile.name, role, sha256: sha256(bytes) });
          roles[role] = { agent_type: codexIdentity(profile.name, role), model: mapping.model, effort: mapping.effort, ...(mapping.service_tier ? { service_tier: mapping.service_tier } : {}) };
        } else if (host === "claude") {
          const template = await readFile(path.join(PLUGIN_ROOT, roleTemplate(host, role)), "utf8");
          const name = claudeIdentity(profile.name, role);
          const source = `agents/${name}.md`;
          const bytes = renderClaude(template, profile.name, role, mapping);
          files.set(source, bytes);
          const identifier = `herder:${name}`;
          manifest.hosts.claude.files.push({ source, identifier, profile: profile.name, role, sha256: sha256(bytes) });
          roles[role] = { agent_type: identifier, model: mapping.model, effort: mapping.effort };
        } else {
          roles[role] = {
            agent_type: piIdentity(role),
            model: mapping.model,
            effort: mapping.effort,
            ...(mapping.service_tier ? { service_tier: mapping.service_tier } : {}),
          };
        }
      }
      entry.hosts[host] = { roles };
    }
    manifest.profiles[profile.name] = entry;
  }
  return { files, manifest: `${JSON.stringify(manifest, null, 2)}\n` };
}

async function build(catalog, checkOnly) {
  const generated = await generatedState(catalog);
  const expected = new Map(generated.files);
  expected.set("agent-profiles/manifest.json", generated.manifest);
  const expectedClaudeSources = new Set(JSON.parse(generated.manifest).hosts.claude.files.map((file) => file.source));
  const mismatches = [];
  const generatedRoots = ["agent-profiles/generated/codex"];
  if (checkOnly) {
    for (const relativeRoot of generatedRoots) {
      const absoluteRoot = path.join(PLUGIN_ROOT, relativeRoot);
      let entries = [];
      try { entries = await readdir(absoluteRoot, { withFileTypes: true }); } catch {}
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const relative = `${relativeRoot}/${entry.name}`;
        if (!expected.has(relative)) mismatches.push(relative);
      }
    }
    const agentRoot = path.join(PLUGIN_ROOT, "agents");
    let agentEntries = [];
    try { agentEntries = await readdir(agentRoot, { withFileTypes: true }); } catch {}
    for (const entry of agentEntries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const relative = `agents/${entry.name}`;
        if (!expected.has(relative) && !expectedClaudeSources.has(relative)) mismatches.push(relative);
      }
      if (entry.isDirectory() && entry.name === "generated") mismatches.push("agents/generated");
    }
  } else {
    let previousManifest = null;
    try { previousManifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")); } catch {}
    for (const file of previousManifest?.hosts?.claude?.files || []) {
      if (file.profile && /^agents\/[A-Za-z0-9_-]+\.md$/.test(file.source)) {
        await rm(path.join(PLUGIN_ROOT, file.source), { force: true });
      }
    }
    for (const relativeRoot of generatedRoots) await rm(path.join(PLUGIN_ROOT, relativeRoot), { recursive: true, force: true });
    await rm(path.join(PLUGIN_ROOT, "agents/generated"), { recursive: true, force: true });
  }
  for (const [relative, content] of expected) {
    const target = path.join(PLUGIN_ROOT, relative);
    if (checkOnly) {
      let current;
      try { current = await readFile(target, "utf8"); } catch { current = null; }
      if (current !== content) mismatches.push(relative);
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { mode: 0o644 });
    }
  }
  if (checkOnly && mismatches.length) throw new Error(`Generated profile artifacts are stale: ${mismatches.join(", ")}`);
  return { generated_files: generated.files.size, manifest: "agent-profiles/manifest.json" };
}

function resolveProfile(catalog, manifest, host, requested) {
  const name = requested || catalog.defaults[host];
  const catalogProfile = catalog.profiles.find((profile) => profile.name === name);
  if (!catalogProfile) throw new Error(`Unknown Herder profile ${JSON.stringify(name)}`);
  if (!catalogProfile.hosts.includes(host)) throw new Error(`Herder profile ${JSON.stringify(name)} does not support ${host}`);
  const compiled = manifest.profiles?.[name];
  if (!compiled || compiled.sha256 !== profileHash(catalogProfile) || !compiled.hosts?.[host]) {
    throw new Error(`Compiled Herder profile ${JSON.stringify(name)} is missing or stale`);
  }
  return {
    schema_version: 1,
    profile: name,
    profile_sha256: compiled.sha256,
    host,
    defaulted: requested === undefined,
    orchestrator: compiled.orchestrator,
    roles: compiled.hosts[host].roles,
  };
}

async function verifyCompiledProfileFiles(manifest, profile, host) {
  const files = manifest.hosts?.[host]?.files?.filter((file) => host === "pi" ? file.generic === true : file.profile === profile) || [];
  if (files.length !== ROLES.length || ROLES.some((role) => !files.some((file) => file.role === role))) {
    throw new Error(`Compiled Herder profile ${JSON.stringify(profile)} has an incomplete ${host} role set`);
  }
  for (const file of files) {
    const source = path.join(PLUGIN_ROOT, file.source);
    let bytes;
    try { bytes = await readFile(source); } catch { throw new Error(`Compiled Herder role file is missing: ${file.source}`); }
    if (sha256(bytes) !== file.sha256) throw new Error(`Compiled Herder role file hash mismatch: ${file.source}`);
  }
}

function printJson(value, pretty) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const catalog = parseCatalog(await readFile(CATALOG_PATH));
  if (options.command === "build") return printJson(await build(catalog, false), true);
  if (options.command === "check") return printJson(await build(catalog, true), true);
  if (options.command === "list") {
    return printJson({
      defaults: catalog.defaults,
      profiles: catalog.profiles
        .filter((profile) => !options.host || profile.hosts.includes(options.host))
        .map((profile) => ({ name: profile.name, description: profile.description, hosts: profile.hosts, sha256: profileHash(profile) })),
    }, options.pretty);
  }
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  if (manifest.schema_version !== 2 || manifest.catalog_sha256 !== sha256(stableJson(catalog))) {
    throw new Error("Compiled Herder profile manifest is missing or stale");
  }
  const resolved = resolveProfile(catalog, manifest, options.host, options.profile);
  await verifyCompiledProfileFiles(manifest, resolved.profile, resolved.host);
  printJson(resolved, options.pretty);
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error) => {
    console.error(`herder-profile: ${error.message}`);
    if (error instanceof UsageError) console.error(usage());
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
