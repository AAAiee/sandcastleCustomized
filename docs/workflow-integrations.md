# Portable workflow integrations

Import these opt-in helpers from `@ai-hero/sandcastle/workflow/integrations`.
They do not change the original SDK or scaffolded templates. The caller supplies
repository identity, selection policy, native validation and publication policy.
No project paths, labels, task numbers, provider configuration or prompts are
embedded in this module.

## Commands and optional host discovery

`createCommandRunner({ cwd, tools?, environment?, githubEnvironment?, timeoutMs? })`
executes Git or GitHub CLI argument arrays without a shell. The default command
timeout is 30 seconds; configuration accepts 1–300,000 milliseconds. Optional
`tools` overrides supply executable paths. Otherwise `findExecutable` searches
PATH. Its optional `candidates` list supports application-specific discovery.

`proxyEnvironment(environment, proxy?)` returns a copy, preserving explicit
uppercase or lowercase proxy overrides. It accepts a single proxy address or
Windows-style `http=address;https=address` settings. `discoverWindowsProxy()` is
optional: on Windows it reads the enabled current-user proxy setting; elsewhere
or when unavailable it returns `undefined`. It never mutates the environment.
Pass the resulting environment as `githubEnvironment` to scope it to GitHub CLI
children. Model processes and Git children keep their own environment.

## Read-only GitHub access

```ts
import {
  createCommandRunner,
  createGitHubReader,
} from "@ai-hero/sandcastle/workflow/integrations";

const reader = createGitHubReader({
  repository: project.repository,
  command: createCommandRunner({ cwd: project.root }),
  signal,
});
const issues = await reader.issues(project.queueLabels);
const openPulls = await reader.pulls();
const blockers = await reader.blockers(selectedIssue.number);
```

Every request is an explicit GET through `gh api`. Collections paginate with a
default limit of 20 pages; hitting the bound throws instead of accepting partial
data. Native issue dependency/sub-issue summaries remain available for consumer
selection policy. The reader does not select tasks or infer local completion.

Reads retry classified transient transport/HTTP failures up to three attempts,
with bounded backoff. Attempts are configurable from 1 to 10. Authentication,
unrecognized responses and unknown failures stop. The invocation's signal bounds
the entire read sequence. These are per-invocation limits; persisted budgets and
process-restart recovery belong to the later recovery layer.

`publishCommentOnce({ marker, body, list, create, ...retryOptions })` is an optional
capability-based helper. It contains no CLI write implementation. Callers must
explicitly provide authorized publication operations and serialize calls sharing
a marker. `list` must return the complete relevant comment collection. A stable,
single-line marker identifies an existing publication. Duplicate matches stop.
After a failed write, the helper reconciles by reading, and never repeats that
write. Missing or unavailable reconciliation leaves an `uncertain` outcome.
An uncertain result must be reconciled before another invocation. This helper
does not implement PR creation or authorize any remote action.

## Prepared validation worktrees

```ts
import { withPreparedWorktree } from "@ai-hero/sandcastle/workflow/integrations";

const result = await withPreparedWorktree(
  {
    source: project.root,
    prepared: project.validationWorktree,
    candidate,
    command,
    saveRecovery: storage.saveWorktreeRecovery,
  },
  async (worktree) => project.validate({ worktree, candidate }),
);
```

The prepared directory must be a separate worktree of the same Git repository.
The candidate is a full commit identity. Before mutation, the helper refuses
untracked paths that collide with candidate files and persists the original
HEAD, branch and unique preservation marker through `saveRecovery`. Dirty work
is stashed with staged, unstaged and untracked changes. Ignored dependency/build
caches remain in place; checkout refuses to overwrite ignored collisions.

The callback runs at the exact detached candidate. Afterwards the helper restores
the original branch/HEAD and applies the stash with its index. Backup stashes are
retained intentionally, even after success. Git's normal filters and line-ending
rules apply; this is Git-native preservation, not a byte-for-byte disk snapshot.
The source checkout is never checked out, reset or cleaned.

Callers must serialize operations sharing a repository and durably retain recovery
records. Do not reuse a prepared worktree with unresolved recovery. If the callback
leaves changes, preservation is ambiguous, the original branch moves or stash
application conflicts, restoration stops without forcing away work.
`WorktreeRestorationError.recovery` identifies the retained stash/marker and
worktree. Preserve these for explicit recovery. Restoration still runs after a
callback error; successful restoration rethrows that original error. This helper
does not automatically resume after process termination or resolve conflicts.

Tests use real temporary Git repositories for preservation, candidate checkout,
ignored-cache reuse and restoration refusal. GitHub transport/publication tests
use deterministic capabilities and perform no remote writes or model calls.
