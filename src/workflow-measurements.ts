import { Effect } from "effect";
import {
  runWorkflowEffect,
  workflowProgram,
  workflowStep,
  workflowValue,
} from "./workflow-effects.js";
import { performance } from "node:perf_hooks";

/** Project/run/task/environment scope; reports and every record must match exactly. */
export interface MeasurementIdentity {
  /** Explicit project identity; prevents cross-project checkpoint or evidence reuse. */
  readonly project: string;
  /** Explicit logical run identity; reuse only when resuming the same run. */
  readonly run: string;
  /** Explicit task identity within this project/run; unchanged when the same task resumes. */
  readonly task: string;
  /** Consumer-supplied runner/toolchain/dependency identity, without credentials. */
  readonly environment: string;
}
/** Provider usage with an explicit completeness scope. Counts are nonnegative integers and fresh input excludes cache creation/read. */
export interface MeasurementUsage {
  /** Whether usage covers the entire stage or only the last SDK message; snapshots never become stage totals. */
  readonly scope: "stage-total" | "last-message";
  /** SDK-shaped fresh input, excluding cache creation and cache reads. */
  readonly inputTokens: number;
  /** Nonnegative cache creation input tokens, separate from fresh and cached-read tokens. */
  readonly cacheCreationInputTokens: number;
  /** Nonnegative cached input tokens read by the provider. */
  readonly cacheReadInputTokens: number;
  /** Nonnegative provider output token count. */
  readonly outputTokens: number;
}
/** Normalized stage token totals; null explicitly means unavailable, never zero. */
export interface MeasurementTokens {
  /** Fresh plus cache-creation plus cache-read input tokens; null when stage totals are unavailable. */
  totalInput: number | null;
  /** Cached-read input tokens; null when unavailable. */
  cachedInput: number | null;
  /** Fresh plus cache-creation input tokens; null when unavailable. */
  freshInput: number | null;
  /** Output token count; null when unavailable. */
  output: number | null;
}
/** One durable stage/check invocation, including outcome, elapsed time and honest provider-data limits. */
export interface MeasurementRecord extends MeasurementIdentity {
  /** One-based sequence number within this report. */
  id: number;
  /** Stable consumer stage name used to group operation attempts. */
  stage: string;
  /** Optional individual acceptance check identity. */
  check?: string;
  /** Exact immutable implementation identity covered by this value. */
  candidate?: string;
  /** Optional actual provider/model identity; omitted when unavailable. */
  model?: string;
  /** One-based attempt for this stage/check. */
  attempt: number;
  /** Observed retry count; null or omission means unavailable, never an invented zero. */
  retries: number | null;
  /** Wall-clock ISO timestamp when this measurement began. */
  started: string;
  /** Elapsed monotonic milliseconds; null after interruption or when unavailable. */
  durationMs: number | null;
  /** Observed operation outcome; abandoned running records become interrupted on reload. */
  outcome: "running" | "succeeded" | "rejected" | "failed" | "interrupted";
  /** Stage totals; unavailable measurements retain explicit null values. */
  tokens: MeasurementTokens;
  /** Provider-reported usage and scope, preserved even when it cannot establish stage totals. */
  observedUsage?: {
    /** Whether usage covers the entire stage or only the last SDK message; snapshots never become stage totals. */
    scope: MeasurementUsage["scope"];
    /** Stage totals; unavailable measurements retain explicit null values. */
    tokens: MeasurementTokens;
  };
  /** Reasons measurements are unavailable; missing data must not become claimed savings. */
  unavailable: string[];
}
/** Versioned measurement ledger for exactly one identity. */
export interface MeasurementReport {
  /** Persisted schema version; only version 1 is accepted. */
  version: 1;
  /** Project/run/task/environment identity shared by every report record. */
  identity: MeasurementIdentity;
  /** Append-only operation observations for this identity. */
  records: MeasurementRecord[];
}
/** Stage/check identity and optional actual model/attempt/retry observations. */
export interface MeasurementStage {
  /** Stable consumer stage name used to group operation attempts. */
  readonly stage: string;
  /** Optional individual acceptance check identity. */
  readonly check?: string;
  /** Exact immutable implementation identity covered by this value. */
  readonly candidate?: string;
  /** Optional actual provider/model identity; omitted when unavailable. */
  readonly model?: string;
  /** Optional explicit one-based attempt; defaults to the number of prior matching stage/check records plus one. */
  readonly attempt?: number;
  /** Observed retry count; null or omission means unavailable, never an invented zero. */
  readonly retries?: number;
}
/** Callbacks the measured action uses to report provider usage or substantive rejection without changing workflow policy. */
export interface MeasurementObservation {
  /** Supplies truthful provider usage; invalid counts make token totals unavailable, and last-message snapshots never establish stage totals. */
  usage(value: MeasurementUsage): void;
  /** Marks successful callback completion as a substantive rejection; it does not throw or alter retry policy. */
  rejected(): void;
}
const unavailableTokens = (): MeasurementTokens => ({
  totalInput: null,
  cachedInput: null,
  freshInput: null,
  output: null,
});

/** Creates measurements for explicit operations. Invalid/mismatched identity throws immediately; reloaded running records become interrupted with unavailable duration. Actions report actual usage through observation callbacks. Report saves bracket each action and failures reject. Never changes agent routing, retry policy or token limits. */
export function createWorkflowMeasurements(options: {
  /** Explicit project/run/task/environment identities; report or record mismatches throw before measuring. */
  identity: MeasurementIdentity;
  /** Previously persisted report for the same identity; omitted starts an empty report. */
  previous?: MeasurementReport;
  /** Durably replaces the complete report before action execution and after completion; failures reject and preserve original action failure in AggregateError when both fail. */
  save(report: MeasurementReport): Promise<void>;
  /** Optional monotonic millisecond clock; defaults to performance.now. */
  now?: () => number;
}) {
  const identityKeys = ["project", "run", "task", "environment"] as const;
  for (const key of identityKeys) {
    const value = options.identity?.[key];
    if (typeof value !== "string" || !value.trim())
      throw new Error("Explicit measurement identity is required.");
  }
  const report: MeasurementReport = structuredClone(
    options.previous ?? { version: 1, identity: options.identity, records: [] },
  );
  if (
    report.version !== 1 ||
    !Array.isArray(report.records) ||
    identityKeys.some(
      (key) =>
        report.identity[key as keyof MeasurementIdentity] !==
        options.identity[key as keyof MeasurementIdentity],
    )
  )
    throw new Error("Measurement report identity does not match this run.");
  for (const record of report.records) {
    if (identityKeys.some((key) => record[key] !== report.identity[key]))
      throw new Error("Measurement record identity does not match this run.");
    if (record.outcome === "running") {
      record.outcome = "interrupted";
      record.durationMs = null;
      record.unavailable.push(
        "Interrupted operation outcome and elapsed time are unavailable.",
      );
    }
  }
  const now = options.now ?? (() => performance.now());
  return {
    /** Returns a defensive snapshot, including interrupted records recovered at construction. */
    report: () => structuredClone(report),
    /** Saves running intent before invoking action and saves the final outcome afterward. Rejects the original action/save failure, or AggregateError when both fail. Usage callbacks must report actual provider data. */
    measure<T>(
      stage: MeasurementStage,
      action: (observation: MeasurementObservation) => Promise<T>,
    ): Promise<T> {
      return runWorkflowEffect(
        workflowProgram(
          Effect.gen(function* () {
            const record: MeasurementRecord = {
              ...report.identity,
              stage: stage.stage,
              ...(stage.check === undefined ? {} : { check: stage.check }),
              ...(stage.candidate === undefined
                ? {}
                : { candidate: stage.candidate }),
              ...(stage.model === undefined ? {} : { model: stage.model }),
              id: report.records.length + 1,
              attempt:
                stage.attempt ??
                report.records.filter(
                  (r) => r.stage === stage.stage && r.check === stage.check,
                ).length + 1,
              retries: stage.retries ?? null,
              started: new Date().toISOString(),
              durationMs: null,
              outcome: "running",
              tokens: unavailableTokens(),
              unavailable: [
                "Provider usage was not supplied.",
                ...(stage.retries === undefined
                  ? ["Retry count was not supplied."]
                  : []),
              ],
            };
            report.records.push(record);
            workflowValue(
              yield* workflowStep(() => options.save(structuredClone(report))),
            );
            const start = now();
            let rejected = false;
            let failed = false;
            let failure: unknown;
            try {
              const result = workflowValue(
                yield* workflowStep(() =>
                  action({
                    usage: (value) => {
                      if (
                        !value ||
                        !["stage-total", "last-message"].includes(
                          value.scope,
                        ) ||
                        ![
                          value.inputTokens,
                          value.cacheCreationInputTokens,
                          value.cacheReadInputTokens,
                          value.outputTokens,
                        ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
                        !Number.isSafeInteger(
                          value.inputTokens +
                            value.cacheCreationInputTokens +
                            value.cacheReadInputTokens,
                        )
                      ) {
                        record.tokens = unavailableTokens();
                        delete record.observedUsage;
                        record.unavailable = [
                          "Provider usage is invalid; token measurements are unavailable.",
                          ...(stage.retries === undefined
                            ? ["Retry count was not supplied."]
                            : []),
                        ];
                        return;
                      }
                      const tokens = {
                        totalInput:
                          value.inputTokens +
                          value.cacheCreationInputTokens +
                          value.cacheReadInputTokens,
                        cachedInput: value.cacheReadInputTokens,
                        freshInput:
                          value.inputTokens + value.cacheCreationInputTokens,
                        output: value.outputTokens,
                      };
                      record.observedUsage = { scope: value.scope, tokens };
                      record.tokens =
                        value.scope === "stage-total"
                          ? tokens
                          : unavailableTokens();
                      record.unavailable = [
                        ...(value.scope === "last-message"
                          ? [
                              "Stage totals are unavailable: the SDK supplied only last-message usage.",
                            ]
                          : []),
                        ...(stage.retries === undefined
                          ? ["Retry count was not supplied."]
                          : []),
                      ];
                    },
                    rejected: () => {
                      rejected = true;
                    },
                  }),
                ),
              );
              record.outcome = rejected ? "rejected" : "succeeded";
              return result;
            } catch (cause) {
              failed = true;
              failure = cause;
              record.outcome = "failed";
              throw cause;
            } finally {
              record.durationMs = now() - start;
              try {
                workflowValue(
                  yield* workflowStep(() =>
                    options.save(structuredClone(report)),
                  ),
                );
              } catch (cause) {
                if (failed)
                  throw new AggregateError(
                    [failure, cause],
                    "Operation and measurement persistence both failed.",
                    { cause: failure },
                  );
                throw cause;
              }
            }
          }),
        ),
      );
    },
  };
}
