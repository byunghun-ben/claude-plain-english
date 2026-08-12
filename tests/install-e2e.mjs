// Installs the plugin from a local marketplace inside a throwaway environment,
// walks the whole lifecycle, and proves the real ~/.claude was never touched.
//
// Usage:
//   node tests/install-e2e.mjs --scope user|project --claude /absolute/path/to/claude
//                              [--expect-claude-version "2.1.228 (Claude Code)"]

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_ROOT = join(REPOSITORY_ROOT, "tests", "fixtures");
const PLUGIN_ROOT = join(REPOSITORY_ROOT, "plugins", "plain-english");
const PLUGIN_NAME = "plain-english";
const MARKETPLACE_NAME = "claude-plain-english";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const INLINE_PLUGIN_ID = `${PLUGIN_NAME}@inline`;
const STYLE_SETTING_VALUE = `${PLUGIN_NAME}:Plain English`;
// The manifest owns the version. Reading it here keeps this test from becoming
// a second place that has to be bumped at release time.
const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
).version;
const CACHE_PLUGIN_FILES = [".claude-plugin/plugin.json", "output-styles/plain-english.md"];
const INSTALLER_MANAGED_KEYS = new Set(["enabledPlugins", "extraKnownMarketplaces"]);
const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
];
const COMMAND_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage: node tests/install-e2e.mjs --scope user|project --claude /absolute/path/to/claude " +
      '[--expect-claude-version "2.1.228 (Claude Code)"]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { scope: undefined, claude: undefined, expectClaudeVersion: undefined };
  const flags = { "--scope": "scope", "--claude": "claude", "--expect-claude-version": "expectClaudeVersion" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = flags[argument];
    if (!key) usage(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  if (!new Set(["user", "project"]).has(options.scope)) usage("--scope must be user or project");
  if (!options.claude || !isAbsolute(options.claude)) usage("--claude must be an absolute path");
  return options;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function metadataSnapshot(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path, { bigint: true });
  assert(stat.isFile(), `guarded path is not a regular file: ${path}`);
  return {
    exists: true,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function directorySnapshot(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path, { bigint: true });
  assert(stat.isDirectory(), "the real ~/.claude path must be a directory");
  return {
    exists: true,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function realClaudeGuard() {
  const root = join(homedir(), ".claude");
  const guardedFiles = [
    "settings.json",
    "plugins/installed_plugins.json",
    "plugins/known_marketplaces.json",
  ];
  return {
    root,
    rootSnapshot: directorySnapshot(root),
    files: new Map(guardedFiles.map((path) => [path, metadataSnapshot(join(root, path))])),
  };
}

function assertRealClaudeUnchanged(guard, label) {
  assert.deepEqual(
    directorySnapshot(guard.root),
    guard.rootSnapshot,
    `${label}: the real ~/.claude directory identity or mtime changed`,
  );
  for (const [path, snapshot] of guard.files) {
    assert.deepEqual(
      metadataSnapshot(join(guard.root, path)),
      snapshot,
      `${label}: the real ~/.claude/${path} changed`,
    );
  }
}

function assertOnlyManagedSettingsChanged(before, after, label) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (INSTALLER_MANAGED_KEYS.has(key)) continue;
    assert.deepEqual(after[key], before[key], `${label} changed the non-installer setting ${key}`);
  }
}

function walkFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      const stat = lstatSync(absolutePath);
      assert(!stat.isSymbolicLink(), `installed cache contains a symlink: ${path}`);
      if (stat.isDirectory()) visit(absolutePath);
      else {
        assert(stat.isFile(), `installed cache contains an unsupported entry: ${path}`);
        assert.equal(stat.mode & 0o111, 0, `installed cache contains an executable: ${path}`);
        files.push(path);
      }
    }
  }
  visit(root);
  return files.sort();
}

// Buffered output can arrive after the child has already exited, so the group
// may be gone (ESRCH) or no longer ours (EPERM) by the time we signal it. Both
// mean there is nothing of ours left in that group; fall back to the direct
// child handle and treat the same two codes as "already finished".
function killProcessGroup(child, signal) {
  if (!child.pid) return;
  const gone = new Set(["ESRCH", "EPERM"]);
  try {
    process.kill(-child.pid, signal);
    return;
  } catch (error) {
    if (!gone.has(error.code)) throw error;
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (!gone.has(error.code)) throw error;
  }
}

// Every subprocess runs in its own process group so a timeout kills the whole
// tree, not just the direct child, and output is capped so a runaway command
// cannot exhaust memory.
export function spawnWithHardTimeout(command, args, options = {}) {
  const { cwd, env, timeoutMs = COMMAND_TIMEOUT_MS, outputLimitBytes = OUTPUT_LIMIT_BYTES } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;

    const settle = (fail, value) => {
      if (settled) return;
      settled = true;
      (fail ? reject : resolvePromise)(value);
    };

    const append = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimitBytes) {
        killProcessGroup(child, "SIGKILL");
        settle(true, new Error(`command exceeded the ${outputLimitBytes} byte output limit: ${command}`));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.on("error", (error) => settle(true, error));

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 750).unref();
    }, timeoutMs);

    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        settle(true, new Error(`command timed out after ${timeoutMs}ms and its process group was killed: ${command}`));
        return;
      }
      settle(false, {
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function makeEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "plain-english-install-e2e-"));
  const fakeHome = join(root, "home");
  const config = join(root, "config");
  const cache = join(root, "plugin-cache");
  const project = join(root, "project");
  for (const path of [fakeHome, config, cache, join(project, ".claude")]) mkdirSync(path, { recursive: true });

  const userSettings = join(config, "settings.json");
  const projectSettings = join(project, ".claude", "settings.json");
  const localSettings = join(project, ".claude", "settings.local.json");
  const mcp = join(project, ".mcp.json");
  copyFileSync(join(FIXTURE_ROOT, "user-settings.json"), userSettings);
  copyFileSync(join(FIXTURE_ROOT, "project-settings.json"), projectSettings);
  copyFileSync(join(FIXTURE_ROOT, "project-mcp.json"), mcp);
  writeJson(localSettings, { localSentinel: { preserve: true }, outputStyle: "Explanatory" });

  const environment = { ...process.env };
  for (const key of CREDENTIAL_ENV_KEYS) delete environment[key];
  Object.assign(environment, {
    HOME: fakeHome,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: cache,
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    NO_COLOR: "1",
  });

  const realRoot = resolve(join(homedir(), ".claude"));
  for (const isolatedPath of [root, fakeHome, config, cache, project]) {
    const resolved = resolve(isolatedPath);
    assert(
      resolved !== realRoot && !resolved.startsWith(`${realRoot}${sep}`),
      "an isolated path escaped into the real ~/.claude",
    );
  }

  return { root, config, cache, project, userSettings, projectSettings, localSettings, mcp, environment };
}

function commandRunner(options, sandbox) {
  return async function run(args, { json = false, expectFailure = false } = {}) {
    assert(
      (args.length === 1 && args[0] === "--version") || args.includes("plugin"),
      "the install E2E may only invoke version and plugin-management commands",
    );
    const result = await spawnWithHardTimeout(options.claude, args, {
      cwd: sandbox.project,
      env: sandbox.environment,
    });
    if (expectFailure) {
      assert.notEqual(result.status, 0, `expected a failing command: ${args.join(" ")}`);
      return result;
    }
    assert.equal(
      result.status,
      0,
      `claude command failed (${args.join(" ")}): ${(result.stderr || result.stdout).trim()}`,
    );
    const output = result.stdout.trim();
    return json ? JSON.parse(output || "null") : output;
  };
}

function findInstalledPlugin(plugins, enabled) {
  assert(Array.isArray(plugins), "plugin list --json must return an array");
  const matches = plugins.filter((plugin) => plugin.id === PLUGIN_ID);
  assert.equal(matches.length, 1, `expected exactly one ${PLUGIN_ID} installation`);
  assert.equal(matches[0].version, PLUGIN_VERSION);
  assert.equal(matches[0].enabled, enabled);
  return matches[0];
}

function assertCache(installPath) {
  assert(isAbsolute(installPath), "the plugin install path must be absolute");
  const allFiles = walkFiles(installPath);
  const installerMarkers = allFiles.filter((path) => path.startsWith(".in_use/"));
  assert(
    installerMarkers.every((path) => /^\.in_use\/[A-Za-z0-9._-]+$/.test(path)),
    "the installed cache has an unexpected installer marker",
  );
  const pluginFiles = allFiles.filter((path) => !path.startsWith(".in_use/"));
  assert.deepEqual(pluginFiles, CACHE_PLUGIN_FILES, "the installed cache holds more than the manifest and style");
  for (const path of CACHE_PLUGIN_FILES) {
    assert.equal(
      sha256(readFileSync(join(installPath, path))),
      sha256(readFileSync(join(PLUGIN_ROOT, path))),
      `the cached ${path} differs from the source plugin`,
    );
  }
}

function assertCacheMetadata(sandbox, scope, installPath) {
  const installedMetadata = readJson(join(sandbox.cache, "installed_plugins.json"));
  const records = installedMetadata.plugins?.[PLUGIN_ID];
  assert(Array.isArray(records), "the cache metadata is missing the target plugin");
  assert.equal(records.length, 1, "the cache metadata has duplicate records for the target plugin");
  assert.equal(records[0].scope, scope);
  assert.equal(records[0].version, PLUGIN_VERSION);
  assert.equal(resolve(records[0].installPath), resolve(installPath));

  const marketplaceMetadata = readJson(join(sandbox.cache, "known_marketplaces.json"));
  assert(marketplaceMetadata[MARKETPLACE_NAME], "the cache metadata is missing the marketplace");
  assert.equal(typeof marketplaceMetadata[MARKETPLACE_NAME].source?.source, "string");
}

function assertPreexistingEnabledPlugin(settings, initialSettings, label) {
  assert.equal(
    settings.enabledPlugins?.["fixture-plugin@fixture-marketplace"],
    initialSettings.enabledPlugins["fixture-plugin@fixture-marketplace"],
    `${label} changed the pre-existing enabledPlugins entry`,
  );
}

// Each claude invocation is a separate process, so what a fresh process reports
// is what a new session would see. This checks that boundary for the explicit
// outputStyle selection; it does not render a model response.
async function exerciseOutputStyleBoundary(run, sandbox) {
  const before = readJson(sandbox.localSettings);
  const selected = { ...before, outputStyle: STYLE_SETTING_VALUE };
  writeJson(sandbox.localSettings, selected);
  const details = await run(["plugin", "details", PLUGIN_ID]);
  assert.match(details, new RegExp(`^${PLUGIN_NAME} ${PLUGIN_VERSION.replace(/\./g, "\\.")}`, "m"));
  assert.deepEqual(
    readJson(sandbox.localSettings),
    selected,
    "a fresh CLI process did not preserve the explicit outputStyle selection",
  );

  const reset = { ...selected };
  delete reset.outputStyle;
  writeJson(sandbox.localSettings, reset);
  assert.deepEqual(
    readJson(sandbox.localSettings),
    { localSentinel: before.localSentinel },
    "resetting the output style changed the local sentinel state",
  );
}

async function runE2E(options, sandbox) {
  const run = commandRunner(options, sandbox);
  const version = await run(["--version"]);
  if (options.expectClaudeVersion) {
    assert.equal(version, options.expectClaudeVersion, "the pinned Claude Code version did not answer");
  }

  const initialUserBytes = readFileSync(sandbox.userSettings);
  const initialProjectBytes = readFileSync(sandbox.projectSettings);
  const initialLocalBytes = readFileSync(sandbox.localSettings);
  const initialMcpBytes = readFileSync(sandbox.mcp);
  const initialUser = readJson(sandbox.userSettings);
  const initialProject = readJson(sandbox.projectSettings);

  // A session-scope load must not write to any settings file.
  const inlinePlugins = await run(["--plugin-dir", PLUGIN_ROOT, "plugin", "list", "--json"], { json: true });
  const inline = inlinePlugins.filter((plugin) => plugin.id === INLINE_PLUGIN_ID);
  assert.equal(inline.length, 1, `--plugin-dir did not discover ${INLINE_PLUGIN_ID}`);
  assert.equal(inline[0].version, PLUGIN_VERSION);
  assert.equal(inline[0].scope, "session");
  assert.equal(inline[0].enabled, true);
  assert.equal(resolve(inline[0].installPath), resolve(PLUGIN_ROOT));
  assert.deepEqual(readFileSync(sandbox.userSettings), initialUserBytes, "--plugin-dir changed user settings");
  assert.deepEqual(readFileSync(sandbox.projectSettings), initialProjectBytes, "--plugin-dir changed project settings");
  assert.deepEqual(readFileSync(sandbox.localSettings), initialLocalBytes, "--plugin-dir changed local settings");
  assert.deepEqual(readFileSync(sandbox.mcp), initialMcpBytes, "--plugin-dir changed the MCP fixture");

  await run(["plugin", "marketplace", "add", "--scope", options.scope, REPOSITORY_ROOT]);

  const targetSettingsPath = options.scope === "user" ? sandbox.userSettings : sandbox.projectSettings;
  const otherSettingsPath = options.scope === "user" ? sandbox.projectSettings : sandbox.userSettings;
  const initialTarget = options.scope === "user" ? initialUser : initialProject;
  const initialOtherBytes = options.scope === "user" ? initialProjectBytes : initialUserBytes;

  let target = readJson(targetSettingsPath);
  assertOnlyManagedSettingsChanged(initialTarget, target, "marketplace add");
  assertPreexistingEnabledPlugin(target, initialTarget, "marketplace add");
  assert(target.extraKnownMarketplaces?.[MARKETPLACE_NAME], "the marketplace declaration is missing");
  assert.deepEqual(readFileSync(otherSettingsPath), initialOtherBytes, "marketplace add changed the other scope");
  assert.deepEqual(readFileSync(sandbox.localSettings), initialLocalBytes, "marketplace add changed local settings");
  assert.deepEqual(readFileSync(sandbox.mcp), initialMcpBytes, "marketplace add changed the MCP fixture");
  const marketplaces = await run(["plugin", "marketplace", "list", "--json"], { json: true });
  assert.equal(marketplaces.filter((marketplace) => marketplace.name === MARKETPLACE_NAME).length, 1);

  await run(["plugin", "install", "--scope", options.scope, PLUGIN_ID]);
  target = readJson(targetSettingsPath);
  assertOnlyManagedSettingsChanged(initialTarget, target, "plugin install");
  assertPreexistingEnabledPlugin(target, initialTarget, "plugin install");
  assert.equal(target.enabledPlugins?.[PLUGIN_ID], true, "plugin install did not enable the plugin");
  assert.deepEqual(readFileSync(otherSettingsPath), initialOtherBytes, "plugin install changed the other scope");
  assert.deepEqual(readFileSync(sandbox.localSettings), initialLocalBytes, "plugin install changed the outputStyle state");
  assert.deepEqual(readFileSync(sandbox.mcp), initialMcpBytes, "plugin install changed the MCP fixture");

  let installed = findInstalledPlugin(await run(["plugin", "list", "--json"], { json: true }), true);
  assert.equal(installed.scope, options.scope);
  assertCache(installed.installPath);
  assertCacheMetadata(sandbox, options.scope, installed.installPath);

  const details = await run(["plugin", "details", PLUGIN_ID]);
  assert.match(details, new RegExp(`^${PLUGIN_NAME} ${PLUGIN_VERSION.replace(/\./g, "\\.")}`, "m"));
  assert.match(details, new RegExp(`Source: ${PLUGIN_ID}`));
  for (const component of ["Skills", "Agents", "Hooks", "MCP servers"]) {
    assert.match(details, new RegExp(`${component} \\(0\\)`), `${component} must be empty`);
  }

  await exerciseOutputStyleBoundary(run, sandbox);

  await run(["plugin", "disable", "--scope", options.scope, PLUGIN_ID]);
  installed = findInstalledPlugin(await run(["plugin", "list", "--json"], { json: true }), false);
  assertCache(installed.installPath);
  target = readJson(targetSettingsPath);
  assert.equal(target.enabledPlugins?.[PLUGIN_ID], false, "disable did not record a false enabled state");
  assert(target.extraKnownMarketplaces?.[MARKETPLACE_NAME], "disable removed the marketplace declaration");
  assertOnlyManagedSettingsChanged(initialTarget, target, "plugin disable");
  assertPreexistingEnabledPlugin(target, initialTarget, "plugin disable");

  await run(["plugin", "uninstall", "--scope", options.scope, PLUGIN_ID]);
  const afterUninstall = await run(["plugin", "list", "--json"], { json: true });
  assert.equal(
    afterUninstall.some((plugin) => plugin.id === PLUGIN_ID),
    false,
    "uninstall left the plugin listed",
  );
  target = readJson(targetSettingsPath);
  assert.equal(PLUGIN_ID in (target.enabledPlugins ?? {}), false, "uninstall left an enabledPlugins entry");
  assert(target.extraKnownMarketplaces?.[MARKETPLACE_NAME], "uninstall removed the marketplace before it was asked to");

  await run(["plugin", "marketplace", "remove", "--scope", options.scope, MARKETPLACE_NAME]);
  const finalMarketplaces = await run(["plugin", "marketplace", "list", "--json"], { json: true });
  assert.equal(
    finalMarketplaces.some((marketplace) => marketplace.name === MARKETPLACE_NAME),
    false,
    "marketplace remove left a declaration",
  );

  const finalTarget = readJson(targetSettingsPath);
  assertOnlyManagedSettingsChanged(initialTarget, finalTarget, "the final lifecycle state");
  assertPreexistingEnabledPlugin(finalTarget, initialTarget, "the final lifecycle state");
  assert.equal(PLUGIN_ID in (finalTarget.enabledPlugins ?? {}), false);
  assert.equal(MARKETPLACE_NAME in (finalTarget.extraKnownMarketplaces ?? {}), false);

  // Claude Code may keep the immutable payload behind its own orphan marker.
  // installed_plugins.json, not cache presence, owns active-install state.
  const installedMetadataPath = join(sandbox.cache, "installed_plugins.json");
  if (existsSync(installedMetadataPath)) {
    assert.equal(
      PLUGIN_ID in (readJson(installedMetadataPath).plugins ?? {}),
      false,
      "uninstall left plugin cache metadata",
    );
  }
  const marketplaceMetadataPath = join(sandbox.cache, "known_marketplaces.json");
  if (existsSync(marketplaceMetadataPath)) {
    assert.equal(
      MARKETPLACE_NAME in readJson(marketplaceMetadataPath),
      false,
      "marketplace remove left cache metadata",
    );
  }
  assert.deepEqual(readFileSync(otherSettingsPath), initialOtherBytes, "the lifecycle changed the other scope");
  assert.deepEqual(readFileSync(sandbox.mcp), initialMcpBytes, "the lifecycle changed the MCP fixture");
  assert.deepEqual(
    readJson(sandbox.localSettings),
    { localSentinel: { preserve: true } },
    "the output style reset changed the local sentinel state",
  );

  // A failing command must also leave the real configuration alone.
  await run(["plugin", "details", "not-a-plugin@not-a-marketplace"], { expectFailure: true });

  return version;
}

// The timeout and output-limit paths are exercised directly, because a healthy
// claude run never reaches them.
async function verifySubprocessLimits(guard) {
  const sleeper = `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000);`;
  const pidFile = join(mkdtempSync(join(tmpdir(), "plain-english-timeout-")), "grandchild.pid");
  await assert.rejects(
    () => spawnWithHardTimeout(process.execPath, ["-e", sleeper, pidFile], { timeoutMs: 1_000 }),
    /timed out after 1000ms and its process group was killed/,
    "a hung command must be killed by the timeout",
  );
  assertRealClaudeUnchanged(guard, "timeout path");

  // The grandchild shares the process group, so the SIGKILL should have reached
  // it too. Give the kernel a moment to reap before checking.
  const grandchildPid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  let alive = true;
  try {
    process.kill(grandchildPid, 0);
  } catch (error) {
    // ESRCH means the process is gone. EPERM means it still exists but belongs
    // to another user, which would mean the PID was reused rather than killed.
    alive = error.code === "EPERM";
  }
  assert.equal(alive, false, "the timeout left a grandchild process running");
  rmSync(dirname(pidFile), { recursive: true, force: true });

  await assert.rejects(
    () =>
      spawnWithHardTimeout(process.execPath, ["-e", 'process.stdout.write("x".repeat(200000))'], {
        outputLimitBytes: 1_000,
      }),
    /exceeded the 1000 byte output limit/,
    "an oversized output must stop the command",
  );
  assertRealClaudeUnchanged(guard, "output limit path");
}

const options = parseArgs(process.argv.slice(2));
const guard = realClaudeGuard();
const sandbox = makeEnvironment();
let failure;
let version;
try {
  await verifySubprocessLimits(guard);
  version = await runE2E(options, sandbox);
} catch (error) {
  failure = error;
}
try {
  assertRealClaudeUnchanged(guard, failure ? "failure path" : "success path");
} catch (error) {
  failure ??= error;
}
rmSync(sandbox.root, { recursive: true, force: true });
if (failure) throw failure;

console.log(`install e2e (local, ${options.scope}): ok on ${version}`);
console.log("verified: add, install, disable, uninstall, and marketplace remove in a throwaway environment");
console.log("verified: the installed cache holds only the manifest and the output style");
console.log("verified: outputStyle, permissions, hooks, and MCP settings survive the whole lifecycle");
console.log("verified: process-tree timeout, output-size limit, and an untouched real ~/.claude");
console.log(
  "not verified here: the rendered style text. Disable is checked through what a fresh process reports, " +
    "which is the state a new session reads, and not by generating a model response.",
);
