import { expect, it } from "vitest";
import {
  runWorkflow,
  WorkflowOperationError,
  type WorkflowCheckpoint,
} from "./workflow.js";

function fixture() {
  const events: string[] = [];
  let checkpoint: WorkflowCheckpoint;
  const options = {
    project: { id: "diagnostic-consumer", config: {} },
    recovery: { wait: async () => {} },
    diagnostics: async ({ candidate }: { candidate: string }) => {
      events.push("diagnose");
      return { candidate, passed: true, evidence: ["incremental-debug.json"] };
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
      currentCandidate: async () => "sha-a",
      validate: async ({ candidate }: { candidate: string }) => {
        events.push("full-acceptance");
        return {
          candidate,
          passed: true,
          evidence: ["debug-release-rebuild.json"],
        };
      },
      review: async ({ candidate }: { candidate: string }) => ({
        candidate,
        approved: true,
        criteria: [
          { id: "C1", satisfied: true, evidence: "independent review" },
        ],
      }),
      deliver: async ({ candidate }: { candidate: string }) => {
        events.push("deliver");
        return { candidate, reference: "local" };
      },
      save: async (value: WorkflowCheckpoint) => {
        checkpoint = JSON.parse(JSON.stringify(value));
      },
    },
  };
  return { options, events, load: () => checkpoint! };
}

it("runs project diagnostics before full acceptance and retains the separate final gate", async () => {
  const f = fixture();
  const result = await runWorkflow(f.options);
  expect(f.events).toEqual([
    "implement",
    "diagnose",
    "full-acceptance",
    "deliver",
  ]);
  expect(result.phase).toBe("ready");
});

it("runs diagnostics and full acceptance when enabling diagnostics on an already ready candidate", async () => {
  const f = fixture();
  await runWorkflow({ ...f.options, diagnostics: undefined });
  f.events.length = 0;
  await runWorkflow({ ...f.options, checkpoint: f.load() });
  expect(f.events).toEqual(["diagnose", "full-acceptance", "deliver"]);
});

it("failed diagnostics consume bounded repairs without invoking acceptance or delivery", async () => {
  const f = fixture();
  f.options.diagnostics = async ({ candidate }) => ({
    candidate,
    passed: false,
    evidence: ["build-Debug: compiler.log"],
  });
  await expect(runWorkflow(f.options)).rejects.toMatchObject({
    code: "exhausted",
    checkpoint: { repair: { phase: "diagnose" } },
  });
  expect(f.events).toEqual(["implement", "implement", "implement"]);
  expect(f.load().recovery?.implementationAttempts).toBe(3);
});

it("diagnostic transport retries retain their budget over JSON reload and never become full acceptance", async () => {
  const f = fixture();
  f.options.diagnostics = async () => {
    throw new WorkflowOperationError(
      "transport",
      "Host connection interrupted",
    );
  };
  await expect(runWorkflow(f.options)).rejects.toMatchObject({
    code: "exhausted",
  });
  const saved = f.load();
  await expect(
    runWorkflow({ ...f.options, checkpoint: saved }),
  ).rejects.toMatchObject({ code: "exhausted" });
  await expect(
    runWorkflow({ ...f.options, checkpoint: saved, diagnostics: undefined }),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(f.events).toEqual(["implement"]);
});

it("a passing diagnostic cannot authorize delivery after failed final acceptance", async () => {
  const f = fixture();
  f.options.operations.validate = async ({ candidate }) => ({
    candidate,
    passed: false,
    evidence: ["Release UI check failed: private-desktop.log"],
  });
  await expect(runWorkflow(f.options)).rejects.toMatchObject({
    code: "exhausted",
  });
  expect(f.events).not.toContain("deliver");
});

it("policy changes rerun diagnostics and full acceptance without a new implementation", async () => {
  const f = fixture();
  let policy = "policy-v1";
  const evidence = {
    validation: async () => ({
      policy,
      dependencies: "deps",
      environment: "host",
    }),
    review: async () => "review",
  };
  await runWorkflow({ ...f.options, evidence });
  f.events.length = 0;
  policy = "policy-v2";
  await runWorkflow({ ...f.options, evidence, checkpoint: f.load() });
  expect(f.events).toEqual(["diagnose", "full-acceptance", "deliver"]);
});

it("missing saved diagnostic identity cannot authorize reuse of otherwise matching final evidence", async () => {
  const f = fixture();
  const evidence = {
    validation: async () => ({
      policy: "full",
      dependencies: "pins",
      environment: "host",
    }),
    review: async () => "review",
  };
  await runWorkflow({ ...f.options, evidence });
  const saved = f.load();
  saved.diagnostic = {
    candidate: saved.candidate!,
    passed: true,
    evidence: saved.diagnostic!.evidence,
  };
  f.events.length = 0;
  await runWorkflow({ ...f.options, evidence, checkpoint: saved });
  expect(f.events).toEqual(["diagnose", "full-acceptance", "deliver"]);
});
