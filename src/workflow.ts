import { extractWorkflowReview } from "./workflow-review.js";
export { extractWorkflowReview } from "./workflow-review.js";
/** One task through explicitly supplied project operations. No provider retries or remote defaults. */
export interface WorkflowProject<Config> {
  readonly id: string;
  readonly config: Config;
}

export interface WorkflowTask {
  readonly id: string;
  readonly criteria: readonly {
    readonly id: string;
    readonly description: string;
  }[];
}

export interface WorkflowValidation {
  /** Current inputs bound by runWorkflow after the host operation succeeds. */
  readonly identity?: WorkflowValidationIdentity;
  readonly candidate: string;
  readonly passed: boolean;
  readonly evidence: readonly string[];
}

export interface WorkflowReview {
  /** Validation, task and independent review inputs covered by this result. */
  readonly identity?: WorkflowReviewIdentity;
  readonly candidate: string;
  readonly approved: boolean;
  readonly criteria: readonly {
    readonly id: string;
    readonly satisfied: boolean;
    readonly evidence: string;
  }[];
}

export interface WorkflowDelivery {
  readonly candidate: string;
  readonly reference: string;
}

export type WorkflowPhase =
  | "select"
  | "implement"
  | "validate"
  | "review"
  | "deliver"
  | "ready"
  | "idle";
export type WorkflowErrorCode =
  | "configuration"
  | "invalid-checkpoint"
  | "gate"
  | "operation"
  | "persistence"
  | "uncertain"
  | "cancelled"
  | "exhausted"
  | "permanent"
  | "format";

/** A consumer classifies meaning at its transport/provider boundary. Unknown errors stop. */
export class WorkflowOperationError extends Error {
  constructor(
    readonly kind: "transport" | "substantive" | "permanent" | "format",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "WorkflowOperationError";
  }
}
export interface WorkflowAttempt {
  readonly operation: string;
  readonly implementation: number;
  readonly transport: number;
}
export interface WorkflowRecoveryState {
  implementationAttempts: number;
  operations: Record<
    string,
    {
      attempts: number;
      status: "running" | "interrupted" | "completed" | "stopped";
      nextAttemptAt?: number;
      result?: unknown;
      failure?: { kind: string; message: string };
    }
  >;
}
export type WorkflowReconciliation =
  | { status: "completed"; value: unknown }
  | { status: "not-started" }
  | { status: "uncertain" };
export interface WorkflowRecovery<Config> {
  /** Observe the effect before permitting an interrupted implementation/delivery to replay. */
  reconcile?(
    context: WorkflowContext<Config> & {
      phase: "implement" | "deliver";
      attempt: WorkflowAttempt;
      candidate?: string;
      validation?: WorkflowValidation;
      review?: WorkflowReview;
    },
  ): Promise<WorkflowReconciliation>;
  /** Time boundaries, injectable for deterministic consumers/tests. Backoff remains persisted. */
  now?(): number;
  wait?(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface WorkflowCheckpoint {
  version: 1;
  project: string;
  phase: WorkflowPhase;
  task?: WorkflowTask;
  candidate?: string;
  validation?: WorkflowValidation;
  review?: WorkflowReview;
  delivery?: WorkflowDelivery;
  inFlight?: "implement" | "deliver";
  recovery?: WorkflowRecoveryState;
  /** Once enabled, ordinary resume cannot silently drop strict task-bound review extraction. */
  reviewOutputEnabled?: true;
  /** The single logical correction consumed for one task/candidate/implementation/evidence generation. */
  reviewCorrection?: {
    /** Exact logical review identity; transport retries share this scope. */
    scope: string;
    /** Saved before the first correction invocation. */
    consumed: true;
    /** Original malformed output, preserved for every transport attempt. */
    output: unknown;
    /** Deterministic extraction/schema failure sent to the independent reviewer. */
    problem: string;
  };
  repair?: { phase: WorkflowPhase; message: string };
  /** Durable evidence generation; completed operations from older inputs are never reused. */
  evidence?: {
    generation: number;
    validation?: WorkflowValidationIdentity;
    review?: WorkflowReviewIdentity;
  };
  failure?: { code: WorkflowErrorCode; message: string };
}

export interface WorkflowContext<Config> {
  /** Evidence generation for context-bound consumer records such as correction sessions. */
  readonly evidenceGeneration?: number;
  readonly project: WorkflowProject<Config>;
  readonly task: WorkflowTask;
  readonly signal?: AbortSignal;
  readonly attempt?: WorkflowAttempt;
  readonly repair?: WorkflowCheckpoint["repair"];
}
export interface WorkflowCandidateContext<
  Config,
> extends WorkflowContext<Config> {
  readonly candidate: string;
}
export interface WorkflowReviewContext<
  Config,
> extends WorkflowCandidateContext<Config> {
  readonly validation: WorkflowValidation;
}
export interface WorkflowDeliveryContext<
  Config,
> extends WorkflowReviewContext<Config> {
  readonly review: WorkflowReview;
}

export interface WorkflowOperations<Config> {
  selectTask(
    project: WorkflowProject<Config>,
    signal?: AbortSignal,
  ): Promise<WorkflowTask | null>;
  implement(context: WorkflowContext<Config>): Promise<string>;
  currentCandidate(context: WorkflowContext<Config>): Promise<string>;
  validate(
    context: WorkflowCandidateContext<Config>,
  ): Promise<WorkflowValidation>;
  review(
    context: WorkflowReviewContext<Config>,
  ): Promise<WorkflowReview | string>;
  deliver(context: WorkflowDeliveryContext<Config>): Promise<WorkflowDelivery>;
  /** Must durably replace the stored checkpoint before resolving. */
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
}

export class WorkflowError extends Error {
  readonly checkpoint: WorkflowCheckpoint;
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
    checkpoint: WorkflowCheckpoint,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "WorkflowError";
    this.checkpoint = structuredClone(checkpoint);
  }
}

export interface WorkflowOptions<Config> {
  /** Current project-owned policy/dependency/host inputs. Saved identities are never defaults. */
  readonly evidence?: WorkflowEvidence<Config>;
  readonly project: WorkflowProject<Config>;
  readonly operations: WorkflowOperations<Config>;
  readonly checkpoint?: WorkflowCheckpoint;
  readonly signal?: AbortSignal;
  /** Explicitly enable fixed durable recovery budgets. Existing callers retain fail-fast behavior. */
  readonly recovery?: WorkflowRecovery<Config>;
  /** Strict task-bound extraction and one durable correction per candidate/evidence generation. Enables durable recovery. */
  readonly reviewOutput?: {
    /** Reformat the same independent findings; return raw strict JSON or a task-bound review object. */
    correct(
      context: WorkflowReviewContext<Config> & {
        /** Saved malformed output; no new implementation or validation is requested. */
        output: unknown;
        /** Extraction/schema feedback, never an instruction to approve rejected code. */
        problem: string;
      },
    ): Promise<WorkflowReview | string>;
  };
}

/** Fresh project observations, represented by stable content identities rather than outcomes. */
export interface WorkflowValidationInputs {
  /** Final validation plan, selectors and validator/adapter policy content. */
  readonly policy: string;
  /** Pinned dependencies plus actual installed/prepared dependency observations. */
  readonly dependencies: string;
  /** Relevant actual runner, toolchain and graphics environment. Unavailable is an error. */
  readonly environment: string;
}
/** Validation inputs plus the actual code candidate checked by the workflow. */
export interface WorkflowValidationIdentity extends WorkflowValidationInputs {
  /** Exact candidate SHA or equivalent immutable project identity. */
  readonly candidate: string;
}
/** Complete independent review eligibility, separate from validation policy. */
export interface WorkflowReviewIdentity {
  /** Host validation inputs covered by independent review. */
  readonly validation: WorkflowValidationIdentity;
  /** Project review policy/context identity, including relevant prompts and model policy. */
  readonly inputs: string;
  /** Task scope and criteria covered by the reviewer. */
  readonly task: WorkflowTask;
}
/** Opt-in evidence freshness policy. Once persisted, fresh discovery remains required on resume. */
export interface WorkflowEvidence<Config> {
  /** Discover current inputs before validation, review, delivery and ready reuse. */
  validation(
    context: WorkflowCandidateContext<Config>,
  ): Promise<WorkflowValidationInputs>;
  /** Discover current independent review policy and context. */
  review(context: WorkflowReviewContext<Config>): Promise<string>;
}

export async function runWorkflow<Config>(
  options: WorkflowOptions<Config>,
): Promise<WorkflowCheckpoint> {
  const { project, operations, signal } = options;
  const state: WorkflowCheckpoint = structuredClone(
    options.checkpoint ?? { version: 1, project: project.id, phase: "select" },
  );
  const recover =
    options.recovery ??
    (state.recovery || options.reviewOutput ? {} : undefined);
  const fail = (
    code: WorkflowErrorCode,
    message: string,
    cause?: unknown,
  ): never => {
    throw new WorkflowError(code, message, state, cause);
  };
  const text = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (options.reviewOutput) state.reviewOutputEnabled = true;
  if (
    state.reviewOutputEnabled &&
    typeof options.reviewOutput?.correct !== "function"
  )
    fail(
      "configuration",
      "The saved strict-review policy requires its explicit correction operation on resume.",
    );
  const validTask = (value: WorkflowTask | undefined): value is WorkflowTask =>
    Boolean(
      value &&
      text(value.id) &&
      Array.isArray(value.criteria) &&
      value.criteria.length > 0 &&
      value.criteria.every(
        (criterion) =>
          criterion && text(criterion.id) && text(criterion.description),
      ) &&
      new Set(value.criteria.map((criterion) => criterion.id)).size ===
        value.criteria.length,
    );
  if (!text(project.id))
    fail("configuration", "A stable project identity is required.");
  for (const name of [
    "selectTask",
    "implement",
    "currentCandidate",
    "validate",
    "review",
    "deliver",
    "save",
  ] as const)
    if (typeof operations[name] !== "function")
      fail("configuration", `Missing explicit project operation: ${name}`);
  if (
    !state ||
    typeof state !== "object" ||
    state.version !== 1 ||
    state.project !== project.id ||
    ![
      "select",
      "implement",
      "validate",
      "review",
      "deliver",
      "ready",
      "idle",
    ].includes(state.phase) ||
    (!["select", "idle"].includes(state.phase) && !validTask(state.task)) ||
    (["validate", "review", "deliver", "ready"].includes(state.phase) &&
      !text(state.candidate)) ||
    (state.inFlight !== undefined &&
      (state.inFlight !== state.phase ||
        !["implement", "deliver"].includes(state.inFlight)))
  )
    fail(
      "invalid-checkpoint",
      "Checkpoint identity or task state is invalid; it was not replayed.",
    );
  if (
    recover &&
    options.checkpoint &&
    !state.recovery &&
    !["select", "idle"].includes(state.phase)
  )
    fail(
      "invalid-checkpoint",
      "Legacy mid-task checkpoints have unknown consumed budgets; recovery cannot invent fresh attempts.",
    );
  if (
    state.recovery &&
    (!Number.isInteger(state.recovery.implementationAttempts) ||
      state.recovery.implementationAttempts < 0 ||
      state.recovery.implementationAttempts > 3 ||
      !state.recovery.operations ||
      typeof state.recovery.operations !== "object" ||
      Array.isArray(state.recovery.operations) ||
      !Object.values(state.recovery.operations).every(
        (record) =>
          record &&
          Number.isInteger(record.attempts) &&
          record.attempts >= 1 &&
          record.attempts <= 3 &&
          ["running", "interrupted", "completed", "stopped"].includes(
            record.status,
          ) &&
          (record.nextAttemptAt === undefined ||
            Number.isFinite(record.nextAttemptAt)),
      ))
  )
    fail(
      "invalid-checkpoint",
      "Saved recovery budgets are invalid; no operation was replayed.",
    );
  if (state.inFlight && !recover)
    fail(
      "uncertain",
      `The earlier ${state.inFlight} may have performed a side effect. Reconcile it before resuming.`,
    );
  if (state.evidence && !options.evidence)
    fail(
      "configuration",
      "Current evidence inputs are required to resume this checkpoint.",
    );
  if (
    state.evidence &&
    (!Number.isSafeInteger(state.evidence.generation) ||
      state.evidence.generation < 0)
  )
    fail("invalid-checkpoint", "Evidence generation is invalid.");

  const persist = async () => {
    try {
      await operations.save(structuredClone(state));
    } catch (cause) {
      fail(
        "persistence",
        "Checkpoint could not be saved; no next operation was started.",
        cause,
      );
    }
  };
  const advance = async (phase: WorkflowPhase) => {
    state.phase = phase;
    delete state.inFlight;
    delete state.failure;
    await persist();
  };
  const context = (): WorkflowContext<Config> => ({
    project,
    task: structuredClone(state.task!),
    signal,
    repair: state.repair,
    evidenceGeneration: state.evidence?.generation,
  });
  const candidateContext = (): WorkflowCandidateContext<Config> => ({
    ...context(),
    candidate: state.candidate!,
  });
  if (recover) state.recovery ??= { implementationAttempts: 0, operations: {} };
  const now = recover?.now ?? Date.now;
  const wait =
    recover?.wait ??
    ((milliseconds: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const aborted = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", aborted);
          resolve();
        }, milliseconds);
        signal?.addEventListener("abort", aborted, { once: true });
      }));
  let activeAttempt: WorkflowAttempt | undefined;
  const operationKey = (name: string) => {
    const scopedName =
      state.evidence && name !== "implement" && name !== "select"
        ? `${name}:evidence-${state.evidence.generation}`
        : name;
    return `${scopedName}/${state.recovery!.implementationAttempts}`;
  };
  const perform = async <T>(
    name: string,
    action: () => Promise<T>,
    effect?: "implement" | "deliver",
    reusable: (value: T) => boolean = () => true,
  ): Promise<T> => {
    if (!recover) return action();
    const recovery = state.recovery!;
    const key = operationKey(name);
    const record = (recovery.operations[key] ??= {
      attempts: 0,
      status: "interrupted",
    });
    if (record.status === "completed") {
      if (reusable(record.result as T)) return record.result as T;
      record.status = "interrupted";
    }
    if (
      record.status === "stopped" &&
      !(effect && record.failure?.kind === "unknown")
    )
      fail(
        record.failure?.kind === "format"
          ? "format"
          : record.failure?.kind === "permanent"
            ? "permanent"
            : "operation",
        record.failure?.message ?? "Operation stopped.",
      );
    for (;;) {
      signal?.throwIfAborted();
      activeAttempt = {
        operation: key,
        implementation: recovery.implementationAttempts,
        transport: record.attempts,
      };
      if (effect && record.attempts > 0) {
        if (!recover.reconcile)
          fail(
            "uncertain",
            `Reconciliation is required before replaying ${key}.`,
          );
        const interruptedAttempt = activeAttempt;
        const result = await perform(
          `reconcile:${key}:${record.attempts}`,
          () =>
            recover.reconcile!({
              ...context(),
              phase: effect,
              attempt: interruptedAttempt,
              candidate: state.candidate,
              validation: structuredClone(state.validation),
              review: structuredClone(state.review),
            }),
          undefined,
          (value) => value.status === "completed",
        );
        if (result.status === "completed") {
          record.status = "completed";
          record.result = structuredClone(result.value);
          delete record.nextAttemptAt;
          await persist();
          return result.value as T;
        }
        if (result.status !== "not-started")
          fail(
            "uncertain",
            `The outcome of ${key} remains uncertain; no effect was replayed.`,
          );
        if (record.failure?.kind === "unknown")
          fail(
            "uncertain",
            `The cause of ${key} is unknown; observable completion can be accepted, but automatic replay is disabled.`,
          );
      }
      if (record.attempts >= 3)
        fail("exhausted", `Transport attempt limit reached for ${key}.`);
      if (record.nextAttemptAt !== undefined) {
        await wait(Math.max(0, record.nextAttemptAt - now()), signal);
        delete record.nextAttemptAt;
      }
      record.attempts++;
      record.status = "running";
      record.nextAttemptAt = now() + 500 * 2 ** (record.attempts - 1);
      activeAttempt = {
        operation: key,
        implementation: recovery.implementationAttempts,
        transport: record.attempts,
      };
      await persist();
      signal?.throwIfAborted();
      try {
        const value = await action();
        record.result = structuredClone(value);
        record.status = "completed";
        delete record.nextAttemptAt;
        await persist();
        return value;
      } catch (cause) {
        if (cause instanceof WorkflowError && cause.code === "persistence")
          throw cause;
        record.failure = {
          kind:
            cause instanceof WorkflowOperationError ? cause.kind : "unknown",
          message: cause instanceof Error ? cause.message : String(cause),
        };
        record.status =
          cause instanceof WorkflowOperationError && cause.kind === "transport"
            ? "interrupted"
            : "stopped";
        if (record.status === "interrupted")
          record.nextAttemptAt = now() + 500 * 2 ** (record.attempts - 1);
        await persist();
        if (
          !(cause instanceof WorkflowOperationError) ||
          cause.kind !== "transport"
        )
          throw cause;
      }
    }
  };
  const checkCandidate = async () => {
    signal?.throwIfAborted();
    let observation = 0;
    while (
      recover &&
      state.recovery!.operations[
        operationKey(`candidate:${state.phase}:${observation}`)
      ]?.status === "completed"
    )
      observation++;
    const current = await perform(
      `candidate:${state.phase}:${observation}`,
      () =>
        operations.currentCandidate({ ...context(), attempt: activeAttempt }),
    );
    signal?.throwIfAborted();
    if (current !== state.candidate)
      fail(
        "gate",
        "The current candidate changed; earlier evidence cannot authorize delivery.",
      );
  };
  const checkValidation = (
    value: WorkflowValidation | undefined,
  ): WorkflowValidation => {
    if (
      recover &&
      value &&
      value.candidate === state.candidate &&
      value.passed === false &&
      Array.isArray(value.evidence) &&
      value.evidence.length &&
      value.evidence.every(text)
    )
      throw new WorkflowOperationError(
        "substantive",
        `Validation failed: ${value.evidence.join("; ")}`,
      );
    if (
      !value ||
      value.candidate !== state.candidate ||
      value.passed !== true ||
      !Array.isArray(value.evidence) ||
      !value.evidence.length ||
      !value.evidence.every(text)
    )
      return fail(
        "gate",
        "Passing validation evidence for this exact candidate is required.",
      );
    return value;
  };
  const checkReview = (value: WorkflowReview | undefined): WorkflowReview => {
    if (state.reviewOutputEnabled)
      value = extractWorkflowReview(value, {
        task: state.task!,
        candidate: state.candidate!,
      });
    const entries = value?.criteria;
    if (
      recover &&
      value &&
      value.candidate === state.candidate &&
      typeof value.approved === "boolean" &&
      Array.isArray(entries) &&
      entries.length === state.task!.criteria.length &&
      entries.every(
        (entry) =>
          entry &&
          text(entry.id) &&
          typeof entry.satisfied === "boolean" &&
          text(entry.evidence),
      ) &&
      new Set(entries.map((entry) => entry.id)).size === entries.length &&
      state.task!.criteria.every((criterion) =>
        entries.some((entry) => entry.id === criterion.id),
      ) &&
      (!value.approved || entries.some((entry) => !entry.satisfied))
    )
      throw new WorkflowOperationError(
        "substantive",
        `Review rejected: ${
          entries
            .filter((entry) => !entry.satisfied)
            .map((entry) => entry.evidence)
            .join("; ") || "Independent approval denied"
        }`,
      );
    if (
      !value ||
      value.candidate !== state.candidate ||
      value.approved !== true ||
      !Array.isArray(entries) ||
      entries.length !== state.task!.criteria.length ||
      !entries.every(
        (entry) =>
          entry &&
          text(entry.id) &&
          entry.satisfied === true &&
          text(entry.evidence),
      ) ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length ||
      !state.task!.criteria.every((criterion) =>
        entries.some((entry) => entry.id === criterion.id),
      )
    )
      return fail(
        "gate",
        "Independent approval must cover every criterion exactly once for this candidate.",
      );
    return value;
  };
  const checkDelivery = (
    value: WorkflowDelivery | undefined,
  ): WorkflowDelivery => {
    if (!value || value.candidate !== state.candidate || !text(value.reference))
      return fail(
        "gate",
        "Delivery must identify the approved candidate and its receipt.",
      );
    return value;
  };

  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const refreshEvidence = async (): Promise<boolean> => {
    if (!options.evidence) return false;
    state.evidence ??= {
      generation: Math.max(
        0,
        ...Object.keys(state.recovery?.operations ?? {}).map((key) =>
          Number(key.match(/:evidence-(\d+)\//)?.[1] ?? 0),
        ),
      ),
    };
    const supplied = await options.evidence.validation(candidateContext());
    if (
      !supplied ||
      !text(supplied.policy) ||
      !text(supplied.dependencies) ||
      !text(supplied.environment)
    )
      fail(
        "configuration",
        "Evidence identity requires current policy, pinned dependencies and relevant host environment.",
      );
    const identity = {
      candidate: state.candidate!,
      policy: supplied.policy,
      dependencies: supplied.dependencies,
      environment: supplied.environment,
    };
    if (
      !equal(state.evidence.validation, identity) ||
      (state.phase !== "validate" && !state.validation) ||
      (state.validation &&
        (state.validation.passed !== true ||
          !equal(state.validation.identity, identity)))
    ) {
      if (state.inFlight === "deliver")
        fail(
          "uncertain",
          "Delivery inputs changed while its earlier effect is unresolved; reconcile that effect first.",
        );
      state.evidence.generation++;
      state.evidence.validation = identity;
      delete state.evidence.review;
      delete state.validation;
      delete state.review;
      delete state.delivery;
      await advance("validate");
      return true;
    }
    if (state.phase === "validate") return false;
    const validation = checkValidation(state.validation);
    const inputs = await options.evidence.review({
      ...candidateContext(),
      validation,
    });
    if (!text(inputs))
      fail("configuration", "Current independent review inputs are required.");
    const reviewIdentity = {
      validation: identity,
      inputs,
      task: structuredClone(state.task!),
    };
    if (
      !equal(state.evidence.review, reviewIdentity) ||
      (state.review && !equal(state.review.identity, reviewIdentity))
    ) {
      if (state.inFlight === "deliver")
        fail(
          "uncertain",
          "Review inputs changed while delivery is unresolved; reconcile that effect first.",
        );
      state.evidence.generation++;
      state.evidence.review = reviewIdentity;
      delete state.review;
      delete state.delivery;
      await advance("review");
      return true;
    }
    return false;
  };

  try {
    signal?.throwIfAborted();
    if (!options.checkpoint) await persist();
    for (;;) {
      signal?.throwIfAborted();
      try {
        if (
          ["validate", "review", "deliver", "ready"].includes(state.phase) &&
          options.evidence
        ) {
          await checkCandidate();
          if (await refreshEvidence()) continue;
        }
        switch (state.phase) {
          case "select": {
            const selected = await perform("select", () =>
              operations.selectTask(project, signal),
            );
            if (selected === null) {
              await advance("idle");
              break;
            }
            if (!validTask(selected))
              fail(
                "gate",
                "The selected task needs unique, checkable acceptance criteria.",
              );
            state.task = structuredClone(selected);
            await advance("implement");
            break;
          }
          case "implement": {
            if (recover && state.recovery!.implementationAttempts === 0)
              state.recovery!.implementationAttempts = 1;
            state.inFlight = "implement";
            await persist();
            signal?.throwIfAborted();
            const candidate = await perform(
              "implement",
              () =>
                operations.implement({ ...context(), attempt: activeAttempt }),
              "implement",
            );
            if (!text(candidate))
              fail("gate", "Implementation did not identify its candidate.");
            state.candidate = candidate;
            await advance("validate");
            break;
          }
          case "validate": {
            await checkCandidate();
            state.validation = structuredClone(
              checkValidation(
                await perform("validate", () =>
                  operations.validate({
                    ...candidateContext(),
                    attempt: activeAttempt,
                  }),
                ),
              ),
            );
            if (state.evidence)
              state.validation = {
                ...state.validation,
                identity: structuredClone(state.evidence.validation!),
              };
            await advance("review");
            break;
          }
          case "review": {
            await checkCandidate();
            const validation = checkValidation(state.validation);
            const reviewContext = () => ({
              ...candidateContext(),
              validation: structuredClone(validation),
              attempt: activeAttempt,
            });
            let output = await perform("review", () =>
              operations.review(reviewContext()),
            );
            if (state.reviewOutputEnabled) {
              try {
                output = extractWorkflowReview(output, {
                  task: state.task!,
                  candidate: state.candidate!,
                });
              } catch (cause) {
                if (
                  !(cause instanceof WorkflowOperationError) ||
                  cause.kind !== "format"
                )
                  throw cause;
                const scope = JSON.stringify({
                  task: state.task!.id,
                  candidate: state.candidate,
                  implementation: state.recovery!.implementationAttempts,
                  generation:
                    (
                      context() as WorkflowContext<Config> & {
                        evidenceGeneration?: number;
                      }
                    ).evidenceGeneration ?? 0,
                });
                if (state.reviewCorrection?.scope !== scope) {
                  state.reviewCorrection = {
                    scope,
                    consumed: true,
                    output,
                    problem: cause.message,
                  };
                  await persist();
                }
                const correction = state.reviewCorrection;
                output = await perform(`review-correction:${scope}`, () =>
                  options.reviewOutput!.correct({
                    ...reviewContext(),
                    output: structuredClone(correction.output),
                    problem: correction.problem,
                  }),
                );
                output = extractWorkflowReview(output, {
                  task: state.task!,
                  candidate: state.candidate!,
                });
              }
            }
            state.review = structuredClone(
              checkReview(output as WorkflowReview),
            );
            if (state.evidence)
              state.review = {
                ...state.review,
                identity: structuredClone(state.evidence.review!),
              };
            await advance("deliver");
            break;
          }
          case "deliver": {
            await checkCandidate();
            const validation = checkValidation(state.validation);
            const review = checkReview(state.review);
            state.inFlight = "deliver";
            await persist();
            signal?.throwIfAborted();
            state.delivery = structuredClone(
              checkDelivery(
                await perform(
                  "deliver",
                  () =>
                    operations.deliver({
                      ...candidateContext(),
                      validation: structuredClone(validation),
                      review: structuredClone(review),
                      attempt: activeAttempt,
                    }),
                  "deliver",
                ),
              ),
            );
            await advance("ready");
            break;
          }
          case "ready":
            await checkCandidate();
            checkValidation(state.validation);
            checkReview(state.review);
            checkDelivery(state.delivery);
            return structuredClone(state);
          case "idle":
            return structuredClone(state);
        }
      } catch (cause) {
        if (
          !recover ||
          !(cause instanceof WorkflowOperationError) ||
          cause.kind !== "substantive"
        )
          throw cause;
        if (!validTask(state.task))
          fail(
            "gate",
            "Implementation repair requires a valid selected task.",
            cause,
          );
        state.repair = { phase: state.phase, message: cause.message };
        if (state.recovery!.implementationAttempts >= 3)
          fail(
            "exhausted",
            "Three total implementation attempts were consumed; repair stopped.",
            cause,
          );
        state.recovery!.implementationAttempts++;
        delete state.candidate;
        delete state.validation;
        delete state.review;
        delete state.delivery;
        await advance("implement");
      }
    }
  } catch (cause) {
    if (cause instanceof WorkflowError && cause.code === "persistence")
      throw cause;
    const error =
      cause instanceof WorkflowError
        ? cause
        : new WorkflowError(
            signal?.aborted
              ? "cancelled"
              : cause instanceof WorkflowOperationError &&
                  (cause.kind === "permanent" || cause.kind === "format")
                ? cause.kind
                : "operation",
            cause instanceof Error ? cause.message : String(cause),
            state,
            cause,
          );
    state.failure = { code: error.code, message: error.message };
    await persist();
    throw new WorkflowError(error.code, error.message, state, error.cause);
  }
}
