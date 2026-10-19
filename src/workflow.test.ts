import { afterEach, describe, expect, it } from "vitest";
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
  runWorkflow,
  type WorkflowCheckpoint,
  type WorkflowOperations,
  type WorkflowReview,
} from "./workflow.js";

const task = {
  id: "independent-task",
  criteria: [{ id: "behavior", description: "The requested behavior works" }],
};
const project = {
  id: "independent-project",
  config: { branch: "task/independent", repository: "example/independent" },
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-workflow-"));
  cleanups.push(() => {
    const path = realpathSync(directory);
    expect(path.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    expect(basename(path).startsWith("sandcastle-workflow-")).toBe(true);
    rmSync(path, { recursive: true, force: true });
  });
  const path = join(directory, "checkpoint.json");
  const calls: string[] = [];
  let candidate = "candidate-a";
  const operations: WorkflowOperations<typeof project.config> = {
    selectTask: async (input) => {
      expect(input).toEqual(project);
      calls.push("select");
      return task;
    },
    implement: async ({ project: input, task: selected }) => {
      expect(input).toEqual(project);
      expect(selected).toEqual(task);
      calls.push("implement");
      return candidate;
    },
    currentCandidate: async () => candidate,
    validate: async ({ candidate: id }) => {
      calls.push("validate");
      return {
        candidate: id,
        passed: true,
        evidence: ["Behavior check passed"],
      };
    },
    review: async ({ candidate: id, validation }) => {
      expect(validation.passed).toBe(true);
      calls.push("review");
      return {
        candidate: id,
        approved: true,
        criteria: [
          {
            id: "behavior",
            satisfied: true,
            evidence: "Independent review found the check meaningful",
          },
        ],
      };
    },
    deliver: async ({ candidate: id, review }) => {
      expect(review.approved).toBe(true);
      calls.push("deliver");
      return { candidate: id, reference: "local-handoff.json" };
    },
    save: async (checkpoint) => {
      writeFileSync(path, JSON.stringify(checkpoint));
    },
  };
  return {
    operations,
    calls,
    load: () => JSON.parse(readFileSync(path, "utf8")) as WorkflowCheckpoint,
    changeCandidate: () => {
      candidate = "candidate-b";
    },
  };
}

describe("public single-task workflow", () => {
  it("completes an independent consumer task through the supplied gates and local delivery", async () => {
    const f = fixture();
    const result = await runWorkflow({ project, operations: f.operations });
    expect(f.calls).toEqual([
      "select",
      "implement",
      "validate",
      "review",
      "deliver",
    ]);
    expect(result.phase).toBe("ready");
    expect(result.delivery).toEqual({
      candidate: "candidate-a",
      reference: "local-handoff.json",
    });
    expect(f.load()).toEqual(result);
    f.calls.length = 0;
    await runWorkflow({
      project,
      operations: f.operations,
      checkpoint: f.load(),
    });
    expect(f.calls).toEqual([]);
  });

  it("stops idle when the consumer has no eligible task", async () => {
    const f = fixture();
    f.operations.selectTask = async () => null;
    expect(
      (await runWorkflow({ project, operations: f.operations })).phase,
    ).toBe("idle");
    expect(f.calls).toEqual([]);
  });

  it("prevents review and delivery when validation fails", async () => {
    const f = fixture();
    f.operations.validate = async ({ candidate }) => ({
      candidate,
      passed: false,
      evidence: ["Behavior assertion failed"],
    });
    await expect(
      runWorkflow({ project, operations: f.operations }),
    ).rejects.toMatchObject({ code: "gate" });
    expect(f.calls).toEqual(["select", "implement"]);
    expect(f.load().phase).toBe("validate");
  });

  it.each([
    {
      name: "validation for another candidate",
      validation: { candidate: "other", passed: true, evidence: ["passed"] },
    },
    {
      name: "validation with no evidence",
      validation: { candidate: "candidate-a", passed: true, evidence: [] },
    },
  ])("rejects $name", async ({ validation }) => {
    const f = fixture();
    f.operations.validate = async () => validation;
    await expect(
      runWorkflow({ project, operations: f.operations }),
    ).rejects.toMatchObject({ code: "gate" });
    expect(f.calls).not.toContain("review");
    expect(f.calls).not.toContain("deliver");
  });

  it.each([
    {
      candidate: "candidate-a",
      approved: false,
      criteria: [
        {
          id: "behavior",
          satisfied: false,
          evidence: "Required behavior is missing",
        },
      ],
    },
    {
      candidate: "other",
      approved: true,
      criteria: [{ id: "behavior", satisfied: true, evidence: "passed" }],
    },
    { candidate: "candidate-a", approved: true, criteria: [] },
    {
      candidate: "candidate-a",
      approved: true,
      criteria: [{ id: "behavior", satisfied: true, evidence: "" }],
    },
    {
      candidate: "candidate-a",
      approved: true,
      criteria: [
        { id: "behavior", satisfied: true, evidence: "passed" },
        { id: "behavior", satisfied: true, evidence: "duplicate" },
      ],
    },
  ] satisfies WorkflowReview[])(
    "requires complete passing review for the exact candidate: %j",
    async (review) => {
      const f = fixture();
      f.operations.review = async () => review;
      await expect(
        runWorkflow({ project, operations: f.operations }),
      ).rejects.toMatchObject({ code: "gate" });
      expect(f.calls).not.toContain("deliver");
      expect(f.load().phase).toBe("review");
    },
  );

  it("reloads a failed read-only review without repeating implementation or validation", async () => {
    const f = fixture();
    const review = f.operations.review;
    const originalError = new Error("Unfamiliar review interruption 739");
    f.operations.review = async () => {
      f.calls.push("review-failed");
      throw originalError;
    };
    await expect(
      runWorkflow({ project, operations: f.operations }),
    ).rejects.toMatchObject({ code: "operation", cause: originalError });
    expect(f.load().phase).toBe("review");
    f.operations.review = review;
    f.calls.length = 0;
    expect(
      (
        await runWorkflow({
          project,
          operations: f.operations,
          checkpoint: f.load(),
        })
      ).phase,
    ).toBe("ready");
    expect(f.calls).toEqual(["review", "deliver"]);
  });

  it("rejects a changed candidate on review resume instead of trusting earlier evidence", async () => {
    const f = fixture();
    f.operations.review = async () => {
      throw new Error("pause");
    };
    await expect(
      runWorkflow({ project, operations: f.operations }),
    ).rejects.toThrow("pause");
    f.changeCandidate();
    f.calls.length = 0;
    await expect(
      runWorkflow({ project, operations: f.operations, checkpoint: f.load() }),
    ).rejects.toMatchObject({ code: "gate" });
    expect(f.calls).toEqual([]);
  });

  it.each(["implement", "deliver"] as const)(
    "preserves an uncertain %s operation and refuses automatic replay",
    async (phase) => {
      const f = fixture();
      let effects = 0;
      f.operations[phase] = async () => {
        effects++;
        throw new Error("Unknown error after a possible side effect");
      };
      await expect(
        runWorkflow({ project, operations: f.operations }),
      ).rejects.toMatchObject({ code: "operation" });
      expect(f.load().inFlight).toBe(phase);
      await expect(
        runWorkflow({
          project,
          operations: f.operations,
          checkpoint: f.load(),
        }),
      ).rejects.toMatchObject({ code: "uncertain" });
      expect(effects).toBe(1);
    },
  );

  it("cannot start implementation when its intent cannot be saved", async () => {
    const f = fixture();
    const save = f.operations.save;
    f.operations.save = async (state) => {
      if (state.inFlight === "implement") throw new Error("disk unavailable");
      await save(state);
    };
    await expect(
      runWorkflow({ project, operations: f.operations }),
    ).rejects.toMatchObject({ code: "persistence" });
    expect(f.calls).toEqual(["select"]);
  });

  it("refuses another project's checkpoint before calling project operations", async () => {
    const f = fixture();
    await expect(
      runWorkflow({
        project,
        operations: f.operations,
        checkpoint: { version: 1, project: "other", phase: "select" },
      }),
    ).rejects.toMatchObject({ code: "invalid-checkpoint" });
    expect(f.calls).toEqual([]);
  });

  it("honors cancellation before selection", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("user paused"));
    await expect(
      runWorkflow({
        project,
        operations: f.operations,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.calls).toEqual([]);
  });

  it("checks cancellation again after saving implementation intent", async () => {
    const f = fixture();
    const save = f.operations.save;
    const controller = new AbortController();
    f.operations.save = async (state) => {
      await save(state);
      if (state.inFlight === "implement")
        controller.abort(new Error("paused during persistence"));
    };
    await expect(
      runWorkflow({
        project,
        operations: f.operations,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.calls).toEqual(["select"]);
  });
});
