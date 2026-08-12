import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPECTED_STYLE_SHA256 =
  "621009bbab2e91d4aef1edf145ed2c79ce03c2cecbaeb4e6e5f8df6f084e9587";
const EXPECTED_MANIFEST_VERSION = "0.0.0";
const ALLOWED_PLUGIN_PATHS = new Set([
  ".claude-plugin",
  ".claude-plugin/plugin.json",
  "output-styles",
  "output-styles/plain-english.md",
]);
const PROHIBITED_COMPONENTS = new Set([
  "skills",
  "agents",
  "commands",
  "hooks",
  ".mcp.json",
  ".lsp.json",
  "bin",
  "scripts",
  "settings.json",
  "package.json",
]);
// The style must keep the evidence commitments the plugin is built on. These
// probes are coarse on purpose: the SHA-256 pin owns exact wording, and these
// name the commitments a rewrite must not silently drop.
const REQUIRED_STYLE_COMMITMENTS = [
  { label: "factual fidelity", pattern: /Factual fidelity outranks polish/ },
  { label: "unknowns and failures", pattern: /Never bury an unknown, a failure/ },
  { label: "unperformed verification", pattern: /a check you did not run/ },
  { label: "claim strength", pattern: /Preserve the strength of a claim/ },
  { label: "technical identifiers", pattern: /Keep code identifiers, commands, file names/ },
  { label: "clear is not short", pattern: /means clear and direct, not short/ },
];

function readJson(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON at ${path}: ${error.message}`);
  }
  assert(
    parsed && typeof parsed === "object" && !Array.isArray(parsed),
    `${path} must contain an object`,
  );
  return parsed;
}

function assertExactKeys(object, expectedKeys, label) {
  assert.deepEqual(
    Object.keys(object).sort(),
    [...expectedKeys].sort(),
    `${label} has unexpected or missing fields`,
  );
}

function parseFrontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n(?:\n|$)([\s\S]*)$/);
  assert(match, "style must have a complete YAML frontmatter block");

  const fields = Object.create(null);
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-z][a-z-]*):(?: (.*))?$/);
    assert(field, `invalid frontmatter line: ${line}`);
    assert(!(field[1] in fields), `duplicate frontmatter field: ${field[1]}`);
    fields[field[1]] = field[2] ?? "";
  }
  assert(match[2].trim(), "style body must not be empty");
  return { fields, body: match[2] };
}

function walkPlugin(pluginRoot) {
  const found = [];
  function walk(directory) {
    for (const entry of readdirSync(directory)) {
      const absolutePath = join(directory, entry);
      const pluginPath = relative(pluginRoot, absolutePath);
      const stat = lstatSync(absolutePath);
      assert(!stat.isSymbolicLink(), `symlink is prohibited: ${pluginPath}`);
      assert(
        ALLOWED_PLUGIN_PATHS.has(pluginPath),
        `prohibited component or extra file: ${pluginPath}`,
      );
      assert(!PROHIBITED_COMPONENTS.has(entry), `prohibited component: ${pluginPath}`);
      assert(stat.isDirectory() || stat.isFile(), `unsupported filesystem entry: ${pluginPath}`);
      if (stat.isFile()) {
        assert.equal(stat.mode & 0o111, 0, `executable is prohibited: ${pluginPath}`);
      }
      found.push(pluginPath);
      if (stat.isDirectory()) walk(absolutePath);
    }
  }
  walk(pluginRoot);
  assert.deepEqual(
    found.sort(),
    [...ALLOWED_PLUGIN_PATHS].sort(),
    "plugin tree does not match the output-style-only allowlist",
  );
}

function validateContract(repositoryRoot) {
  const marketplacePath = join(repositoryRoot, ".claude-plugin", "marketplace.json");
  const pluginRoot = join(repositoryRoot, "plugins", "plain-english");
  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  const stylePath = join(pluginRoot, "output-styles", "plain-english.md");

  const marketplace = readJson(marketplacePath);
  assertExactKeys(marketplace, ["name", "description", "owner", "plugins"], "marketplace");
  assert.equal(marketplace.name, "claude-plain-english");
  assert.equal(typeof marketplace.description, "string");
  assert(marketplace.description.trim(), "marketplace description must not be empty");
  assertExactKeys(marketplace.owner, ["name"], "marketplace owner");
  assert.equal(marketplace.owner.name, "Byunghun");
  assert.equal(marketplace.plugins.length, 1, "marketplace must contain exactly one plugin");
  const marketplacePlugin = marketplace.plugins[0];
  assertExactKeys(marketplacePlugin, ["name", "description", "source"], "marketplace plugin entry");
  assert.equal(marketplacePlugin.name, "plain-english");
  assert(marketplacePlugin.description.trim(), "marketplace plugin description must not be empty");
  assert.equal(marketplacePlugin.source, "./plugins/plain-english");
  assert(!("version" in marketplacePlugin), "marketplace plugin entry must not own a version");

  const manifest = readJson(manifestPath);
  assertExactKeys(
    manifest,
    ["name", "description", "version", "author", "homepage", "repository", "license", "keywords"],
    "plugin manifest",
  );
  assert.equal(manifest.name, "plain-english");
  assert.equal(
    manifest.version,
    EXPECTED_MANIFEST_VERSION,
    `plugin manifest version must be ${EXPECTED_MANIFEST_VERSION}`,
  );
  assert(manifest.description.trim(), "plugin description must not be empty");
  assert.deepEqual(manifest.author, { name: "Byunghun" });
  assert.equal(manifest.homepage, "https://github.com/byunghun-ben/claude-plain-english");
  assert.equal(manifest.repository, "https://github.com/byunghun-ben/claude-plain-english");
  assert.equal(manifest.license, "MIT");
  assert(
    Array.isArray(manifest.keywords) && manifest.keywords.length > 0,
    "plugin keywords must not be empty",
  );

  const style = readFileSync(stylePath, "utf8");
  const { fields, body } = parseFrontmatter(style);
  assertExactKeys(
    fields,
    ["name", "description", "keep-coding-instructions", "force-for-plugin"],
    "style frontmatter",
  );
  assert.equal(fields.name, "Plain English");
  assert(fields.description.trim(), "style description must not be empty");
  assert.equal(fields["keep-coding-instructions"], "true");
  assert.equal(
    fields["force-for-plugin"],
    "true",
    "the style must apply while the plugin is enabled",
  );

  for (const commitment of REQUIRED_STYLE_COMMITMENTS) {
    assert(commitment.pattern.test(body), `style must keep its ${commitment.label} commitment`);
  }
  // The English style is written natively. Korean source text would mean the
  // style was translated rather than authored for English readers.
  assert(!/[ᄀ-ᇿ㄰-㆏가-힯]/.test(style), "style must be English-only");

  assert.equal(
    createHash("sha256").update(style).digest("hex"),
    EXPECTED_STYLE_SHA256,
    "style SHA-256 must match the reviewed text",
  );

  walkPlugin(pluginRoot);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "plain-english-contract-"));
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "plugins"), { recursive: true });
  cpSync(
    join(REPOSITORY_ROOT, ".claude-plugin", "marketplace.json"),
    join(root, ".claude-plugin", "marketplace.json"),
  );
  cpSync(join(REPOSITORY_ROOT, "plugins", "plain-english"), join(root, "plugins", "plain-english"), {
    recursive: true,
  });
  return root;
}

function negativeCase(name, mutate, expectedMessage) {
  const root = makeFixture();
  try {
    mutate(root);
    assert.throws(() => validateContract(root), expectedMessage, `${name} must fail closed`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

validateContract(REPOSITORY_ROOT);

negativeCase(
  "prohibited component",
  (root) => {
    const path = join(root, "plugins", "plain-english", "skills", "unexpected.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "prohibited\n");
  },
  /prohibited component or extra file/,
);

negativeCase(
  "extra file inside an allowed directory",
  (root) => {
    writeFileSync(join(root, "plugins", "plain-english", "output-styles", "extra.md"), "extra\n");
  },
  /prohibited component or extra file/,
);

negativeCase(
  "additional marketplace plugin",
  (root) => {
    const path = join(root, ".claude-plugin", "marketplace.json");
    const marketplace = readJson(path);
    marketplace.plugins.push({
      name: "unexpected",
      description: "Unexpected",
      source: "./plugins/unexpected",
    });
    writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`);
  },
  /exactly one plugin/,
);

negativeCase(
  "version mismatch",
  (root) => {
    const path = join(root, "plugins", "plain-english", ".claude-plugin", "plugin.json");
    const manifest = readJson(path);
    manifest.version = "9.9.9";
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  },
  /version must be 0\.0\.0/,
);

negativeCase(
  "missing force-for-plugin",
  (root) => {
    const path = join(root, "plugins", "plain-english", "output-styles", "plain-english.md");
    const style = readFileSync(path, "utf8").replace("\nforce-for-plugin: true", "");
    writeFileSync(path, style);
  },
  /style frontmatter has unexpected or missing fields/,
);

negativeCase(
  "invalid frontmatter",
  (root) => {
    const path = join(root, "plugins", "plain-english", "output-styles", "plain-english.md");
    const style = readFileSync(path, "utf8").replace("description: Direct", "description Direct");
    writeFileSync(path, style);
  },
  /invalid frontmatter line/,
);

negativeCase(
  "dropped evidence commitment",
  (root) => {
    const path = join(root, "plugins", "plain-english", "output-styles", "plain-english.md");
    const style = readFileSync(path, "utf8").replace(
      /- Never bury an unknown, a failure[^\n]*\n/,
      "",
    );
    writeFileSync(path, style);
  },
  /must keep its unknowns and failures commitment/,
);

negativeCase(
  "unexpected style edit",
  (root) => {
    const path = join(root, "plugins", "plain-english", "output-styles", "plain-english.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nAn unreviewed instruction.\n`);
  },
  /style SHA-256 must match the reviewed text/,
);

negativeCase(
  "translated style text",
  (root) => {
    const path = join(root, "plugins", "plain-english", "output-styles", "plain-english.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n한국어 문장.\n`);
  },
  /style must be English-only/,
);

negativeCase(
  "symlinked plugin file",
  (root) => {
    const path = join(root, "plugins", "plain-english", "output-styles", "plain-english.md");
    rmSync(path);
    symlinkSync(
      join(REPOSITORY_ROOT, "plugins", "plain-english", "output-styles", "plain-english.md"),
      path,
    );
  },
  /symlink is prohibited/,
);

negativeCase(
  "executable plugin file",
  (root) => {
    chmodSync(join(root, "plugins", "plain-english", "output-styles", "plain-english.md"), 0o755);
  },
  /executable is prohibited/,
);

console.log("plugin contract: ok");
