import { Effect } from "effect";
import {
  runWorkflowEffect,
  runWorkflowSync,
  workflowProgram,
  workflowStep,
  workflowSync,
  workflowFile,
  workflowValue,
} from "./workflow-effects.js";
import { atomicReplace } from "./workflow-persistence.js";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import type { Command } from "./workflow-integrations.js";

/** Public runtime error; code identifies invalid configuration, scope identity, lock ownership, closed handles or uncertain cleanup. */
export class WorkflowRuntimeError extends Error {
  /** Creates the public classified failure, retaining the original cause when supplied. */
  constructor(
    /** Stable public failure category used for caller recovery decisions. */
    readonly code:
      | "configuration"
      | "locked"
      | "identity"
      | "closed"
      | "cleanup",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "WorkflowRuntimeError";
  }
}
/** Caller-owned resource factory and cleanup contract within a repository/run scope. */
export interface WorkflowResource<T> {
  /** Explicit compatibility identity; changed identities reject reuse of existing state. */
  readonly identity: string;
  /** Creates or reopens the resource in its scoped directory. Rejection leaves an uncertain creation outcome requiring inspection. */
  create(directory: string): Promise<T>;
  /** Optional cleanup after the scope action; must resolve only when owned effects are quiescent. Failure retains the repository lock. */
  close?(value: T): Promise<void>;
}
/** Scoped JSON records and compatible cached resources; handles become invalid when their owning action ends. */
export interface WorkflowRuntime {
  /** Explicit Git checkout path; runtime scope uses its canonical common Git directory. */
  readonly repository: string;
  /** Explicit project identity; distinct projects never share run records or resources. */
  readonly projectId: string;
  /** Explicit run identity within the project; retained across checkpoint resume. */
  readonly runId: string;
  /** Consumer-owned dependency/tooling identity; changes reject existing runtime reuse. */
  readonly compatibility: string;
  /** Stable storage key derived from project and run identities. */
  readonly key: string;
  /** Caller-owned absolute directory for this scope or resource. */
  readonly directory: string;
  /** Throws if the scope closed or lock ownership changed; call before using externally retained handles. */
  assertActive(): void;
  /** Reads a simple lowercase identifier (1–80 letters/digits/hyphens, starting with a letter) as a JSON record for this exact scope; resolves undefined when absent and rejects invalid names, foreign identities or closed scopes. */
  read<T = unknown>(name: string): Promise<T | undefined>;
  /** Atomically persists a JSON value under a simple lowercase identifier (1–80 letters/digits/hyphens, starting with a letter); rejects invalid names/non-JSON values, foreign ownership or closed scopes. */
  save(name: string, value: unknown): Promise<void>;
  /** Returns one cached compatible resource per name; synchronously rejects invalid names, changed identities or inactive scope before returning a Promise. */
  resource<T>(name: string, resource: WorkflowResource<T>): Promise<T>;
}
/** Explicit repository/project/run/compatibility identity and shell-free command capability. */
export interface WorkflowRuntimeOptions {
  /** Explicit Git checkout path; runtime scope uses its canonical common Git directory. */
  readonly repository: string;
  /** Explicit project identity; distinct projects never share run records or resources. */
  readonly projectId: string;
  /** Explicit run identity within the project; retained across checkpoint resume. */
  readonly runId: string;
  /** Explicit compatibility identity for this consumer's dependencies/tooling. No credentials. */
  readonly compatibility: string;
  /** Explicit shell-free git/gh invocation capability; must honor supplied cancellation and report actual process exit/output. */
  readonly command: Command;
  /** Optional caller cancellation; abort prevents new work and preserves recovery/cleanup obligations. */
  readonly signal?: AbortSignal;
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function atomicJson(path: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2);
  if (bytes === undefined)
    throw new WorkflowRuntimeError(
      "configuration",
      "Runtime records must be JSON values.",
    );
  atomicReplace(path, bytes + "\n");
}
function validName(name: string) {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(name))
    throw new WorkflowRuntimeError(
      "configuration",
      "Runtime record/resource names must be simple lowercase identifiers.",
    );
  return name;
}

/** Holds a repository-wide writer lock until resources close. Calls action once with scoped handles and returns its value. Always closes created resources in reverse order; cleanup uncertainty retains the lock. Invalid identities/configuration and concurrent writers reject before action. Rethrows the original action failure after successful cleanup; never steals stale locks. */
export function withWorkflowRuntime<T>(
  options: WorkflowRuntimeOptions,
  action: (runtime: WorkflowRuntime) => Promise<T>,
): Promise<T> {
  return runWorkflowEffect(withWorkflowRuntimeProgram(options, action));
}

function withWorkflowRuntimeProgram<T>(
  options: WorkflowRuntimeOptions,
  action: (runtime: WorkflowRuntime) => Promise<T>,
) {
  return workflowProgram(
    Effect.gen(function* () {
      for (const value of [
        options.projectId,
        options.runId,
        options.compatibility,
      ])
        if (typeof value !== "string" || !value.trim() || value.length > 4096)
          throw new WorkflowRuntimeError(
            "configuration",
            "Explicit project, run and compatibility identities are required.",
          );
      options.signal?.throwIfAborted();
      const result = workflowValue(
        yield* workflowStep(() =>
          options.command(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            { cwd: options.repository, signal: options.signal },
          ),
        ),
      );
      if (result.exitCode !== 0)
        throw new WorkflowRuntimeError(
          "configuration",
          "Runtime repository must be a Git checkout.",
        );
      const repository = workflowValue(
        yield* workflowFile((fs) => fs.realpathSync(result.stdout.trim())),
      );
      const root = join(repository, "sandcastle", "runtime-v1");
      workflowValue(
        yield* workflowFile((fs) => fs.mkdirSync(root, { recursive: true })),
      );
      if (
        workflowValue(yield* workflowFile((fs) => fs.realpathSync(root))) !==
        root
      )
        throw new WorkflowRuntimeError(
          "configuration",
          "Runtime storage must not redirect through a symbolic link.",
        );
      const lock = join(root, "writer.lock");
      const scope = {
        version: 1,
        repository,
        projectId: options.projectId,
        runId: options.runId,
        compatibility: options.compatibility,
      };
      const identity = JSON.stringify(scope);
      const key = digest(
        JSON.stringify([options.projectId, options.runId]),
      ).slice(0, 32);
      const directory = join(root, key);
      const owner = randomUUID();
      const lockRecord = {
        owner,
        pid: process.pid,
        host: hostname(),
        projectId: options.projectId,
        runId: options.runId,
        compatibility: options.compatibility,
        created: new Date().toISOString(),
        status: "active",
      };
      let fd: number;
      try {
        fd = workflowValue(
          yield* workflowFile((fs) => fs.openSync(lock, "wx", 0o600)),
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST")
          throw new WorkflowRuntimeError(
            "locked",
            "Repository runtime is already locked; inspect its owner before explicit recovery.",
            cause,
          );
        throw cause;
      }
      try {
        workflowValue(
          yield* workflowFile((fs) =>
            fs.writeFileSync(fd, JSON.stringify(lockRecord)),
          ),
        );
        workflowValue(yield* workflowFile((fs) => fs.fsyncSync(fd)));
      } finally {
        workflowValue(yield* workflowFile((fs) => fs.closeSync(fd)));
      }
      let active = true;
      const assertOwner = () => {
        if (
          !existsSync(lock) ||
          JSON.parse(readFileSync(lock, "utf8")).owner !== owner
        )
          throw new WorkflowRuntimeError(
            "locked",
            "Runtime lock ownership changed; no further operation is authorized.",
          );
      };
      const assertActive = () => {
        if (!active)
          throw new WorkflowRuntimeError(
            "closed",
            "Runtime handles cannot be used after their scope closes.",
          );
        assertOwner();
      };
      const resources = new Map<
        string,
        {
          identity: string;
          value: Promise<unknown>;
          close?: (value: unknown) => Promise<void>;
        }
      >();
      let output: T | undefined;
      let failure: unknown;
      let failed = false;
      try {
        assertActive();
        workflowValue(
          yield* workflowFile((fs) =>
            fs.mkdirSync(directory, { recursive: true }),
          ),
        );
        if (
          workflowValue(
            yield* workflowFile((fs) => fs.realpathSync(directory)),
          ) !== directory
        )
          throw new WorkflowRuntimeError(
            "identity",
            "Runtime directory redirects outside its declared scope.",
          );
        const metadata = join(directory, "scope.json");
        if (
          workflowValue(yield* workflowFile((fs) => fs.existsSync(metadata)))
        ) {
          if (
            JSON.stringify(
              JSON.parse(
                workflowValue(
                  yield* workflowFile((fs) =>
                    fs.readFileSync(metadata, "utf8"),
                  ),
                ),
              ),
            ) !== identity
          )
            throw new WorkflowRuntimeError(
              "identity",
              "Saved runtime identity or compatibility changed; its records and resources were preserved.",
            );
        } else
          workflowValue(yield* workflowSync(() => atomicJson(metadata, scope)));
        const records = join(directory, "records");
        workflowValue(
          yield* workflowFile((fs) =>
            fs.mkdirSync(records, { recursive: true }),
          ),
        );
        const read = <Value>(name: string): Promise<Value | undefined> => {
          return runWorkflowEffect(
            workflowProgram(
              Effect.gen(function* () {
                assertActive();
                const path = join(records, validName(name) + ".json");
                if (
                  !workflowValue(
                    yield* workflowFile((fs) => fs.existsSync(path)),
                  )
                )
                  return undefined;
                const saved = JSON.parse(
                  workflowValue(
                    yield* workflowFile((fs) => fs.readFileSync(path, "utf8")),
                  ),
                );
                if (saved.identity !== identity)
                  throw new WorkflowRuntimeError(
                    "identity",
                    "Runtime record belongs to a different repository, project, run or compatibility identity.",
                  );
                return saved.value as Value;
              }),
            ),
          );
        };
        const save = (name: string, value: unknown) => {
          return runWorkflowEffect(
            workflowProgram(
              Effect.gen(function* () {
                assertActive();
                if (JSON.stringify(value) === undefined)
                  throw new WorkflowRuntimeError(
                    "configuration",
                    "Runtime records must be JSON values.",
                  );
                atomicJson(join(records, validName(name) + ".json"), {
                  identity,
                  value,
                });
              }),
            ),
          );
        };
        const resourceFile = join(directory, "resource-identities.json");
        const persistedResources: Record<string, string> = workflowValue(
          yield* workflowFile((fs) => fs.existsSync(resourceFile)),
        )
          ? JSON.parse(
              workflowValue(
                yield* workflowFile((fs) =>
                  fs.readFileSync(resourceFile, "utf8"),
                ),
              ),
            )
          : {};
        if (
          !persistedResources ||
          typeof persistedResources !== "object" ||
          Array.isArray(persistedResources) ||
          !Object.values(persistedResources).every(
            (value) => typeof value === "string",
          )
        )
          throw new WorkflowRuntimeError(
            "identity",
            "Saved resource identities are invalid; existing resources were preserved.",
          );
        const runtime: WorkflowRuntime = {
          projectId: options.projectId,
          runId: options.runId,
          compatibility: options.compatibility,
          repository,
          key,
          directory,
          assertActive,
          read,
          save,
          resource<Value>(
            name: string,
            resource: WorkflowResource<Value>,
          ): Promise<Value> {
            return runWorkflowSync(
              workflowProgram(
                Effect.gen(function* () {
                  assertActive();
                  validName(name);
                  if (!resource.identity?.trim())
                    throw new WorkflowRuntimeError(
                      "configuration",
                      "Resources require an explicit compatibility identity.",
                    );
                  const prior = resources.get(name);
                  if (
                    (prior && prior.identity !== resource.identity) ||
                    (Object.hasOwn(persistedResources, name) &&
                      persistedResources[name] !== resource.identity)
                  )
                    throw new WorkflowRuntimeError(
                      "identity",
                      "Resource compatibility changed; existing resources were not reused or replaced.",
                    );
                  if (prior) return prior.value as Promise<Value>;
                  const value = runWorkflowEffect(
                    workflowProgram(
                      Effect.gen(function* () {
                        workflowValue(
                          yield* workflowStep(() => Promise.resolve()),
                        );
                        persistedResources[name] = resource.identity;
                        assertActive();
                        atomicJson(resourceFile, persistedResources);
                        const path = join(directory, "resources", name);
                        workflowValue(
                          yield* workflowFile((fs) =>
                            fs.mkdirSync(path, { recursive: true }),
                          ),
                        );
                        options.signal?.throwIfAborted();
                        assertActive();
                        return workflowValue(
                          yield* workflowStep(() => resource.create(path)),
                        );
                      }),
                    ),
                  );
                  resources.set(name, {
                    identity: resource.identity,
                    value,
                    close: resource.close as
                      | ((value: unknown) => Promise<void>)
                      | undefined,
                  });
                  return value;
                }),
              ),
            );
          },
        };
        options.signal?.throwIfAborted();
        output = workflowValue(yield* workflowStep(() => action(runtime)));
      } catch (cause) {
        failed = true;
        failure = cause;
      }
      active = false;
      const cleanup: unknown[] = [];
      for (const resource of [...resources.values()].reverse()) {
        let value: unknown;
        try {
          value = workflowValue(yield* workflowStep(() => resource.value));
        } catch (cause) {
          cleanup.push(
            new WorkflowRuntimeError(
              "cleanup",
              "Resource creation did not return a handle; its outcome needs inspection before replay.",
              cause,
            ),
          );
          continue;
        }
        try {
          workflowValue(yield* workflowStep(() => resource.close?.(value)));
        } catch (cause) {
          cleanup.push(cause);
        }
      }
      if (!cleanup.length) {
        try {
          assertOwner();
          workflowValue(yield* workflowFile((fs) => fs.unlinkSync(lock)));
        } catch (cause) {
          cleanup.push(cause);
        }
      }
      if (cleanup.length) {
        try {
          assertOwner();
          workflowValue(
            yield* workflowSync(() =>
              atomicJson(lock, { ...lockRecord, status: "cleanup-required" }),
            ),
          );
        } catch (cause) {
          cleanup.push(cause);
        }
        throw new WorkflowRuntimeError(
          "cleanup",
          "Runtime cleanup needs inspection; resources or lock may remain.",
          new AggregateError(failed ? [failure, ...cleanup] : cleanup),
        );
      }
      if (failed) throw failure;
      return output as T;
    }),
  );
}

/** Saved owner and resource identities to inspect before explicitly releasing an uncertain lock. */
export interface WorkflowRuntimeReconciliation {
  /** Exact saved lock owner identity being reconciled. */
  readonly owner: string;
  /** Caller-owned absolute directory for this scope or resource. */
  readonly directory: string;
  /** Saved resource compatibility identities; inspect their owned effects before releasing the lock. */
  readonly resources: Readonly<Record<string, string>>;
  /** Optional cancellation while observing resource ownership; uncertainty must retain the lock. */
  readonly signal?: AbortSignal;
}

/** Explicit recovery, never automatic stale-PID lock theft. Resources and records are retained. */
export function reconcileWorkflowRuntimeLock(
  options: WorkflowRuntimeOptions & {
    /** Exact lock owner the caller intends to reconcile; a changed owner preserves the lock. */
    readonly expectedOwner: string;
    /** Read/cleanup capability for the exact saved owner; return released only with evidence that every owned effect is quiescent. Uncertain or failed callbacks retain the lock. */
    reconcile(context: WorkflowRuntimeReconciliation): Promise<
      | {
          /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
          /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
          status: "released"; /** Raw evidence locations or criterion-specific explanation; must be nonempty for approval. */
          /** Raw evidence locations or criterion-specific explanation; must be nonempty for approval. */
          evidence: readonly string[];
        }
      | {
          /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
          /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
          status: "uncertain";
        }
    >;
  },
): Promise<void> {
  return runWorkflowEffect(reconcileWorkflowRuntimeLockProgram(options));
}

function reconcileWorkflowRuntimeLockProgram(
  options: WorkflowRuntimeOptions & {
    readonly expectedOwner: string;
    reconcile(
      context: WorkflowRuntimeReconciliation,
    ): Promise<
      | { status: "released"; evidence: readonly string[] }
      | { status: "uncertain" }
    >;
  },
) {
  return workflowProgram(
    Effect.gen(function* () {
      options.signal?.throwIfAborted();
      const result = workflowValue(
        yield* workflowStep(() =>
          options.command(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            { cwd: options.repository, signal: options.signal },
          ),
        ),
      );
      if (result.exitCode !== 0)
        throw new WorkflowRuntimeError(
          "configuration",
          "Runtime repository must be a Git checkout.",
        );
      const root = join(
        workflowValue(
          yield* workflowFile((fs) => fs.realpathSync(result.stdout.trim())),
        ),
        "sandcastle",
        "runtime-v1",
      );
      if (
        workflowValue(yield* workflowFile((fs) => fs.realpathSync(root))) !==
        root
      )
        throw new WorkflowRuntimeError(
          "identity",
          "Runtime root redirects outside its scope.",
        );
      const lock = join(root, "writer.lock");
      const guard = join(root, "reconciliation.lock");
      let fd: number;
      try {
        fd = workflowValue(
          yield* workflowFile((fs) => fs.openSync(guard, "wx", 0o600)),
        );
      } catch (cause) {
        throw new WorkflowRuntimeError(
          "locked",
          "Another runtime reconciliation is already active or unresolved.",
          cause,
        );
      }
      workflowValue(yield* workflowFile((fs) => fs.closeSync(fd)));
      try {
        const before = workflowValue(
          yield* workflowFile((fs) => fs.readFileSync(lock, "utf8")),
        );
        const saved = JSON.parse(before);
        if (!options.expectedOwner || saved.owner !== options.expectedOwner)
          throw new WorkflowRuntimeError(
            "locked",
            "Runtime owner changed; its lock was preserved.",
          );
        if (
          saved.projectId !== options.projectId ||
          saved.runId !== options.runId ||
          saved.compatibility !== options.compatibility
        )
          throw new WorkflowRuntimeError(
            "identity",
            "Runtime recovery must match the original project, run and compatibility.",
          );
        if (
          saved.host !== hostname() ||
          !Number.isSafeInteger(saved.pid) ||
          saved.pid < 1
        )
          throw new WorkflowRuntimeError(
            "locked",
            "Unknown runtime host/process ownership needs inspection; its lock was preserved.",
          );
        if (saved.status !== "cleanup-required") {
          let alive = true;
          try {
            process.kill(saved.pid, 0);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ESRCH")
              alive = false;
            else
              throw new WorkflowRuntimeError(
                "locked",
                "Runtime owner liveness could not be established.",
                cause,
              );
          }
          if (alive)
            throw new WorkflowRuntimeError(
              "locked",
              "Runtime owner is still active; no resource reconciliation was started.",
            );
        }
        const key = digest(
          JSON.stringify([options.projectId, options.runId]),
        ).slice(0, 32);
        const directory = join(root, key);
        if (
          workflowValue(
            yield* workflowFile((fs) => fs.existsSync(directory)),
          ) &&
          workflowValue(
            yield* workflowFile((fs) => fs.realpathSync(directory)),
          ) !== directory
        )
          throw new WorkflowRuntimeError(
            "identity",
            "Runtime directory redirects outside its scope.",
          );
        const resourceFile = join(directory, "resource-identities.json");
        const resources: Record<string, string> = workflowValue(
          yield* workflowFile((fs) => fs.existsSync(resourceFile)),
        )
          ? JSON.parse(
              workflowValue(
                yield* workflowFile((fs) =>
                  fs.readFileSync(resourceFile, "utf8"),
                ),
              ),
            )
          : {};
        if (
          !resources ||
          typeof resources !== "object" ||
          Array.isArray(resources) ||
          !Object.values(resources).every((value) => typeof value === "string")
        )
          throw new WorkflowRuntimeError(
            "identity",
            "Resource identities are invalid; its lock was preserved.",
          );
        const observed = workflowValue(
          yield* workflowStep(() =>
            options.reconcile({
              owner: saved.owner,
              directory,
              resources: structuredClone(resources),
              signal: options.signal,
            }),
          ),
        );
        options.signal?.throwIfAborted();
        if (
          observed.status !== "released" ||
          !Array.isArray(observed.evidence) ||
          !observed.evidence.length ||
          !observed.evidence.every(
            (value) => typeof value === "string" && value.trim(),
          )
        )
          throw new WorkflowRuntimeError(
            "cleanup",
            "Owned resources remain uncertain; its runtime lock was preserved.",
          );
        if (
          workflowValue(
            yield* workflowFile((fs) => fs.readFileSync(lock, "utf8")),
          ) !== before
        )
          throw new WorkflowRuntimeError(
            "locked",
            "Runtime ownership changed during reconciliation; its lock was preserved.",
          );
        const audit = join(root, "reconciliations");
        workflowValue(
          yield* workflowFile((fs) => fs.mkdirSync(audit, { recursive: true })),
        );
        workflowValue(
          yield* workflowSync(() =>
            atomicJson(join(audit, digest(saved.owner) + ".json"), {
              owner: saved.owner,
              projectId: saved.projectId,
              runId: saved.runId,
              evidence: observed.evidence,
              reconciled: new Date().toISOString(),
            }),
          ),
        );
        workflowValue(yield* workflowFile((fs) => fs.unlinkSync(lock)));
      } finally {
        workflowValue(yield* workflowFile((fs) => fs.unlinkSync(guard)));
      }
    }),
  );
}
