import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import type { Command } from "./workflow-integrations.js";

export class WorkflowRuntimeError extends Error {
  constructor(
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
export interface WorkflowResource<T> {
  readonly identity: string;
  create(directory: string): Promise<T>;
  close?(value: T): Promise<void>;
}
export interface WorkflowRuntime {
  readonly repository: string;
  readonly projectId: string;
  readonly runId: string;
  readonly compatibility: string;
  readonly key: string;
  readonly directory: string;
  assertActive(): void;
  read<T = unknown>(name: string): Promise<T | undefined>;
  save(name: string, value: unknown): Promise<void>;
  resource<T>(name: string, resource: WorkflowResource<T>): Promise<T>;
}
export interface WorkflowRuntimeOptions {
  readonly repository: string;
  readonly projectId: string;
  readonly runId: string;
  /** Explicit compatibility identity for this consumer's dependencies/tooling. No credentials. */
  readonly compatibility: string;
  readonly command: Command;
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
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
function validName(name: string) {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(name))
    throw new WorkflowRuntimeError(
      "configuration",
      "Runtime record/resource names must be simple lowercase identifiers.",
    );
  return name;
}

/** Holds a repository-wide writer lock until resources close. Never steals a stale lock. */
export async function withWorkflowRuntime<T>(
  options: WorkflowRuntimeOptions,
  action: (runtime: WorkflowRuntime) => Promise<T>,
): Promise<T> {
  for (const value of [options.projectId, options.runId, options.compatibility])
    if (typeof value !== "string" || !value.trim() || value.length > 4096)
      throw new WorkflowRuntimeError(
        "configuration",
        "Explicit project, run and compatibility identities are required.",
      );
  options.signal?.throwIfAborted();
  const result = await options.command(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: options.repository, signal: options.signal },
  );
  if (result.exitCode !== 0)
    throw new WorkflowRuntimeError(
      "configuration",
      "Runtime repository must be a Git checkout.",
    );
  const repository = realpathSync(result.stdout.trim());
  const root = join(repository, "sandcastle", "runtime-v1");
  mkdirSync(root, { recursive: true });
  if (realpathSync(root) !== root)
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
  const key = digest(JSON.stringify([options.projectId, options.runId])).slice(
    0,
    32,
  );
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
    fd = openSync(lock, "wx", 0o600);
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
    writeFileSync(fd, JSON.stringify(lockRecord));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
    mkdirSync(directory, { recursive: true });
    if (realpathSync(directory) !== directory)
      throw new WorkflowRuntimeError(
        "identity",
        "Runtime directory redirects outside its declared scope.",
      );
    const metadata = join(directory, "scope.json");
    if (existsSync(metadata)) {
      if (
        JSON.stringify(JSON.parse(readFileSync(metadata, "utf8"))) !== identity
      )
        throw new WorkflowRuntimeError(
          "identity",
          "Saved runtime identity or compatibility changed; its records and resources were preserved.",
        );
    } else atomicJson(metadata, scope);
    const records = join(directory, "records");
    mkdirSync(records, { recursive: true });
    const read = async <Value>(name: string): Promise<Value | undefined> => {
      assertActive();
      const path = join(records, validName(name) + ".json");
      if (!existsSync(path)) return undefined;
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved.identity !== identity)
        throw new WorkflowRuntimeError(
          "identity",
          "Runtime record belongs to a different repository, project, run or compatibility identity.",
        );
      return saved.value as Value;
    };
    const save = async (name: string, value: unknown) => {
      assertActive();
      if (JSON.stringify(value) === undefined)
        throw new WorkflowRuntimeError(
          "configuration",
          "Runtime records must be JSON values.",
        );
      atomicJson(join(records, validName(name) + ".json"), { identity, value });
    };
    const resourceFile = join(directory, "resource-identities.json");
    const persistedResources: Record<string, string> = existsSync(resourceFile)
      ? JSON.parse(readFileSync(resourceFile, "utf8"))
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
        const value = Promise.resolve().then(async () => {
          persistedResources[name] = resource.identity;
          assertActive();
          atomicJson(resourceFile, persistedResources);
          const path = join(directory, "resources", name);
          mkdirSync(path, { recursive: true });
          options.signal?.throwIfAborted();
          assertActive();
          return resource.create(path);
        });
        resources.set(name, {
          identity: resource.identity,
          value,
          close: resource.close as
            | ((value: unknown) => Promise<void>)
            | undefined,
        });
        return value;
      },
    };
    options.signal?.throwIfAborted();
    output = await action(runtime);
  } catch (cause) {
    failed = true;
    failure = cause;
  }
  active = false;
  const cleanup: unknown[] = [];
  for (const resource of [...resources.values()].reverse()) {
    let value: unknown;
    try {
      value = await resource.value;
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
      await resource.close?.(value);
    } catch (cause) {
      cleanup.push(cause);
    }
  }
  if (!cleanup.length) {
    try {
      assertOwner();
      unlinkSync(lock);
    } catch (cause) {
      cleanup.push(cause);
    }
  }
  if (cleanup.length) {
    try {
      assertOwner();
      atomicJson(lock, { ...lockRecord, status: "cleanup-required" });
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
}

export interface WorkflowRuntimeReconciliation {
  readonly owner: string;
  readonly directory: string;
  readonly resources: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** Explicit recovery, never automatic stale-PID lock theft. Resources and records are retained. */
export async function reconcileWorkflowRuntimeLock(
  options: WorkflowRuntimeOptions & {
    readonly expectedOwner: string;
    reconcile(
      context: WorkflowRuntimeReconciliation,
    ): Promise<
      | { status: "released"; evidence: readonly string[] }
      | { status: "uncertain" }
    >;
  },
): Promise<void> {
  options.signal?.throwIfAborted();
  const result = await options.command(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: options.repository, signal: options.signal },
  );
  if (result.exitCode !== 0)
    throw new WorkflowRuntimeError(
      "configuration",
      "Runtime repository must be a Git checkout.",
    );
  const root = join(
    realpathSync(result.stdout.trim()),
    "sandcastle",
    "runtime-v1",
  );
  if (realpathSync(root) !== root)
    throw new WorkflowRuntimeError(
      "identity",
      "Runtime root redirects outside its scope.",
    );
  const lock = join(root, "writer.lock");
  const guard = join(root, "reconciliation.lock");
  let fd: number;
  try {
    fd = openSync(guard, "wx", 0o600);
  } catch (cause) {
    throw new WorkflowRuntimeError(
      "locked",
      "Another runtime reconciliation is already active or unresolved.",
      cause,
    );
  }
  closeSync(fd);
  try {
    const before = readFileSync(lock, "utf8");
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
        if ((cause as NodeJS.ErrnoException).code === "ESRCH") alive = false;
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
    if (existsSync(directory) && realpathSync(directory) !== directory)
      throw new WorkflowRuntimeError(
        "identity",
        "Runtime directory redirects outside its scope.",
      );
    const resourceFile = join(directory, "resource-identities.json");
    const resources: Record<string, string> = existsSync(resourceFile)
      ? JSON.parse(readFileSync(resourceFile, "utf8"))
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
    const observed = await options.reconcile({
      owner: saved.owner,
      directory,
      resources: structuredClone(resources),
      signal: options.signal,
    });
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
    if (readFileSync(lock, "utf8") !== before)
      throw new WorkflowRuntimeError(
        "locked",
        "Runtime ownership changed during reconciliation; its lock was preserved.",
      );
    const audit = join(root, "reconciliations");
    mkdirSync(audit, { recursive: true });
    atomicJson(join(audit, digest(saved.owner) + ".json"), {
      owner: saved.owner,
      projectId: saved.projectId,
      runId: saved.runId,
      evidence: observed.evidence,
      reconciled: new Date().toISOString(),
    });
    unlinkSync(lock);
  } finally {
    unlinkSync(guard);
  }
}
