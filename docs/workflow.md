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
retry or repair loop.

## Scope and remaining work

This first slice provides candidate-bound stage gates and explicit checkpoint
resume. Persistent retry/repair budgets and automatic reconciliation are later
recovery work. Evidence currently binds the candidate, not policy, dependencies,
toolchain or changed task requirements. Do not reuse checkpoints after changing
those inputs; the later evidence-identity slice will automate invalidation.
Structured-output extraction/correction, queue polling, project locks, telemetry,
diagnostics and task-selection adapters remain separate increments.

The tests in `src/workflow.test.ts` exercise the exported function with a minimal
consumer and actual JSON checkpoint reloads. They cover successful delivery,
failed gates, changed candidates, resumed review, unknown errors, uncertain
effects, failed persistence and cancellation without models or credentials.
