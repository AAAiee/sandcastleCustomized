# Historical customization baseline

The pre-rebuild baseline is retained in local commit
`1cd36c8d15c60ec6fa19071260ca202ac9de5aad`, branch
`sandcastle/issue-32-host-validation`. It preserved the former custom runner and
host helpers, along with 29 inherited behavior tests and two explicit-policy
checks. Its `docs/baseline/README.md` records ownership and source provenance.
Use the commit as a read-only historical reference; it is not the current
workflow or an instruction to install or activate that runtime.

The exact original 32-test suite, source manifest and checksum verifier remain
consumer-owned, outside this package. Fresh preservation verification on
2026-10-18 passed all 32 tests on Windows/Node v22.13.0. This result validates the
inactive snapshot, not this fork's current public workflow or native acceptance.

The rebuild starts from original published source
`e99f832f26dc9d245c019a9ddd19fa5dee792427` and implements the current opt-in
contracts in [workflow.md](../workflow.md),
[workflow-integrations.md](../workflow-integrations.md) and
[workflow-runtime.md](../workflow-runtime.md). Legacy runner modules, copied
asset hooks, package exports and delivery defaults are not imported. Behavioral
parity and optimizations are verified at those public interfaces separately.

This document is repository history and is excluded by the package's explicit
`files` allowlist. No project fixture, prompts, credentials, sessions or runtime
history is added to the distributable. No public API or runtime behavior changes
in this preservation carry-forward, so it needs no release changeset.
