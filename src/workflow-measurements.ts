import { performance } from "node:perf_hooks";

export interface MeasurementIdentity {
  readonly project: string;
  readonly run: string;
  readonly task: string;
  /** Consumer-supplied runner/toolchain/dependency identity, without credentials. */
  readonly environment: string;
}
export interface MeasurementUsage {
  readonly scope: "stage-total" | "last-message";
  /** SDK-shaped fresh input, excluding cache creation and cache reads. */
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}
export interface MeasurementTokens {
  totalInput: number | null;
  cachedInput: number | null;
  freshInput: number | null;
  output: number | null;
}
export interface MeasurementRecord extends MeasurementIdentity {
  id: number;
  stage: string;
  check?: string;
  candidate?: string;
  model?: string;
  attempt: number;
  retries: number | null;
  started: string;
  durationMs: number | null;
  outcome: "running" | "succeeded" | "rejected" | "failed" | "interrupted";
  tokens: MeasurementTokens;
  observedUsage?: {
    scope: MeasurementUsage["scope"];
    tokens: MeasurementTokens;
  };
  unavailable: string[];
}
export interface MeasurementReport {
  version: 1;
  identity: MeasurementIdentity;
  records: MeasurementRecord[];
}
export interface MeasurementStage {
  readonly stage: string;
  readonly check?: string;
  readonly candidate?: string;
  readonly model?: string;
  readonly attempt?: number;
  readonly retries?: number;
}
export interface MeasurementObservation {
  usage(value: MeasurementUsage): void;
  rejected(): void;
}
const unavailableTokens = (): MeasurementTokens => ({
  totalInput: null,
  cachedInput: null,
  freshInput: null,
  output: null,
});

/** Measures explicit operations; never changes agent routing, retry policy or token limits. */
export function createWorkflowMeasurements(options: {
  identity: MeasurementIdentity;
  previous?: MeasurementReport;
  save(report: MeasurementReport): Promise<void>;
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
    report: () => structuredClone(report),
    async measure<T>(
      stage: MeasurementStage,
      action: (observation: MeasurementObservation) => Promise<T>,
    ): Promise<T> {
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
      await options.save(structuredClone(report));
      const start = now();
      let rejected = false;
      let failed = false;
      let failure: unknown;
      try {
        const result = await action({
          usage: (value) => {
            if (
              !value ||
              !["stage-total", "last-message"].includes(value.scope) ||
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
              freshInput: value.inputTokens + value.cacheCreationInputTokens,
              output: value.outputTokens,
            };
            record.observedUsage = { scope: value.scope, tokens };
            record.tokens =
              value.scope === "stage-total" ? tokens : unavailableTokens();
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
        });
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
          await options.save(structuredClone(report));
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
    },
  };
}
