# Workflow measurements

Import `createWorkflowMeasurements` from `@ai-hero/sandcastle/workflow/measurements`.
It wraps explicit operations without changing models, duration bounds, retries,
acceptance gates or token limits. Stage and check names are consumer inputs; future
diagnostic and output-correction operations use the same interface.

```ts
const measurements = createWorkflowMeasurements({
  identity: {
    project: "repository-id",
    run: "run-id",
    task: "task-id",
    environment: "runner-toolchain-dependencies-v1",
  },
  previous: await storage.read("measurements"),
  save: (report) => storage.save("measurements", report),
});
await measurements.measure(
  { stage: "review", attempt: 1, retries: 0 },
  async (observation) => {
    const result = await sandbox.run(reviewOptions);
    const usage = result.iterations.at(-1)?.usage;
    if (usage) observation.usage({ ...usage, scope: "last-message" });
    return result;
  },
);
```

`identity` must match a loaded report exactly. Consumers supply their scoped,
durable storage. Each invocation saves a `running` record before the operation and
its final outcome/duration afterward. Recovered `running` records become
`interrupted`, with unknown duration/outcome explicitly recorded. This does not
authorize replay or recover side effects. Serialize calls through a single
collector/storage owner. `report()` returns a detached copy.

`attempt` defaults to that stage/check's invocation ordinal, including interrupted
records. A recovery policy can explicitly supply its durable attempt and retry
counts. Missing retry counts remain `null`, with an explanation; they never become
an assumed zero. `rejected()` distinguishes completed substantive rejection from a
successful result. A thrown operation is `failed`; both operation and telemetry
storage errors survive in an `AggregateError` if final persistence also fails.

Durations use the monotonic host clock and exclude the collector's initial/final
storage time. Nested checks and their parent stage overlap: do not sum them as
end-to-end wall time. Incomplete records have `null` duration. Optional `now` is a
clock seam for deterministic tests, not a way to infer missing historical timings.

Usage uses the SDK's shape: `inputTokens` is fresh input excluding cache creation
and cache reads. Total input is fresh input + cache creation + cache reads; cached
input is cache reads and fresh input includes cache creation. For Codex, the SDK
already subtracts cached input from `inputTokens`; do not add it to that field
again. Negative, non-integer, non-finite or overflowing counters are unavailable.

`scope: "stage-total"` declares complete cumulative usage for the measured operation.
`scope: "last-message"` is the original SDK's documented snapshot. A snapshot is
preserved as `observedUsage`; all cumulative stage token fields remain `null` with
an explanation. Repeated `usage()` calls replace the supplied observation rather
than summing potentially cumulative provider snapshots. Missing provider data also
remains `null`, never zero. Non-model checks therefore naturally lack token data.

These are token observations, not peak/live context, context-window percentages,
cost, or savings. Do not sum repeated snapshots to manufacture stage totals. Any
comparison must identify task mix, candidate, environment, completeness and agent
mode. A scripted consumer baseline can establish accounting and host timing, but
cannot establish production model-token or native-validation savings.
