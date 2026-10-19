# Repository and run isolation

`@ai-hero/sandcastle/workflow/runtime` supplies `withWorkflowRuntime(options,
action)`. Use it around sandbox creation and the workflow, so the repository lock
is acquired before either can perform effects.

```ts
await withWorkflowRuntime(
  {
    repository: project.root,
    projectId: project.id,
    runId: taskRun.id,
    compatibility: project.resourceCompatibility,
    command,
    signal,
  },
  async (runtime) => {
    const sandbox = await runtime.resource("sandbox", {
      identity: project.sandboxCompatibility,
      create: (directory) =>
        project.openSandbox({ directory, branch: `task/${runtime.key}` }),
      close: (sandbox) => sandbox.close(),
    });
    await runWorkflow({
      project,
      checkpoint: await runtime.read("checkpoint"),
      signal,
      operations: {
        ...project.operations(sandbox, runtime.directory),
        save: (state) => runtime.save("checkpoint", state),
      },
    });
  },
);
```

The example's `project` operations/factories are consumer-supplied APIs, not
defaults installed by this package. The original SDK retains sandbox and agent
behavior. Supply prompts, mounts, credentials, tools and publication policy from
the current consumer; do not capture a previous project's configuration in a
shared factory. This scope is an identity/lifecycle boundary, not an OS sandbox.

## Identity, records and locks

`repository` must be a Git checkout. Its canonical common Git directory identifies
the repository, including linked worktrees. Storage lives beneath
`<common-git-dir>/sandcastle/runtime-v1/`. A 128-bit hash of explicit `projectId`
and `runId` selects the run directory; metadata also binds the full identities,
repository and caller-supplied `compatibility` string. `runtime.repository` is
that canonical common Git directory; `runtime.directory` is the run directory.
Names/compatibility strings are identifiers, not places for secret values.

`read(name)` and `save(name, value)` access JSON records under that directory.
Names are simple lowercase identifiers without paths. Records include the full
scope identity. Missing records return `undefined`; copied foreign records or
changed compatibility throw without replacing existing data. Writes flush the
file and atomically rename it. These operations do not claim power-loss durability
for directory entries on every filesystem. Checkpoint payload validation remains
the workflow's responsibility. `assertActive()` and record/resource operations
reject handles retained after the callback closes.

One exclusive writer lock covers the common Git repository, so two linked
worktrees or project/run identities cannot execute conflicting callbacks. A
second invocation fails with `WorkflowRuntimeError.code === "locked"`; it does
not wait forever or steal the lock based on a PID. Lock owner, PID, project/run and
creation time are recorded for inspection, along with host and compatibility.
Interrupted processes require explicit reconciliation; no stale lock is stolen
automatically.

## Compatible resource reuse

`resource(name, { identity, create, close? })` supplies a run-scoped resource
directory to `create`. Repeated/concurrent requests for the same compatible name
share one handle within the callback. Prepared files stay in that directory for
subsequent invocations with the same full scope and resource identity. A different
identity fails before the factory can replace or reuse those files. An unrelated
project/run gets a different directory. Factories must await their effects and
keep persistent resources within their supplied directory or explicitly scoped
SDK branch; names alone do not authorize reusing external caches or containers.

Resources close once in reverse acquisition order before the writer lock is
released. After a normal callback failure, successfully closed resources allow
the original failure to propagate and the lock to release. If creation throws
without returning a handle, or cleanup throws, the lock remains: the resource
outcome needs inspection before replay. Errors use `cleanup` and retain causes.
This resource scope does not guess provider error meanings or automatically replay
factories. Workflow operation budgets are described in [the workflow contract](workflow.md).

## Explicit runtime lock recovery

After a process interruption or unresolved resource cleanup, inspect `writer.lock`
and supply its exact `owner` to `reconcileWorkflowRuntimeLock` from this module.
Use the same repository/project/run/compatibility options plus `expectedOwner` and
an explicit `reconcile({ owner, directory, resources, signal })` callback. The
resource map contains the original names/compatibility identities; the run
directory and prepared files remain intact.

The helper refuses a changed owner, unknown host, active process, changed scope
or concurrent reconciliation. A dead same-host process is necessary for a crashed
active lock, but its PID alone never authorizes recovery. A scope which has
already finished its cleanup attempts marks the lock `cleanup-required` and can
be reconciled in the same host process. Handles from that scope remain closed.

The consumer must inspect/stop its observable owned resources before returning
`{ status: "released", evidence: ["resource inspection log"] }`. The helper records
this evidence and releases the unchanged owner lock, preserving all runtime
records, checkpoints, worktrees and cached files. Return `{ status: "uncertain" }`
or throw to retain the lock. Lost factory responses and failed close calls require
this inspection; do not assert release from a missing handle alone. Recovery is
an explicit operation, not an automatic retry policy or permission to delete
unrelated containers/processes. Legacy locks without host/scope information need
manual inspection; the helper refuses to manufacture ownership evidence.

The runtime stores no module-global current project, credentials, resource handles
or checkpoint. Tests run A then B in the same process, exercise linked-worktree
conflicts, retained/foreign records, resource compatibility, cancellation and
unknown cleanup/creation outcomes. Actual provider credential isolation remains
part of the consumer's sandbox configuration and acceptance.
