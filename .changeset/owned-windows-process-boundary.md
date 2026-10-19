---
"@ai-hero/sandcastle": minor
---

Add an opt-in owned Windows process boundary with suspended job assignment,
whole-job cancellation, durable receipts and explicit read-only reconciliation.
Uncertain cleanup prevents prepared-resource release; unsupported hosts fail
before launching a command. Existing sandbox providers are unchanged.
Commands can explicitly complete when the primary exits, preserving its actual
exit status while stopping remaining owned helpers and confirming whole-job
quiescence; the default still waits for the whole tree.
New jobs use unique Global namespace names for observation across Windows
sessions on the same host. Unresolved legacy session-scoped receipts fail closed;
completed receipts with confirmed cleanup remain usable.
