# Changelog

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- The `Plain English` output style, with a contract test that pins the plugin
  surface to one manifest and one style and pins the style text by SHA-256.
- Synthetic English quality fixtures and a deterministic evaluator that applies a
  factual hard gate and reports readability as an observation.
- A blinded Default versus Plain English comparison harness with opt-in model
  calls, isolated runs, opaque rating packets, and commitment hashes.
- An isolated install, disable, and uninstall E2E for user and project scope.
- Documentation, deterministic CI, a public-boundary check, and a release gate
  that requires an external benchmark attestation.

No version has been released. The blinded comparison has not been run, so the
release gate cannot pass yet.
