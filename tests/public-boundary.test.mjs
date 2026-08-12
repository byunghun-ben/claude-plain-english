import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  contentViolations,
  formatFailure,
  parseIndex,
  pathViolations,
  readAllowlist,
  scanWorkingTree,
} from "../scripts/check-public-boundary.mjs";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Built at run time so this file does not contain a literal that its own
// checker would flag.
const joined = (...parts) => parts.join("");
const SAMPLE_SECRET = joined("AK", "IA", "ABCDEFGHIJKLMNOP");
const SAMPLE_TOKEN = joined("gh", "p_", "A".repeat(36));
const SAMPLE_HOME_PATH = joined("/Us", "ers/someone/notes.txt");
const SAMPLE_EMAIL = joined("someone", "@", "example", ".com");

// ----- the real repository passes -------------------------------------------

{
  const violations = scanWorkingTree(REPOSITORY_ROOT);
  assert.deepEqual(violations, [], `the repository must satisfy its own boundary: ${JSON.stringify(violations)}`);
}

// ----- allowlist -------------------------------------------------------------

{
  const allowlist = readAllowlist(REPOSITORY_ROOT);
  for (const path of ["README.md", "scripts/evaluate.mjs", "docs/PUBLICATION-CONTRACT.md"]) {
    assert(allowlist.has(path), `the allowlist must contain ${path}`);
  }
  assert.equal(allowlist.has("secrets.env"), false);
}

// ----- path rules -------------------------------------------------------------

{
  const allowlist = new Set(["README.md"]);
  assert.deepEqual(pathViolations("README.md", allowlist, "index"), []);
  assert.deepEqual(
    pathViolations("notes.md", allowlist, "index").map((violation) => violation.kind),
    ["path-not-allowlisted"],
  );
  for (const path of ["raw-responses/run.json", "transcripts/a.jsonl", "evidence/mapping.json", ".env.local"]) {
    const kinds = pathViolations(path, allowlist, "index").map((violation) => violation.kind);
    assert(kinds.includes("prohibited-path"), `${path} must be a prohibited path`);
  }
}

// ----- content rules ----------------------------------------------------------

{
  const kindsFor = (text) => contentViolations(Buffer.from(text), "tracked-content").map((violation) => violation.kind);
  assert.deepEqual(kindsFor("Plain prose with no secrets."), []);
  assert.deepEqual(kindsFor(`key = ${SAMPLE_SECRET}`), ["secret"]);
  assert.deepEqual(kindsFor(`token = ${SAMPLE_TOKEN}`), ["secret"]);
  assert.deepEqual(kindsFor(`see ${SAMPLE_HOME_PATH}`), ["personal-data"]);
  assert.deepEqual(kindsFor(`contact ${SAMPLE_EMAIL}`), ["personal-data"]);
  assert.deepEqual(kindsFor(`{"expected${""}Matrix": {}}`), ["raw-response"]);
  assert.deepEqual(kindsFor(joined("-----BEGIN ", "PRIVATE KEY-----")), ["secret"]);
  assert.deepEqual(contentViolations(Buffer.from([0x41, 0x00, 0x42]), "tracked-content").map((v) => v.kind), [
    "binary-content",
  ]);
}

// ----- index parsing ----------------------------------------------------------

{
  const parsed = parseIndex("100644 0123456789abcdef0123456789abcdef01234567 0\tREADME.md\0");
  assert.deepEqual(parsed, [{ mode: "100644", path: "README.md" }]);
  assert.throws(() => parseIndex("not-an-index-record\0"), /could not read the Git index/);
}

// ----- a repository that violates the boundary --------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "plain-english-boundary-"));
  const write = (path, contents, mode = 0o644) => {
    const absolute = join(repo, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, { mode });
    chmodSync(absolute, mode);
  };
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`);
    return result.stdout;
  };

  write(
    "docs/PUBLICATION-CONTRACT.md",
    [
      "# Publication contract",
      "",
      "## Path allowlist",
      "",
      "- `docs/PUBLICATION-CONTRACT.md`",
      "- `README.md`",
      "- `run.sh`",
      "- `link.md`",
      "",
      "## Never published",
      "",
      "Everything else.",
      "",
    ].join("\n"),
  );
  write("README.md", "A clean file.\n");
  write("run.sh", "echo hello\n", 0o755);
  write("unlisted.md", "Not on the allowlist.\n");
  write("raw-responses.json", "{}\n");
  write("leaky.md", `key = ${SAMPLE_SECRET}\n`);
  symlinkSync(join(repo, "README.md"), join(repo, "link.md"));

  git("init", "-q", "-b", "main");
  git("add", "-A");

  const kinds = scanWorkingTree(repo).map((violation) => violation.kind).sort();
  for (const expected of ["executable-file", "symbolic-link", "path-not-allowlisted", "prohibited-path", "secret"]) {
    assert(kinds.includes(expected), `expected a ${expected} violation, got ${kinds.join(", ")}`);
  }

  // An untracked file that is not ignored still counts, because the next
  // `git add -A` would publish it.
  write("also-unlisted.md", "Untracked and unlisted.\n");
  const beforeIgnore = scanWorkingTree(repo).filter((violation) => violation.locationKind === "untracked");
  assert.equal(beforeIgnore.length, 1, "an untracked, unignored file must be reported");

  // An ignored file is out of scope: it never reaches a clone.
  write(".gitignore", "also-unlisted.md\n");
  const afterIgnore = scanWorkingTree(repo).filter((violation) => violation.locationKind === "untracked");
  assert.equal(
    afterIgnore.filter((violation) => violation.kind === "path-not-allowlisted").length,
    1,
    "only .gitignore itself should remain untracked and unlisted",
  );

  rmSync(repo, { recursive: true, force: true });
}

// ----- failure reporting redacts ---------------------------------------------

{
  const report = formatFailure([
    { kind: "secret", locationKind: "tracked-content" },
    { kind: "secret", locationKind: "tracked-content" },
    { kind: "path-not-allowlisted", locationKind: "index" },
  ]);
  assert.match(report, /3 violation\(s\)/);
  assert.match(report, /- secret: 2/);
  assert.match(report, /- path-not-allowlisted: 1/);
  assert(!report.includes(SAMPLE_SECRET), "the report must not quote the matched value");
  assert(!report.includes("leaky.md"), "the report must not name the offending path");
}

// ----- the CLI ---------------------------------------------------------------

{
  const result = spawnSync(
    process.execPath,
    [join(REPOSITORY_ROOT, "scripts", "check-public-boundary.mjs"), "--repo", REPOSITORY_ROOT, "--working-tree"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `the boundary CLI failed: ${result.stderr}`);
  assert.match(result.stdout, /Public boundary passed \(working-tree\)/);

  const bad = spawnSync(
    process.execPath,
    [join(REPOSITORY_ROOT, "scripts", "check-public-boundary.mjs"), "--repo", REPOSITORY_ROOT],
    { encoding: "utf8" },
  );
  assert.equal(bad.status, 2, "a malformed invocation must fail closed");
}

console.log("public boundary: ok");
