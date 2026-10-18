# Single-task workflow contract

Import `runWorkflow`, `WorkflowError` and the associated types from
`@ai-hero/sandcastle/workflow`. This module sequences one selected task. The
existing root SDK continues to own agent invocation, sandboxes and worktrees.
This entrypoint does not change existing SDK/template callers.

## Consumer operations

Supply `project: { id, config }` and an implementation of
`WorkflowOperations<typeof config>`. `id` must remain stable across resume and
must distinguish unrelated consumers. The workflow passes `config` through to
the consumer; it interprets no repository, branch, task graph, label, prompt,
platform, command or path inside it.

| Operation                     | Contract                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selectTask(project, signal)` | Read-only selection. Return one task with a nonempty ID and unique, described criteria, or `null` for no eligible work. The consumer owns dependencies and filtering.                                   |
| `implement(context)`          | Implement the selected task and return its candidate identity. This may have side effects.                                                                                                              |
| `currentCandidate(context)`   | Read the actual current candidate. Return an identity for all code covered by acceptance; the workflow treats it as opaque.                                                                             |
| `validate(context)`           | Read-only host validation. Return the exact candidate, `passed`, and nonempty evidence references.                                                                                                      |
| `review(context)`             | Independent, read-only review. Return the exact candidate, approval, and one satisfied result with meaningful evidence per supplied criterion. The consumer creates an independent reviewer invocation. |
| `deliver(context)`            | Perform only the delivery explicitly selected by the consumer. Return the approved candidate and a nonempty receipt/reference. No delivery operation is installed by default.                           |
| `save(checkpoint)`            | Durably replace the checkpoint before resolving. Reject on a failed write. The consumer chooses repository-scoped storage.                                                                              |

Operations are trusted application code. Validation and review must not modify
the candidate. Delivery must check/conditionally act on its supplied candidate
where concurrent changes are possible. Serialize executions that share a
checkpoint or worktree. The workflow itself opens no files and makes no network
requests. All operations receive the provided project; task stages also receive
an optional `AbortSignal` and must honor cancellation while they are running.

## Gates and saved progress

Successful order is selection, implementation, validation, review, delivery,
ready. A gate failure stops the invocation and saves its current phase. It does
not request another implementation or retry. Validation must pass for the exact
candidate. Review must approve that candidate and cover all criteria exactly
once; omitted, duplicate, failed or empty-evidence entries cannot authorize
delivery. The actual candidate is checked again before each gate and completion.

An explicit invocation with a persisted review-phase checkpoint repeats review,
then delivery. It does not repeat implementation or passing validation. A ready
checkpoint is checked and returned without delivering again. An idle checkpoint
remains idle; start a new invocation without that checkpoint to select new work.

Implementation and delivery intent are saved before their side effects start.
If one throws, or the process exits before its completed transition is saved,
the stored `inFlight` marker prevents automatic replay. `WorkflowError.code` is
`uncertain` on such a resume. Reconcile the effect through explicit operator or
application logic before constructing a corrected checkpoint. Do not clear the
marker simply to force another attempt. If persistence fails, reload the last
durable checkpoint; `error.checkpoint` is diagnostic memory, not proof of a
successful write.

Errors preserve the cause and checkpoint. `operation` means an unclassified
operation error, `gate` means failed candidate/acceptance/review/receipt checks,
`persistence` means a failed checkpoint write, and `cancelled` reflects an aborted
signal. Invalid project/state input and uncertain side effects are separate
codes. There is no provider-specific error-message matching and no automatic
retry or repair loop unless the explicit recovery mode below is enabled.

## Durable recovery

Set `recovery: {}` on a **new** `runWorkflow` invocation to enable fixed budgets:
three total implementation attempts, and three total transport attempts for each
operation on each implementation candidate. Once a checkpoint contains its
`recovery` ledger, omitting this option on resume does not disable the ledger or
reset its counters. Legacy mid-task checkpoints without counters cannot be
upgraded by inventing unused attempts. Start a separately reviewed task/run when
intentionally allocating a new budget; do not delete counters to force retries.

Classify errors at the boundary that knows their meaning:

```ts
import { WorkflowOperationError } from "@ai-hero/sandcastle/workflow";

// Your transport adapter has independently established a transient disconnect.
throw new WorkflowOperationError("transport", "Connection interrupted", cause);
```

`transport` retries the affected operation. `substantive` requests implementation
repair and fresh validation/review. Well-formed negative validation/review results
also request repair. `permanent` stops, and `format` stops distinctly. The explicit
review-output policy below handles extraction failures before they become operation
errors. Neither unknown failures nor error-message
substrings are treated as transient. Unknown read failures stop persistently;
unknown writes can be accepted only after observable completion, never blindly
replayed. Existing root SDK provider retry behavior remains unchanged.

Every attempt is charged and flushed before invocation. The ledger records the
operation, consumed attempts, status, failure kind/message and retry deadline.
Backoff is 500ms then 1000ms, including a persisted earliest retry time when a
process ends after intent is flushed. `recovery.now` and `recovery.wait` are
optional time boundaries for deterministic tests. Callbacks must honor the abort
signal; the workflow waits abortably by default. An exhausted budget saves the
phase and throws `WorkflowError.code === "exhausted"`; repeated ordinary resume
does not invoke the exhausted operation again. Earlier passing implementation and
validation remain available after review/delivery transport interruptions.

Operations receive `context.attempt = { operation, implementation, transport }`
from the persisted counters. Repair receives `context.repair = { phase, message }`.
These are also available in checkpoints/errors for telemetry. Transport attempts
are not extra implementation attempts.

Implementation and delivery may already have performed effects after an
interruption. Supply `recovery.reconcile(context)` to observe them. It receives
the phase, attempt, task and available candidate/validation/review. Return:

- `{ status: "completed", value }` with the actual operation result/receipt. The
  usual candidate, acceptance and receipt gates still apply.
- `{ status: "not-started" }` only when observation establishes that replay is
  safe. This permits replay of a classified transport failure or crashed intent.
- `{ status: "uncertain" }` to preserve the checkpoint and stop without replay.

Reconciliation reads have their own persisted three-attempt transport budget.
Unavailable reads cannot authorize repeating a write. An uncertain or not-started
observation is read again on a later resume, rather than reused as timeless proof;
the read budget remains bounded. A known completed result can be reused. A
receipt for the wrong candidate never authorizes completion. No remote write,
publication text, issue closure or PR creation is installed by this API.

## Strict review output and one correction

The optional `reviewOutput` policy enables durable recovery and strict output
extraction for a **new** workflow. Supply an independent correction operation:

```ts
await runWorkflow({
  project,
  operations, // review may return raw stdout instead of a parsed object
  reviewOutput: {
    correct: async ({
      task,
      candidate,
      validation,
      output,
      problem,
      attempt,
    }) =>
      independentReviewer({
        task,
        candidate,
        validation,
        output,
        problem,
        attempt,
      }),
  },
});
```

`independentReviewer` above is a consumer-supplied operation, not an SDK helper.
It should reformat the same independent findings, preserving rejection when code
does not satisfy the criteria. Operations remain responsible for read-only review
and provider/transport error classification. The existing root SDK `Output`
helpers, `sandbox.run`, session lifecycle and per-call retries are unchanged.

`extractWorkflowReview(output, { task, candidate })` is also exported from the
workflow entrypoint. It accepts a complete strict JSON object, a final JSON fence
after prose, or the final `<review>` tag beginning a line (optional JSON fence
inside). The representation must end the output; no trailing text is accepted.
The last tag or fence of the selected representation wins; mixed ambiguous
representations are refused. Malformed final output never falls back to an earlier
approval. JSONC, arbitrary embedded object scanning and schema coercion are not
supported. Object inputs receive the same checks. Literal markup inside JSON
evidence remains ordinary string content.

The object must contain `task` equal to `context.task.id`, the exact `candidate`,
a boolean `approved`, and `criteria: [{ id, satisfied, evidence }]` covering every
task criterion exactly once, with boolean outcomes and nonempty evidence. A valid
negative decision is substantive rejection and requests bounded code repair; it
does not spend a format correction or become an invitation to approve the code.

Extraction occurs first. If malformed, `reviewCorrection` is flushed with
`consumed: true`, the original output and deterministic feedback **before** the
correction invocation. There is at most one logical correction per task,
candidate, implementation attempt and evidence generation. Review and correction
have separate persisted three-attempt transport ledgers. Transport interruption
or ordinary restart cannot grant another logical correction. A malformed
correction stops with `code: "format"`; exhausted transport stops with
`code: "exhausted"`. Saved successful output can be reused after a checkpoint
reload. Unclassified/permanent errors retain the existing stop behavior.

Strict review policy is sticky in its checkpoint. Resume requires the explicit
correction callback; omitting it fails configuration rather than disabling the
gates. Evidence-generation invalidation creates a new independent review and
correction scope, retaining the prior operation ledger; old correction output
cannot authorize the changed evidence. Candidate/validation/approval gates remain
in force before delivery. Without this policy, existing parsed-review callers
retain their previous contract.

## Scope and remaining work

The workflow provides candidate-bound stage gates, explicit checkpoint resume
and opt-in durable recovery. Evidence currently binds the candidate, not policy, dependencies,
toolchain or changed task requirements. Do not reuse checkpoints after changing
those inputs; the later evidence-identity slice will automate invalidation.
Queue polling, diagnostics and
task-selection adapters remain separate increments. Repository/run locks and
explicit resource reconciliation are documented in [runtime isolation](workflow-runtime.md).

The tests in `src/workflow.test.ts` exercise the exported function with a minimal
consumer and actual JSON checkpoint reloads. They cover successful delivery,
failed gates, changed candidates, resumed review, unknown errors, uncertain
effects, failed persistence and cancellation without models or credentials.
