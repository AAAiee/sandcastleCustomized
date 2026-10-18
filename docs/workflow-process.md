# Owned host processes

`@ai-hero/sandcastle/workflow/process` exports `createOwnedProcessRunner` and
`OwnedProcessError`. This optional boundary runs explicit Windows host tools in
an owned JobObject. It does not change the SDK sandbox providers, discover tools,
retry a command, or grant permission to publish anything.

```ts
import { createOwnedProcessRunner } from "@ai-hero/sandcastle/workflow/process";

const processes = createOwnedProcessRunner({
  directory: resourceDirectory, // exclusive caller-owned project/run resource
  windowsPowerShell: configuredPowerShell7,
});
const result = await processes.run({
  executable: configuredTool,
  args: ["--check"],
  cwd: preparedCheckout,
  timeoutMs: 60_000,
  signal,
});
processes.assertQuiescent(); // required before checkout restoration/release
```

The caller must serialize ownership of `directory`, for example with
`withWorkflowRuntime`. Keep this directory and its receipts when cleanup is
uncertain. The runner refuses another command while any operation is unresolved;
creating another runner does not erase uncertainty. The result contains captured
`stdout`, `stderr`, actual `exitCode`, authoritative receipt path `record`, and
`quiescent: true`. An ordinary nonzero exit is a completed result, leaving its
meaning to the consumer's validation policy.

Windows 10 / Server 2016 or newer requires an explicit absolute PowerShell 7 executable, an absolute
executable and working directory, literal arguments, and a positive bounded
timeout. The embedded supervisor is part of the built module, so no external
script checkout is needed. It records supervisor identity before permitting job
creation, creates the child suspended with atomic job membership using
`PROC_THREAD_ATTRIBUTE_JOB_LIST`, verifies its named non-breakaway
KillOnJobClose job, and waits for a durable ownership acknowledgment before
resuming the child. Child stdout/stderr remain beside the JSON receipt.

Cancellation, stdin EOF, or the supervisor watchdog terminates the whole job and
checks `ActiveProcesses == 0` before reporting confirmed cleanup. The supervisor
also waits for descendants after the primary child exits. `OwnedProcessError`
has `kind` (`cancelled`, `timeout`, `configuration`, `uncertain`), `quiescent`, and
the receipt path where available. A failed observer cannot permit execution
before ownership persistence or leave an acknowledged running job behind.

On an unexpected supervisor exit, `quiescent` is false even though KillOnJobClose
normally initiates kernel cleanup. Preserve resources and the runtime lock.
An explicit `await processes.reconcile()` performs read-only observation of
the recorded supervisor PID **and start time**, then queries only the recorded
named job. It records `reconciled` only after the supervisor cannot authorize
more work and the job is absent or has zero active processes. It never terminates
anything or retries a command. An intent with no supervisor identity cannot have
received the creation acknowledgment; reconciliation still refuses it while its
parent owner may be alive. Access failures, malformed identities, and active
supervisors remain unresolved. PID absence alone never establishes that an
executing process tree has stopped.

This is a containment boundary for cooperating build tools and their normal
Win32 descendants. It is not a security sandbox against a malicious same-user
process, and cannot contain tools that delegate work to an existing service,
remote daemon, WMI process creation, or shared compiler server outside the job.
Consumers must disable such reuse or use an exclusive owned service. The runner
does not set machine-wide environment variables or kill unrelated services.

POSIX hosts currently reject with a quiescent `configuration` error **before
launching a command**. There is no parent-PID-only fallback. A future process-group
implementation must establish equivalent ownership and termination evidence.

Primary API basis:

- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
- [Process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
- [Atomic job-list creation attribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)

For an actual installed-package smoke test, copy
`scripts/owned-process-consumer.mjs` into a fresh consumer containing the package
and run it there with `--module @ai-hero/sandcastle/workflow/process --pwsh <path>`.
An alias such as `@rebuild/sandcastle/workflow/process` is supported. This fixture
uses the package export, executes a real child/grandchild heartbeat, and checks
that writes stop before resource restoration is permitted.
