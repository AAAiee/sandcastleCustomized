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
  readonly candidate: string;
  readonly passed: boolean;
  readonly evidence: readonly string[];
}

export interface WorkflowReview {
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
  | "cancelled";

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
  failure?: { code: WorkflowErrorCode; message: string };
}

export interface WorkflowContext<Config> {
  readonly project: WorkflowProject<Config>;
  readonly task: WorkflowTask;
  readonly signal?: AbortSignal;
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
  review(context: WorkflowReviewContext<Config>): Promise<WorkflowReview>;
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
  readonly project: WorkflowProject<Config>;
  readonly operations: WorkflowOperations<Config>;
  readonly checkpoint?: WorkflowCheckpoint;
  readonly signal?: AbortSignal;
}

export async function runWorkflow<Config>(
  options: WorkflowOptions<Config>,
): Promise<WorkflowCheckpoint> {
  const { project, operations, signal } = options;
  const state: WorkflowCheckpoint = structuredClone(
    options.checkpoint ?? { version: 1, project: project.id, phase: "select" },
  );
  const fail = (
    code: WorkflowErrorCode,
    message: string,
    cause?: unknown,
  ): never => {
    throw new WorkflowError(code, message, state, cause);
  };
  const text = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
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
  if (state.inFlight)
    fail(
      "uncertain",
      `The earlier ${state.inFlight} may have performed a side effect. Reconcile it before resuming.`,
    );

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
  });
  const candidateContext = (): WorkflowCandidateContext<Config> => ({
    ...context(),
    candidate: state.candidate!,
  });
  const checkCandidate = async () => {
    signal?.throwIfAborted();
    const current = await operations.currentCandidate(context());
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
    const entries = value?.criteria;
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

  try {
    signal?.throwIfAborted();
    if (!options.checkpoint) await persist();
    for (;;) {
      signal?.throwIfAborted();
      switch (state.phase) {
        case "select": {
          const selected = await operations.selectTask(project, signal);
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
          state.inFlight = "implement";
          await persist();
          signal?.throwIfAborted();
          const candidate = await operations.implement(context());
          if (!text(candidate))
            fail("gate", "Implementation did not identify its candidate.");
          state.candidate = candidate;
          await advance("validate");
          break;
        }
        case "validate": {
          await checkCandidate();
          state.validation = structuredClone(
            checkValidation(await operations.validate(candidateContext())),
          );
          await advance("review");
          break;
        }
        case "review": {
          await checkCandidate();
          const validation = checkValidation(state.validation);
          state.review = structuredClone(
            checkReview(
              await operations.review({
                ...candidateContext(),
                validation: structuredClone(validation),
              }),
            ),
          );
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
              await operations.deliver({
                ...candidateContext(),
                validation: structuredClone(validation),
                review: structuredClone(review),
              }),
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
    }
  } catch (cause) {
    if (cause instanceof WorkflowError && cause.code === "persistence")
      throw cause;
    const error =
      cause instanceof WorkflowError
        ? cause
        : new WorkflowError(
            signal?.aborted ? "cancelled" : "operation",
            cause instanceof Error ? cause.message : String(cause),
            state,
            cause,
          );
    state.failure = { code: error.code, message: error.message };
    await persist();
    throw new WorkflowError(error.code, error.message, state, error.cause);
  }
}
