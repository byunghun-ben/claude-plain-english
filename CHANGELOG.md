# Changelog

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v0.1.0

### Added

- The `Plain English` output style, with a contract test that pins the plugin
  surface to one manifest and one style and pins the style text by SHA-256.
- Synthetic English quality fixtures and a deterministic evaluator that applies a
  factual hard gate and reports readability as an observation.
- A blinded Default versus Plain English comparison harness with opt-in model
  calls, isolated runs, opaque rating packets, and commitment hashes.
- An isolated install, disable, and uninstall E2E for user and project scope.
- Documentation, deterministic CI, a public-boundary check, and a release gate
  for repository and release metadata.
- A hardened comparison sandbox that disables tools, skills, external settings,
  MCP, and session persistence and passes only supported authentication and
  essential process environment variables.
- A process-description boundary and regression case that reject unstated
  artifact reuse, environment properties, and automation details.

The optional blinded comparison has not been run and is not a release
requirement.
