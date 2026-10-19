import { Effect } from "effect";
import {
  runWorkflowEffect,
  workflowProgram,
  workflowStep,
  workflowSync,
  workflowValue,
} from "./workflow-effects.js";
import { coversCriteria } from "./workflow-criteria.js";
import { extractWorkflowReview } from "./workflow-review.js";
export { extractWorkflowReview } from "./workflow-review.js";
export {
  createWorkflowPacket,
  workflowPacketPolicy,
} from "./workflow-packets.js";
export type {
  WorkflowImplementationPacket,
  WorkflowRepairPacket,
  WorkflowReviewPacket,
  WorkflowCorrectionPacket,
} from "./workflow-packets.js";
/** One task through explicitly supplied project operations. No provider retries or remote defaults. */
export interface WorkflowProject<Config> {
  /** Stable caller-assigned identity; reuse only for the same logical entity. */
  readonly id: string;
  /** Project-owned configuration passed unchanged to operation callbacks. */
  readonly config: Config;
}

/** One selected task and its complete independent acceptance requirements. */
export interface WorkflowTask {
  /** Stable caller-assigned identity; reuse only for the same logical entity. */
  readonly id: string;
  /** Complete acceptance criteria; criterion identifiers must be unique and nonempty. */
  readonly criteria: readonly {
    /** Stable caller-assigned identity; reuse only for the same logical entity. */
    readonly id: string;
    /** Human-readable requirement that the independent reviewer must evaluate. */
    readonly description: string;
  }[];
}

/** Full or diagnostic acceptance observation for an exact candidate; passing diagnostics never authorize delivery. */
export interface WorkflowValidation {
  /** Only failed checks, with concise diagnostics and exact raw evidence locations. */
  readonly failures?: readonly WorkflowFailure[];
  /** Current inputs bound by runWorkflow after the host operation succeeds. */
  readonly identity?: WorkflowValidationIdentity;
  /** Exact immutable implementation identity covered by this value. */
  readonly candidate: string;
  /** True only when every required acceptance check succeeded. */
  readonly passed: boolean;
  /** Raw evidence locations or criterion-specific explanation; must be nonempty for approval. */
  readonly evidence: readonly string[];
}

/** Actionable failure detail carried unchanged into bounded implementation repair. */
export interface WorkflowFailure {
  /** Exact check or acceptance criterion identity. */
  readonly check: string;
  /** Concise failure observation; full output belongs at the evidence locations. */
  readonly diagnostic: string;
  /** Exact locations of the raw output/report for this invocation. */
  readonly evidence: readonly string[];
}

/** Independent criterion-by-criterion findings for an exact candidate. */
export interface WorkflowReview {
  /** Validation, task and independent review inputs covered by this result. */
  readonly identity?: WorkflowReviewIdentity;
  /** Exact immutable implementation identity covered by this value. */
  readonly candidate: string;
  /** Independent approval; true requires every criterion satisfied with evidence. */
  readonly approved: boolean;
  /** Complete acceptance criteria; criterion identifiers must be unique and nonempty. */
  readonly criteria: readonly {
    /** Stable caller-assigned identity; reuse only for the same logical entity. */
    readonly id: string;
    /** Whether this acceptance criterion is met by the reviewed candidate. */
    readonly satisfied: boolean;
    /** Raw evidence locations or criterion-specific explanation; must be nonempty for approval. */
    readonly evidence: string;
  }[];
}

/** Confirmed consumer delivery reference for an immutable candidate. */
export interface WorkflowDelivery {
  /** Exact immutable implementation identity covered by this value. */
  readonly candidate: string;
  /** Consumer-defined durable delivery reference for the exact candidate. */
  readonly reference: string;
}

/** Durable workflow stage; ready and idle are terminal observations. */
export type WorkflowPhase =
  | "select"
  | "implement"
  | "diagnose"
  | "validate"
  | "review"
  | "deliver"
  | "ready"
  | "idle";
/** Stable public workflow failure classifications; callers inspect checkpoint state before recovery. */
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
  /** Creates the public classified failure, retaining the original cause when supplied. */
  constructor(
    /** Semantic failure classification; unknown or permanent failures must not be blindly retried. */
    readonly kind: "transport" | "substantive" | "permanent" | "format",
    message: string,
    cause?: unknown,
    /** Concise failed checks and raw evidence pointers for bounded repair; absent when unavailable. */
    readonly failures?: readonly WorkflowFailure[],
  ) {
    super(message, { cause });
    this.name = "WorkflowOperationError";
  }
}
/** Invocation identity within separate durable implementation and transport budgets. */
export interface WorkflowAttempt {
  /** Stable logical operation identity shared across its transport attempts. */
  readonly operation: string;
  /** Implementation attempts consumed so far; zero before the first implementation begins. */
  readonly implementation: number;
  /** One-based transport invocation for this operation. */
  readonly transport: number;
}
/** Persisted attempt consumption and operation outcomes; retained across restart. */
export interface WorkflowRecoveryState {
  /** Implementation attempts already consumed, including interrupted attempts. */
  implementationAttempts: number;
  /** Durable operation ledger; resume preserves consumed attempts and known outcomes. */
  operations: Record<
    string,
    {
      /** Invocations already consumed for this logical operation. */
      attempts: number;
      /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
      status: "running" | "interrupted" | "completed" | "stopped";
      /** Earliest retry time in epoch milliseconds; omitted when no backoff is pending. */
      nextAttemptAt?: number;
      /** Persisted completed operation value, when known. */
      result?: unknown;
      /** Last observed failure; preserved for recovery and diagnostics. */
      failure?: {
        /** Semantic failure classification; unknown or permanent failures must not be blindly retried. */
        /** Semantic failure classification; unknown or permanent failures must not be blindly retried. */
        kind: string; /** Concise human-readable failure or repair explanation. */
        /** Concise human-readable failure or repair explanation. */
        message: string;
      };
    }
  >;
}
/** Explicit observation of an interrupted write; uncertain effects forbid replay. */
export type WorkflowReconciliation =
  | {
      /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
      /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
      status: "completed"; /** Observed result of a confirmed completed operation. */
      /** Observed result of a confirmed completed operation. */
      value: unknown;
    }
  | {
      /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
      /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
      status: "not-started";
    }
  | {
      /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
      /** Explicit lifecycle/outcome classification; uncertainty forbids blind replay. */
      status: "uncertain";
    };
/** Optional bounded recovery capabilities; unknown outcomes stop until reconciled. */
export interface WorkflowRecovery<Config> {
  /** Observe the effect before permitting an interrupted implementation/delivery to replay. */
  reconcile?(
    context: WorkflowContext<Config> & {
      /** Workflow stage associated with this checkpoint or recovery observation. */
      phase: "implement" | "deliver";
      /** Attempt identity for this invocation; omitted when durable recovery is disabled. */
      attempt: WorkflowAttempt;
      /** Exact immutable implementation identity covered by this value. */
      candidate?: string;
      /** Full acceptance evidence for the current candidate; diagnostics cannot substitute. */
      validation?: WorkflowValidation;
      /** Independent review result covering the current candidate and acceptance evidence. */
      review?: WorkflowReview;
    },
  ): Promise<WorkflowReconciliation>;
  /** Time boundaries, injectable for deterministic consumers/tests. Backoff remains persisted. */
  now?(): number;
  /** Optional cancellable backoff capability; defaults to bounded host timers and must not clear persisted retry budgets. */
  wait?(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/** Complete JSON-serializable state to durably replace before acknowledging each transition. */
export interface WorkflowCheckpoint {
  /** Persisted schema version; only version 1 is accepted. */
  version: 1;
  /** Explicit project identity; prevents cross-project checkpoint or evidence reuse. */
  project: string;
  /** Workflow stage associated with this checkpoint or recovery observation. */
  phase: WorkflowPhase;
  /** Selected task scope and complete acceptance criteria. */
  task?: WorkflowTask;
  /** Exact immutable implementation identity covered by this value. */
  candidate?: string;
  /** Full acceptance evidence for the current candidate; diagnostics cannot substitute. */
  validation?: WorkflowValidation;
  /** Optional incremental diagnostic result; never authorizes delivery. */
  diagnostic?: WorkflowValidation;
  /** Diagnostics cannot be silently omitted on resume. Their pass never replaces full validation. */
  diagnosticsEnabled?: true;
  /** Independent review result covering the current candidate and acceptance evidence. */
  review?: WorkflowReview;
  /** Confirmed delivery result for the current candidate. */
  delivery?: WorkflowDelivery;
  /** Write operation whose durable intent was saved before execution; requires reconciliation after interruption. */
  inFlight?: "implement" | "deliver";
  /** Durable attempt counters and outcomes; do not reset when resuming. */
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
  /** Prior substantive rejection and failed-check context for the next bounded implementation attempt. */
  repair?: {
    /** Workflow stage associated with this checkpoint or recovery observation. */
    phase: WorkflowPhase;
    /** Concise human-readable failure or repair explanation. */
    message: string;
    /** Concise failed checks and raw evidence pointers for bounded repair; absent when unavailable. */
    failures?: readonly WorkflowFailure[];
  };
  /** Durable evidence generation; completed operations from older inputs are never reused. */
  evidence?: {
    /** Durable evidence generation; increments when validation inputs change. */
    generation: number;
    /** Full acceptance evidence for the current candidate; diagnostics cannot substitute. */
    validation?: WorkflowValidationIdentity;
    /** Independent review result covering the current candidate and acceptance evidence. */
    review?: WorkflowReviewIdentity;
  };
  /** Last observed failure; preserved for recovery and diagnostics. */
  failure?: {
    /** Stable public failure category used for caller recovery decisions. */
    /** Stable public failure category used for caller recovery decisions. */
    code: WorkflowErrorCode; /** Concise human-readable failure or repair explanation. */
    /** Concise human-readable failure or repair explanation. */
    message: string;
  };
}

/** Selected project/task plus invocation, cancellation and bounded repair context. */
export interface WorkflowContext<Config> {
  /** Evidence generation for context-bound consumer records such as correction sessions. */
  readonly evidenceGeneration?: number;
  /** Explicit project identity; prevents cross-project checkpoint or evidence reuse. */
  readonly project: WorkflowProject<Config>;
  /** Selected task scope and complete acceptance criteria. */
  readonly task: WorkflowTask;
  /** Optional caller cancellation; abort prevents new work and preserves recovery/cleanup obligations. */
  readonly signal?: AbortSignal;
  /** Attempt identity for this invocation; omitted when durable recovery is disabled. */
  readonly attempt?: WorkflowAttempt;
  /** Prior substantive rejection and failed-check context for the next bounded implementation attempt. */
  readonly repair?: WorkflowCheckpoint["repair"];
}
/** Task invocation bound to an exact immutable implementation candidate. */
export interface WorkflowCandidateContext<
  Config,
> extends WorkflowContext<Config> {
  /** Exact immutable implementation identity covered by this value. */
  readonly candidate: string;
}
/** Independent review input containing full acceptance for the candidate. */
export interface WorkflowReviewContext<
  Config,
> extends WorkflowCandidateContext<Config> {
  /** Full acceptance evidence for the current candidate; diagnostics cannot substitute. */
  readonly validation: WorkflowValidation;
}
/** Delivery authorization containing current validation and independent approval. */
export interface WorkflowDeliveryContext<
  Config,
> extends WorkflowReviewContext<Config> {
  /** Independent review result covering the current candidate and acceptance evidence. */
  readonly review: WorkflowReview;
}

/** Explicit project capabilities. Callbacks must preserve supplied identities, honor cancellation and classify provider failures at their seam. */
export interface WorkflowOperations<Config> {
  /** Selects one eligible task, or null for idle; the consumer owns repository policy and must honor cancellation. */
  selectTask(
    project: WorkflowProject<Config>,
    signal?: AbortSignal,
  ): Promise<WorkflowTask | null>;
  /** Implements the selected task and returns its exact candidate identity. Interrupted writes need explicit reconciliation before replay. */
  implement(context: WorkflowContext<Config>): Promise<string>;
  /** Observes the current immutable candidate without modifying code; mismatches invalidate saved gates. */
  currentCandidate(context: WorkflowContext<Config>): Promise<string>;
  /** Runs full required acceptance for this candidate and returns truthful results with raw evidence locations. */
  validate(
    context: WorkflowCandidateContext<Config>,
  ): Promise<WorkflowValidation>;
  /** Obtains independent findings for this exact candidate and task; returns a parsed review or strict output when reviewOutput is enabled. */
  review(
    context: WorkflowReviewContext<Config>,
  ): Promise<WorkflowReview | string>;
  /** Delivers this approved, validated candidate and returns its reference. Interrupted writes need explicit reconciliation before replay. */
  deliver(context: WorkflowDeliveryContext<Config>): Promise<WorkflowDelivery>;
  /** Must durably replace the stored checkpoint before resolving. */
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
}

/** Public workflow failure with a defensive checkpoint snapshot and original underlying cause. */
export class WorkflowError extends Error {
  /** Defensive copy of the latest durable workflow state for inspection/resume after failure. */
  readonly checkpoint: WorkflowCheckpoint;
  /** Creates the public classified failure, retaining the original cause when supplied. */
  constructor(
    /** Stable public failure category used for caller recovery decisions. */
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

/** Explicit project operations and opt-in recovery/evidence policies; no remote provider or repository defaults. */
export interface WorkflowOptions<Config> {
  /** Optional project-supplied incremental diagnostics, before full acceptance. */
  readonly diagnostics?: (
    context: WorkflowCandidateContext<Config>,
  ) => Promise<WorkflowValidation>;
  /** Current project-owned policy/dependency/host inputs. Saved identities are never defaults. */
  readonly evidence?: WorkflowEvidence<Config>;
  /** Explicit project identity; prevents cross-project checkpoint or evidence reuse. */
  readonly project: WorkflowProject<Config>;
  /** Explicit consumer capabilities for selection, implementation, acceptance, independent review, delivery and durable checkpoint saves. */
  readonly operations: WorkflowOperations<Config>;
  /** Previously saved checkpoint to resume, or omitted for a fresh selection. */
  readonly checkpoint?: WorkflowCheckpoint;
  /** Optional caller cancellation; abort prevents new work and preserves recovery/cleanup obligations. */
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

/** Runs one selected task through implementation, optional diagnostics, full acceptance, independent review and delivery. Saves intent/checkpoints before effects. Resolves ready/idle state; rejects WorkflowError with resumable state on gates, exhausted budgets, cancellation or persistence failure. The consumer owns truthful callbacks and durable saves. */
export function runWorkflow<Config>(
  options: WorkflowOptions<Config>,
): Promise<WorkflowCheckpoint> {
  return runWorkflowEffect(runWorkflowProgram(options));
}

function runWorkflowProgram<Config>(options: WorkflowOptions<Config>) {
  return workflowProgram(
    Effect.gen(function* () {
      const { project, operations, signal } = options;
      const state: WorkflowCheckpoint = structuredClone(
        options.checkpoint ?? {
          version: 1,
          project: project.id,
          phase: "select",
        },
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
      if (options.diagnostics) state.diagnosticsEnabled = true;
      if (state.diagnosticsEnabled && typeof options.diagnostics !== "function")
        fail(
          "configuration",
          "The saved diagnostic policy requires its explicit operation on resume.",
        );
      if (
        state.reviewOutputEnabled &&
        typeof options.reviewOutput?.correct !== "function"
      )
        fail(
          "configuration",
          "The saved strict-review policy requires its explicit correction operation on resume.",
        );
      const validTask = (
        value: WorkflowTask | undefined,
      ): value is WorkflowTask =>
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
          "diagnose",
          "validate",
          "review",
          "deliver",
          "ready",
          "idle",
        ].includes(state.phase) ||
        (!["select", "idle"].includes(state.phase) && !validTask(state.task)) ||
        (["diagnose", "validate", "review", "deliver", "ready"].includes(
          state.phase,
        ) &&
          !text(state.candidate)) ||
        (state.inFlight !== undefined &&
          (state.inFlight !== state.phase ||
            !["implement", "deliver"].includes(state.inFlight))) ||
        (state.phase === "diagnose" && !state.diagnosticsEnabled)
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
      if (recover)
        state.recovery ??= { implementationAttempts: 0, operations: {} };
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
        const diagnosticScope =
          state.diagnosticsEnabled && name !== "implement" && name !== "select"
            ? ":diagnostics"
            : "";
        return `${scopedName}${diagnosticScope}/${state.recovery!.implementationAttempts}`;
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
                cause instanceof WorkflowOperationError
                  ? cause.kind
                  : "unknown",
              message: cause instanceof Error ? cause.message : String(cause),
            };
            record.status =
              cause instanceof WorkflowOperationError &&
              cause.kind === "transport"
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
            operations.currentCandidate({
              ...context(),
              attempt: activeAttempt,
            }),
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
            undefined,
            value.failures,
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
      const checkReview = (
        value: WorkflowReview | undefined,
      ): WorkflowReview => {
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
          entries.every(
            (entry) =>
              entry &&
              text(entry.id) &&
              typeof entry.satisfied === "boolean" &&
              text(entry.evidence),
          ) &&
          coversCriteria(state.task!.criteria, entries) &&
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
            undefined,
            entries
              .filter((entry) => !entry.satisfied)
              .map((entry) => ({
                check: entry.id,
                diagnostic: entry.evidence,
                evidence: [],
              })),
          );
        if (
          !value ||
          value.candidate !== state.candidate ||
          value.approved !== true ||
          !Array.isArray(entries) ||
          !entries.every(
            (entry) =>
              entry &&
              text(entry.id) &&
              entry.satisfied === true &&
              text(entry.evidence),
          ) ||
          !coversCriteria(state.task!.criteria, entries)
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
        if (
          !value ||
          value.candidate !== state.candidate ||
          !text(value.reference)
        )
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
          (!["diagnose", "validate"].includes(state.phase) &&
            !state.validation) ||
          (state.validation &&
            (state.validation.passed !== true ||
              !equal(state.validation.identity, identity))) ||
          (state.diagnosticsEnabled &&
            state.diagnostic &&
            (state.diagnostic.passed !== true ||
              !equal(state.diagnostic.identity, identity)))
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
          delete state.diagnostic;
          delete state.review;
          delete state.delivery;
          await advance(state.diagnosticsEnabled ? "diagnose" : "validate");
          return true;
        }
        if (["diagnose", "validate"].includes(state.phase)) return false;
        const validation = checkValidation(state.validation);
        const inputs = await options.evidence.review({
          ...candidateContext(),
          validation,
        });
        if (!text(inputs))
          fail(
            "configuration",
            "Current independent review inputs are required.",
          );
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
        if (!options.checkpoint)
          workflowValue(yield* workflowStep(() => persist()));
        for (;;) {
          signal?.throwIfAborted();
          try {
            if (
              ["diagnose", "validate", "review", "deliver", "ready"].includes(
                state.phase,
              ) &&
              options.evidence
            ) {
              workflowValue(yield* workflowStep(() => checkCandidate()));
              if (workflowValue(yield* workflowStep(() => refreshEvidence())))
                continue;
            }
            if (
              state.diagnosticsEnabled &&
              ["validate", "review", "deliver", "ready"].includes(state.phase)
            ) {
              if (!state.diagnostic) {
                if (state.inFlight)
                  fail(
                    "uncertain",
                    "Diagnostics are missing while delivery is unresolved; reconcile the earlier effect first.",
                  );
                delete state.validation;
                delete state.review;
                delete state.delivery;
                workflowValue(yield* workflowStep(() => advance("diagnose")));
                continue;
              }
              checkValidation(state.diagnostic);
            }
            switch (state.phase) {
              case "select": {
                const selected = workflowValue(
                  yield* workflowStep(() =>
                    perform("select", () =>
                      operations.selectTask(project, signal),
                    ),
                  ),
                );
                if (selected === null) {
                  workflowValue(yield* workflowStep(() => advance("idle")));
                  break;
                }
                if (!validTask(selected))
                  fail(
                    "gate",
                    "The selected task needs unique, checkable acceptance criteria.",
                  );
                state.task = structuredClone(selected);
                workflowValue(yield* workflowStep(() => advance("implement")));
                break;
              }
              case "implement": {
                if (recover && state.recovery!.implementationAttempts === 0)
                  state.recovery!.implementationAttempts = 1;
                state.inFlight = "implement";
                workflowValue(yield* workflowStep(() => persist()));
                signal?.throwIfAborted();
                const candidate = workflowValue(
                  yield* workflowStep(() =>
                    perform(
                      "implement",
                      () =>
                        operations.implement({
                          ...context(),
                          attempt: activeAttempt,
                        }),
                      "implement",
                    ),
                  ),
                );
                if (!text(candidate))
                  fail(
                    "gate",
                    "Implementation did not identify its candidate.",
                  );
                state.candidate = candidate;
                workflowValue(
                  yield* workflowStep(() =>
                    advance(state.diagnosticsEnabled ? "diagnose" : "validate"),
                  ),
                );
                break;
              }
              case "diagnose": {
                workflowValue(yield* workflowStep(() => checkCandidate()));
                state.diagnostic = structuredClone(
                  checkValidation(
                    workflowValue(
                      yield* workflowStep(() =>
                        perform("diagnose", () =>
                          options.diagnostics!({
                            ...candidateContext(),
                            attempt: activeAttempt,
                          }),
                        ),
                      ),
                    ),
                  ),
                );
                if (state.evidence)
                  state.diagnostic = {
                    ...state.diagnostic,
                    identity: structuredClone(state.evidence.validation!),
                  };
                workflowValue(yield* workflowStep(() => advance("validate")));
                break;
              }
              case "validate": {
                workflowValue(yield* workflowStep(() => checkCandidate()));
                state.validation = structuredClone(
                  checkValidation(
                    workflowValue(
                      yield* workflowStep(() =>
                        perform("validate", () =>
                          operations.validate({
                            ...candidateContext(),
                            attempt: activeAttempt,
                          }),
                        ),
                      ),
                    ),
                  ),
                );
                if (state.evidence)
                  state.validation = {
                    ...state.validation,
                    identity: structuredClone(state.evidence.validation!),
                  };
                workflowValue(yield* workflowStep(() => advance("review")));
                break;
              }
              case "review": {
                workflowValue(yield* workflowStep(() => checkCandidate()));
                const validation = checkValidation(state.validation);
                const reviewContext = () => ({
                  ...candidateContext(),
                  validation: structuredClone(validation),
                  attempt: activeAttempt,
                });
                let output = workflowValue(
                  yield* workflowStep(() =>
                    perform("review", () => operations.review(reviewContext())),
                  ),
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
                      workflowValue(yield* workflowStep(() => persist()));
                    }
                    const correction = state.reviewCorrection;
                    output = workflowValue(
                      yield* workflowStep(() =>
                        perform(`review-correction:${scope}`, () =>
                          options.reviewOutput!.correct({
                            ...reviewContext(),
                            output: structuredClone(correction.output),
                            problem: correction.problem,
                          }),
                        ),
                      ),
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
                workflowValue(yield* workflowStep(() => advance("deliver")));
                break;
              }
              case "deliver": {
                workflowValue(yield* workflowStep(() => checkCandidate()));
                const validation = checkValidation(state.validation);
                const review = checkReview(state.review);
                state.inFlight = "deliver";
                workflowValue(yield* workflowStep(() => persist()));
                signal?.throwIfAborted();
                state.delivery = structuredClone(
                  checkDelivery(
                    workflowValue(
                      yield* workflowStep(() =>
                        perform(
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
                    ),
                  ),
                );
                workflowValue(yield* workflowStep(() => advance("ready")));
                break;
              }
              case "ready":
                workflowValue(yield* workflowStep(() => checkCandidate()));
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
            state.repair = {
              phase: state.phase,
              message: cause.message,
              ...(cause.failures
                ? { failures: structuredClone(cause.failures) }
                : {}),
            };
            if (state.recovery!.implementationAttempts >= 3)
              fail(
                "exhausted",
                "Three total implementation attempts were consumed; repair stopped.",
                cause,
              );
            state.recovery!.implementationAttempts++;
            delete state.candidate;
            delete state.validation;
            delete state.diagnostic;
            delete state.review;
            delete state.delivery;
            workflowValue(yield* workflowStep(() => advance("implement")));
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
        workflowValue(yield* workflowStep(() => persist()));
        throw new WorkflowError(error.code, error.message, state, error.cause);
      }
    }),
  );
}
