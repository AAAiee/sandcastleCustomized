# Build and update a pinned workflow package

Keep the original SDK baseline and candidate workflow pins independent. Consume
the candidate through an immutable registry version, or a repository-local archive
whose filename contains its SHA-256. Commit the consumer manifest, lockfile and
archive/provenance together. Do not use a mutable global `npm link` or a directory
dependency that silently changes when another checkout is edited.

`scripts/package-revision.mjs` builds an exact committed revision in a local,
immutable Linux Docker image using already prepared Linux dependencies. It:

1. Verifies the prepared dependency lockfile matches the selected revision.
2. Exports canonical tracked source with `git archive`, excluding untracked edits,
   credentials and runtime state. Git source bytes do not depend on checkout CRLF.
3. Builds and packs in a fixed container directory with read-only dependencies,
   no network, no image pulling and no host credentials. Original postbuild and
   public type checks run. The container is removed after the attempt.
4. Writes build logs, package inventory and provenance containing the exact
   revision, lock/source/package hashes, image ID and Node/npm toolchain.

From the fork source checkout, supply the current machine's explicit paths:

```powershell
node scripts/package-revision.mjs --revision $revision --image $imageId --dependencies $linuxNodeModules --output $firstOutput --docker $dockerExecutable
node scripts/package-revision.mjs --revision $revision --image $imageId --dependencies $linuxNodeModules --output $secondOutput --docker $dockerExecutable
```

`$revision` is a full committed SHA; `$imageId` is an already available
`sha256:...` image ID. Each output directory must be fresh. `$linuxNodeModules`
ends in `node_modules`, with its matching `package-lock.json` in the parent. Prepare
this cache deliberately once for that lockfile; do not mount Windows-native
dependencies into Linux. An incompatible/missing cache fails instead of fetching
dependencies during a workflow. The default Docker executable is `docker`.

Compare `provenance.json` and the package SHA-256 from both outputs. Reproduction
is scoped to the recorded image/toolchain and dependency cache; different inputs
are a new candidate build, not evidence that the old archive was reproduced.
The build script does not claim to verify a maliciously altered dependency cache.

## Deliberate consumer update

1. Preserve the current known package pin and runtime/handoff evidence. Select a
   reviewed fork revision and build it using the procedure above.
2. Inspect the actual package inventory/content for project paths, adapters,
   prompts, credentials, logs and session history. Generic upstream scaffold
   templates remain part of the original SDK; consumer configuration does not.
3. Copy the verified archive to the consumer's vendor directory with its content
   hash in the filename. Record the fork revision, artifact hash and build inputs.
   Update only the intended dependency and regenerate the lockfile, for example
   with `npm install --offline --ignore-scripts --no-audit --no-fund` using the
   prepared npm cache. A new machine can prepare its cache explicitly once.
4. Run the public integration suite and independent A-then-B installed-package
   scenarios, including failed validation, review resume and existing consumer
   budget refusal. Verify the original SDK pin and project origin remain fixed.
5. After parity passes, remove superseded generic implementations from the
   active consumer. Retain historical commits/archives and recovery evidence.
   Start a new run/compatibility identity when dependencies or resource policy
   change. Do not force old checkpoints to authorize a changed environment.

Use `npm ci --offline --ignore-scripts --no-audit --no-fund` for repeated installs
with the committed lockfile and prepared cache. Native acceptance, publishing and
promotion remain consumer/human policy; this procedure creates no PR or push.
