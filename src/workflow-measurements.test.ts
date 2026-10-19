import { expect, test } from "vitest";
import { createWorkflowMeasurements } from "./workflow-measurements.js";

const identity = {
  project: "consumer-a",
  run: "run-1",
  task: "task-9",
  environment: "toolchain-v1",
};

test("a measured stage persists its duration and counts cached input within total input", async () => {
  let now = 100;
  const saved: unknown[] = [];
  const measurements = createWorkflowMeasurements({
    identity,
    now: () => now,
    save: async (value) => {
      saved.push(structuredClone(value));
    },
  });
  const result = await measurements.measure(
    { stage: "implement", attempt: 2, retries: 1 },
    async (observation) => {
      observation.usage({
        scope: "stage-total",
        inputTokens: 20,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 70,
        outputTokens: 12,
      });
      now = 350;
      return "candidate";
    },
  );
  expect(result).toBe("candidate");
  expect(measurements.report().records[0]).toMatchObject({
    ...identity,
    stage: "implement",
    attempt: 2,
    retries: 1,
    outcome: "succeeded",
    durationMs: 250,
    tokens: { totalInput: 100, cachedInput: 70, freshInput: 30, output: 12 },
    unavailable: [],
  });
  expect(saved).toHaveLength(2);
  expect(
    (saved[0] as { records: { outcome: string }[] }).records[0]?.outcome,
  ).toBe("running");
});

test("failure to persist final telemetry preserves both the operation failure and storage failure", async () => {
  const operation = new Error("operation failed");
  const storage = new Error("disk unavailable");
  let saves = 0;
  const measurements = createWorkflowMeasurements({
    identity,
    save: async () => {
      if (++saves === 2) throw storage;
    },
  });
  const error = await measurements
    .measure({ stage: "validate" }, async () => {
      throw operation;
    })
    .catch((error) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([operation, storage]);
  expect(error.cause).toBe(operation);
});

test("malformed provider metrics are explicitly unavailable and cannot become negative or non-finite totals", async () => {
  const measurements = createWorkflowMeasurements({
    identity,
    save: async () => {},
  });
  await measurements.measure(
    { stage: "review", retries: 0 },
    async (observation) => {
      observation.usage({
        scope: "stage-total",
        inputTokens: -2,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 80,
        outputTokens: NaN,
      });
    },
  );
  const record = measurements.report().records[0]!;
  expect(record.tokens).toEqual({
    totalInput: null,
    cachedInput: null,
    freshInput: null,
    output: null,
  });
  expect(record.unavailable.join(" ")).toMatch(/invalid/i);
});

test("reloading an interrupted measurement keeps unknown outcomes and continues attempt accounting", async () => {
  let durable: any;
  const first = createWorkflowMeasurements({
    identity,
    save: async (report) => {
      durable = structuredClone(report);
    },
  });
  let release!: () => void;
  const running = first.measure(
    { stage: "correction" },
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const second = createWorkflowMeasurements({
    identity,
    previous: structuredClone(durable),
    save: async (report) => {
      durable = structuredClone(report);
    },
  });
  await second.measure(
    { stage: "correction", retries: 0 },
    async (observation) => {
      observation.rejected();
    },
  );
  expect(
    second
      .report()
      .records.map((record) => [
        record.attempt,
        record.outcome,
        record.durationMs,
      ]),
  ).toEqual([
    [1, "interrupted", null],
    [2, "rejected", expect.any(Number)],
  ]);
  expect(second.report().records[0]!.unavailable.join(" ")).toMatch(
    /Interrupted/,
  );
  release();
  await running;
  expect(() =>
    createWorkflowMeasurements({
      identity: { ...identity, project: "consumer-b" },
      previous: durable,
      save: async () => {},
    }),
  ).toThrow(/identity/);
});

test("a failed native check records elapsed time and missing metrics without hiding the original failure", async () => {
  let now = 0;
  const measurements = createWorkflowMeasurements({
    identity,
    now: () => now,
    save: async () => {},
  });
  const failure = new Error("host check failed");
  await expect(
    measurements.measure(
      { stage: "diagnostic", check: "math-inverse", retries: 0 },
      async () => {
        now = 42;
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
  expect(measurements.report().records[0]).toMatchObject({
    stage: "diagnostic",
    check: "math-inverse",
    outcome: "failed",
    durationMs: 42,
    tokens: {
      totalInput: null,
      cachedInput: null,
      freshInput: null,
      output: null,
    },
  });
  expect(measurements.report().records[0]!.unavailable).toContain(
    "Provider usage was not supplied.",
  );
});

test("last-message usage remains an observed snapshot rather than invented cumulative stage totals", async () => {
  const measurements = createWorkflowMeasurements({
    identity,
    save: async () => {},
  });
  await measurements.measure({ stage: "review" }, async (observation) => {
    observation.usage({
      scope: "last-message",
      inputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 80,
      outputTokens: 7,
    });
  });
  const record = measurements.report().records[0]!;
  expect(record.tokens).toEqual({
    totalInput: null,
    cachedInput: null,
    freshInput: null,
    output: null,
  });
  expect(record.observedUsage).toEqual({
    scope: "last-message",
    tokens: { totalInput: 100, cachedInput: 80, freshInput: 20, output: 7 },
  });
  expect(record.unavailable.join(" ")).toMatch(/Stage totals.*last-message/);
  expect(record.retries).toBeNull();
  expect(record.unavailable.join(" ")).toMatch(/Retry count/);
});

test("foreign records cannot be relabeled as another project's measurement history", async () => {
  const first = createWorkflowMeasurements({ identity, save: async () => {} });
  await first.measure({ stage: "implement" }, async () => {});
  const report = first.report();
  const other = { ...identity, project: "consumer-b" };
  report.identity = other;
  expect(() =>
    createWorkflowMeasurements({
      identity: other,
      previous: report,
      save: async () => {},
    }),
  ).toThrow(/identity/);
});
