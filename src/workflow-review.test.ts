import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  extractWorkflowReview,
  runWorkflow,
  WorkflowOperationError,
  type WorkflowCheckpoint,
  type WorkflowOperations,
} from "./workflow.js";

const task = { id: "task-39", criteria: [{ id: "C1", description: "Works" }] };
const approved = {
  task: task.id,
  candidate: "candidate-a",
  approved: true,
  criteria: [
    { id: "C1", satisfied: true, evidence: "Inspected host evidence" },
  ],
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const path = realpathSync(directory);
    expect(
      path.startsWith(realpathSync(tmpdir()) + sep) &&
        basename(path).startsWith("workflow-review-"),
    ).toBe(true);
    rmSync(path, { recursive: true, force: true });
  }
});

it("extracts the final tagged review with fenced strict JSON and exact task binding", () => {
  expect(
    extractWorkflowReview(
      `Draft ignored\n<review>\n\`\`\`json\n${JSON.stringify(approved)}\n\`\`\`\n</review>`,
      { task, candidate: "candidate-a" },
    ),
  ).toEqual(approved);
});

it("extracts a final fenced review after explanation without requesting correction", () => {
  expect(
    extractWorkflowReview(
      `Inspected the host log.\n\`\`\`json\n${JSON.stringify(approved)}\n\`\`\``,
      { task, candidate: "candidate-a" },
    ),
  ).toEqual(approved);
});

it("accepts literal markup in the evidence of a complete JSON review", () => {
  const value = {
    ...approved,
    criteria: [
      {
        id: "C1",
        satisfied: true,
        evidence: "Inspected the <review> and ```json serialization",
      },
    ],
  };
  expect(
    extractWorkflowReview(JSON.stringify(value), {
      task,
      candidate: "candidate-a",
    }),
  ).toEqual(value);
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workflow-review-"));
  directories.push(directory);
  const file = join(directory, "checkpoint.json");
  const effects: string[] = [];
  const project = { id: "review-consumer", config: {} };
  const operations: WorkflowOperations<{}> = {
    selectTask: async () => task,
    implement: async () => {
      effects.push("implement");
      return "candidate-a";
    },
    currentCandidate: async () => "candidate-a",
    validate: async ({ candidate }) => {
      effects.push("validate");
      return { candidate, passed: true, evidence: ["host.log"] };
    },
    review: async () => {
      effects.push("review");
      return "Malformed final review";
    },
    deliver: async ({ candidate }) => {
      effects.push("deliver");
      return { candidate, reference: "handoff" };
    },
    save: async (state) => {
      writeFileSync(file, JSON.stringify(state));
    },
  };
  return {
    project,
    operations,
    effects,
    load: () => JSON.parse(readFileSync(file, "utf8")) as WorkflowCheckpoint,
  };
}

it("corrects malformed review once while preserving the independently validated candidate", async () => {
  const f = fixture();
  const result = await runWorkflow({
    ...f,
    recovery: {},
    reviewOutput: {
      correct: async (context) => {
        f.effects.push("correction");
        expect(context.output).toBe("Malformed final review");
        expect(f.load().reviewCorrection?.consumed).toBe(true);
        return JSON.stringify(approved);
      },
    },
  });
  expect(result.phase).toBe("ready");
  expect(f.effects).toEqual([
    "implement",
    "validate",
    "review",
    "correction",
    "deliver",
  ]);
});

it("retains exhausted correction after JSON checkpoint reload even if the next callback would approve", async () => {
  const f = fixture();
  let corrections = 0;
  const options = {
    ...f,
    reviewOutput: {
      correct: async () => {
        corrections++;
        return "Still malformed";
      },
    },
  };
  await expect(runWorkflow(options)).rejects.toMatchObject({ code: "format" });
  await expect(
    runWorkflow({
      ...options,
      checkpoint: f.load(),
      reviewOutput: {
        correct: async () => {
          corrections++;
          return approved;
        },
      },
    }),
  ).rejects.toMatchObject({ code: "format" });
  expect(corrections).toBe(1);
  expect(f.effects).toEqual(["implement", "validate", "review"]);
});

it("persists correction transport attempts independently and resumes the same logical request", async () => {
  const f = fixture();
  let transports = 0;
  const correct = async () => {
    transports++;
    if (transports < 3)
      throw new WorkflowOperationError(
        "transport",
        "Review connection unavailable",
      );
    return approved;
  };
  await expect(
    runWorkflow({
      ...f,
      reviewOutput: { correct },
      recovery: {
        wait: async () => {
          throw Error("Host process stopped");
        },
      },
    }),
  ).rejects.toThrow("Host process stopped");
  const result = await runWorkflow({
    ...f,
    checkpoint: f.load(),
    reviewOutput: { correct },
    recovery: { wait: async () => {} },
  });
  expect(result.phase).toBe("ready");
  expect(transports).toBe(3);
  expect(
    Object.entries(result.recovery!.operations).filter(([key]) =>
      key.startsWith("review-correction:"),
    ),
  ).toHaveLength(1);
  expect(f.effects).toEqual(["implement", "validate", "review", "deliver"]);
});

it("routes a valid substantive rejection to code repair without a format correction", async () => {
  const f = fixture();
  let reviews = 0;
  f.operations.review = async () => {
    reviews++;
    return JSON.stringify(
      reviews === 1
        ? {
            ...approved,
            approved: false,
            criteria: [
              {
                id: "C1",
                satisfied: false,
                evidence: "The actual behavior is incorrect",
              },
            ],
          }
        : approved,
    );
  };
  const result = await runWorkflow({
    ...f,
    reviewOutput: {
      correct: async () => {
        throw Error("Rejection must not become format correction");
      },
    },
  });
  expect(result.phase).toBe("ready");
  expect(result.recovery?.implementationAttempts).toBe(2);
  expect(f.effects).toEqual([
    "implement",
    "validate",
    "implement",
    "validate",
    "deliver",
  ]);
});

it("extracts a usable independent review before spending the correction request", async () => {
  const f = fixture();
  f.operations.review = async () =>
    `Explanation\n\`\`\`json\n${JSON.stringify(approved)}\n\`\`\``;
  const result = await runWorkflow({
    ...f,
    reviewOutput: {
      correct: async () => {
        throw Error("No correction needed");
      },
    },
  });
  expect(result.phase).toBe("ready");
  expect(result.reviewCorrection).toBeUndefined();
});

it("never grants a new correction after its three transport attempts are exhausted", async () => {
  const f = fixture();
  let requests = 0;
  const options = {
    ...f,
    recovery: { wait: async () => {} },
    reviewOutput: {
      correct: async () => {
        requests++;
        throw new WorkflowOperationError("transport", "Disconnected");
      },
    },
  };
  await expect(runWorkflow(options)).rejects.toMatchObject({
    code: "exhausted",
  });
  await expect(
    runWorkflow({ ...options, checkpoint: f.load() }),
  ).rejects.toMatchObject({ code: "exhausted" });
  expect(requests).toBe(3);
  expect(f.effects).toEqual(["implement", "validate", "review"]);
});

it("keeps review transport and correction transport budgets independent", async () => {
  const f = fixture();
  let reviews = 0;
  let corrections = 0;
  f.operations.review = async () => {
    if (++reviews < 3)
      throw new WorkflowOperationError("transport", "Review disconnected");
    return "Malformed independent review";
  };
  const result = await runWorkflow({
    ...f,
    recovery: { wait: async () => {} },
    reviewOutput: {
      correct: async () => {
        if (++corrections < 3)
          throw new WorkflowOperationError(
            "transport",
            "Correction disconnected",
          );
        return approved;
      },
    },
  });
  expect(result.phase).toBe("ready");
  expect(result.recovery?.operations["review/1"]?.attempts).toBe(3);
  expect(
    Object.entries(result.recovery!.operations).find(([key]) =>
      key.startsWith("review-correction:"),
    )?.[1].attempts,
  ).toBe(3);
  expect(f.effects).toEqual(["implement", "validate", "deliver"]);
});

it("refuses to omit the saved strict-review policy on resume", async () => {
  const f = fixture();
  await expect(
    runWorkflow({
      ...f,
      reviewOutput: { correct: async () => "Still malformed" },
    }),
  ).rejects.toMatchObject({ code: "format" });
  await expect(
    runWorkflow({ ...f, checkpoint: f.load() }),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(f.effects).toEqual(["implement", "validate", "review"]);
});

it.each([
  { ...approved, task: "other-task" },
  { ...approved, candidate: "other-candidate" },
  { ...approved, criteria: [] },
  { ...approved, criteria: [...approved.criteria, ...approved.criteria] },
  {
    ...approved,
    criteria: [{ id: "other", satisfied: true, evidence: "Unrelated" }],
  },
  { ...approved, criteria: [{ id: "C1", satisfied: true, evidence: " " }] },
])(
  "refuses unrelated or incomplete reviews instead of authorizing delivery: %j",
  (value) => {
    expect(() =>
      extractWorkflowReview(JSON.stringify(value), {
        task,
        candidate: "candidate-a",
      }),
    ).toThrow(WorkflowOperationError);
  },
);

it.each([
  `<review>${JSON.stringify(approved)}</review>\n<review>{broken`,
  `\`\`\`json\n${JSON.stringify(approved)}\n\`\`\`\n\`\`\`json\n{broken`,
  `${JSON.stringify(approved)}\n{broken`,
])(
  "never falls back to an earlier approval when the final representation is malformed: %s",
  (output) => {
    expect(() =>
      extractWorkflowReview(output, { task, candidate: "candidate-a" }),
    ).toThrow(WorkflowOperationError);
  },
);
