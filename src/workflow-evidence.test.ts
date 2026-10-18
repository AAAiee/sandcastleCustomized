import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWorkflow,
  WorkflowOperationError,
  type WorkflowCheckpoint,
} from "./workflow.js";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true })),
);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workflow-evidence-"));
  directories.push(directory);
  const file = join(directory, "checkpoint.json");
  const events: string[] = [];
  const inputs = {
    policy: "full-v1",
    dependencies: "lock-v1",
    environment: "host-v1",
  };
  let reviewInputs = "review-v1";
  let candidate = "sha-a";
  const options = {
    project: { id: "evidence-project", config: {} },
    recovery: {},
    evidence: {
      validation: async () => ({ ...inputs }),
      review: async () => reviewInputs,
    },
    operations: {
      selectTask: async () => ({
        id: "task",
        criteria: [{ id: "C1", description: "works" }],
      }),
      implement: async () => {
        events.push("implement");
        return "sha-a";
      },
      currentCandidate: async () => candidate,
      validate: async ({ candidate }: { candidate: string }) => {
        events.push("validate");
        return { candidate, passed: true, evidence: ["Host report passed"] };
      },
      review: async ({ candidate }: { candidate: string }) => {
        events.push("review");
        return {
          candidate,
          approved: true,
          criteria: [
            { id: "C1", satisfied: true, evidence: "Reviewed host report" },
          ],
        };
      },
      deliver: async ({ candidate }: { candidate: string }) => {
        events.push("deliver");
        return { candidate, reference: `receipt-${events.length}` };
      },
      save: async (state: WorkflowCheckpoint) => {
        writeFileSync(file, JSON.stringify(state));
      },
    },
  };
  return {
    options,
    inputs,
    events,
    changeCandidate: () => {
      candidate = "sha-b";
    },
    changeReview: () => {
      reviewInputs = "review-v2";
    },
    load: (): WorkflowCheckpoint => JSON.parse(readFileSync(file, "utf8")),
  };
}

it("revalidates unchanged code after policy changes across a real checkpoint reload", async () => {
  const f = fixture();
  await runWorkflow(f.options);
  f.events.length = 0;
  f.inputs.policy = "full-v2";
  const result = await runWorkflow({ ...f.options, checkpoint: f.load() });
  expect(f.events).toEqual(["validate", "review", "deliver"]);
  expect(result.recovery?.implementationAttempts).toBe(1);
  expect(result.validation).toMatchObject({
    identity: { candidate: "sha-a", policy: "full-v2" },
  });
});

it("observes the real candidate after restart instead of a completed observation cache", async () => {
  const f = fixture();
  await runWorkflow(f.options);
  f.events.length = 0;
  f.changeCandidate();
  await expect(
    runWorkflow({ ...f.options, checkpoint: f.load() }),
  ).rejects.toMatchObject({ code: "gate" });
  expect(f.events).toEqual([]);
});

it("does not reuse failed evidence with an otherwise matching identity", async () => {
  const f = fixture();
  await runWorkflow(f.options);
  const checkpoint = f.load();
  checkpoint.validation = { ...checkpoint.validation!, passed: false };
  f.events.length = 0;
  await runWorkflow({ ...f.options, checkpoint });
  expect(f.events).toEqual(["validate", "review", "deliver"]);
});

it.each(["policy", "dependencies", "environment"] as const)(
  "invalidates the %s component, preserves implementation budget, then reuses matching results",
  async (component) => {
    const f = fixture();
    await runWorkflow(f.options);
    f.inputs[component] = "changed";
    f.events.length = 0;
    await runWorkflow({ ...f.options, checkpoint: f.load() });
    expect(f.events).toEqual(["validate", "review", "deliver"]);
    f.events.length = 0;
    const resumed = await runWorkflow({ ...f.options, checkpoint: f.load() });
    expect(f.events).toEqual([]);
    expect(resumed.recovery?.implementationAttempts).toBe(1);
  },
);

it("refreshes independent review inputs without repeating matching host validation", async () => {
  const f = fixture();
  await runWorkflow(f.options);
  f.changeReview();
  f.events.length = 0;
  await runWorkflow({ ...f.options, checkpoint: f.load() });
  expect(f.events).toEqual(["review", "deliver"]);
});

it("treats legacy evidence without identities as insufficient, without rerunning implementation", async () => {
  const f = fixture();
  await runWorkflow(f.options);
  const checkpoint = f.load();
  delete checkpoint.evidence;
  delete (checkpoint.validation as { identity?: unknown }).identity;
  delete (checkpoint.review as { identity?: unknown }).identity;
  f.events.length = 0;
  await runWorkflow({ ...f.options, checkpoint });
  expect(f.events).toEqual(["validate", "review", "deliver"]);
});

it("requires live input discovery after opting into identity checks", async () => {
  const f = fixture();
  await runWorkflow(f.options);
  await expect(
    runWorkflow({ ...f.options, evidence: undefined, checkpoint: f.load() }),
  ).rejects.toMatchObject({ code: "configuration" });
});

it("cannot deliver after stale evidence is replaced by a failed current host report", async () => {
  const f = fixture();
  await runWorkflow(f.options);
  f.inputs.environment = "different-gpu";
  f.events.length = 0;
  f.options.operations.validate = async ({ candidate }) => {
    f.events.push("validate");
    return {
      candidate,
      passed: false,
      evidence: ["Current host assertion failed"],
    };
  };
  await expect(
    runWorkflow({
      ...f.options,
      recovery: undefined,
      checkpoint: { ...f.load(), recovery: undefined },
    }),
  ).rejects.toMatchObject({ code: "gate" });
  expect(f.events).toEqual(["validate"]);
});

it("does not accept an interrupted delivery with newly changed inputs", async () => {
  const f = fixture();
  f.options.operations.deliver = async () => {
    throw new Error("Lost delivery outcome");
  };
  await expect(runWorkflow(f.options)).rejects.toMatchObject({
    code: "operation",
  });
  f.inputs.policy = "full-v2";
  await expect(
    runWorkflow({ ...f.options, checkpoint: f.load() }),
  ).rejects.toMatchObject({ code: "uncertain" });
});

it("treats a missing validation report as insufficient on reload", async () => {
  const f = fixture();
  await runWorkflow(f.options);
  const checkpoint = f.load();
  delete checkpoint.validation;
  f.events.length = 0;
  await runWorkflow({ ...f.options, checkpoint });
  expect(f.events).toEqual(["validate", "review", "deliver"]);
});

it("does not resume a pending format correction under stale evidence after JSON reload", async () => {
  const f = fixture();
  let offline = true;
  const correctedPolicies: string[] = [];
  const options = {
    ...f.options,
    recovery: {
      wait: async () => {
        if (offline) throw new Error("Restart during correction backoff");
      },
    },
    operations: {
      ...f.options.operations,
      review: async () => {
        f.events.push("review");
        return "Malformed review";
      },
    },
    reviewOutput: {
      correct: async (
        context: import("./workflow.js").WorkflowReviewContext<{}>,
      ) => {
        correctedPolicies.push(context.validation.identity!.policy);
        if (offline)
          throw new WorkflowOperationError(
            "transport",
            "Reviewer disconnected",
          );
        f.events.push("correct");
        return {
          task: "task",
          candidate: "sha-a",
          approved: true,
          criteria: [
            {
              id: "C1",
              satisfied: true,
              evidence: "Reviewed current host result",
            },
          ],
        };
      },
    },
  };
  await expect(runWorkflow(options)).rejects.toThrow(
    "Restart during correction backoff",
  );
  const previousScope = f.load().reviewCorrection!.scope;
  f.inputs.policy = "full-v2";
  f.events.length = 0;
  offline = false;
  const resumed = await runWorkflow({ ...options, checkpoint: f.load() });
  expect(f.events).toEqual(["validate", "review", "correct", "deliver"]);
  expect(correctedPolicies).toEqual(["full-v1", "full-v2"]);
  expect(resumed.reviewCorrection!.scope).not.toBe(previousScope);
  expect(resumed.review?.identity?.validation.policy).toBe("full-v2");
  expect(resumed.recovery?.implementationAttempts).toBe(1);
});
