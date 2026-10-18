import { expect, it } from "vitest";
import { createWorkflowPacket, runWorkflow } from "./workflow.js";

const task = {
  id: "41",
  criteria: [
    { id: "C1", description: "Every camera inverse case runs headlessly" },
    { id: "C2", description: "Debug and Release preserve the failure probe" },
  ],
};

it("gives implementation complete requirements once with explicit entrypoints and commands", () => {
  const prompt = createWorkflowPacket({
    stage: "implement",
    task,
    scope: "Register the shared camera inverse body in the headless target.",
    entrypoints: ["Tests/unit/UnitTests.cpp"],
    commands: ["pwsh Tests/Windows/unit-tests.ps1 -Configuration Debug"],
    references: ["Tests/README.md"],
    branch: "task/41",
  });
  expect(prompt).toContain("Register the shared camera inverse body");
  expect(
    prompt.split("Every camera inverse case runs headlessly"),
  ).toHaveLength(2);
  expect(
    prompt.split("Debug and Release preserve the failure probe"),
  ).toHaveLength(2);
  expect(prompt).toContain("Tests/unit/UnitTests.cpp");
  expect(prompt).toContain(
    "pwsh Tests/Windows/unit-tests.ps1 -Configuration Debug",
  );
  expect(prompt).toContain("Tests/README.md");
  expect(prompt).toContain("task/41");
});

it("limits format correction to the failed representation and exact review contract", () => {
  const prompt = createWorkflowPacket({
    stage: "correction",
    task,
    candidate: "candidate-b",
    problem: "Final JSON is incomplete",
    output: "logs/review-generation-2.txt",
  });
  expect(prompt).toContain("Final JSON is incomplete");
  expect(prompt).toContain("logs/review-generation-2.txt");
  expect(prompt).toContain("candidate-b");
  expect(prompt).toContain('"C1"');
  expect(prompt).not.toContain("Every camera inverse case runs headlessly");
  expect(prompt).toContain(
    "Preserve the actual findings and approval/rejection decision",
  );
});

it("gives independent review complete criteria and exact candidate diff/evidence without bulk reports", () => {
  const prompt = createWorkflowPacket({
    stage: "review",
    task,
    base: "base-a",
    candidate: "candidate-b",
    changedPaths: ["Tests/unit/UnitTests.cpp"],
    diffCommand: "git diff base-a candidate-b --",
    validation: {
      candidate: "candidate-b",
      passed: true,
      evidence: ["logs/validation-2.json"],
    },
    references: ["Tests/README.md"],
  });
  const packet = JSON.parse(prompt);
  expect(packet).toMatchObject({
    task,
    base: "base-a",
    candidate: "candidate-b",
    changedPaths: ["Tests/unit/UnitTests.cpp"],
    diffCommand: "git diff base-a candidate-b --",
    validation: { passed: true, evidence: ["logs/validation-2.json"] },
  });
  expect(
    prompt.split("Every camera inverse case runs headlessly"),
  ).toHaveLength(2);
  expect(prompt).not.toContain("implementation");
});

it("passes exact failed checks and evidence to repair without unrelated validation history", async () => {
  let implementation = 0;
  let repaired: unknown;
  await runWorkflow({
    project: { id: "camera-project", config: {} },
    recovery: {},
    operations: {
      selectTask: async () => task,
      implement: async (context) => {
        if (++implementation === 2) {
          repaired = JSON.parse(
            createWorkflowPacket({
              stage: "repair",
              task,
              requirements: ".sandcastle/context/requirements.json",
              repair: context.repair!,
              references: ["logs/failed-check.txt"],
            }),
          );
        }
        return "candidate-a";
      },
      currentCandidate: async () => "candidate-a",
      validate: async () => ({
        candidate: "candidate-a",
        passed: implementation > 1,
        evidence: ["logs/all-checks.json"],
        failures: [
          {
            check: "Debug/camera-inverse",
            diagnostic: "Expected identity matrix",
            evidence: ["logs/failed-check.txt"],
          },
        ],
      }),
      review: async () => ({
        candidate: "candidate-a",
        approved: true,
        criteria: task.criteria.map(({ id }) => ({
          id,
          satisfied: true,
          evidence: "Independently inspected",
        })),
      }),
      deliver: async () => ({
        candidate: "candidate-a",
        reference: "local.json",
      }),
      save: async () => {},
    },
  });
  expect(repaired).toMatchObject({
    stage: "repair",
    task: "41",
    requirements: ".sandcastle/context/requirements.json",
    failures: [
      {
        check: "Debug/camera-inverse",
        diagnostic: "Expected identity matrix",
        evidence: ["logs/failed-check.txt"],
      },
    ],
  });
  expect(JSON.stringify(repaired)).not.toContain(
    "Every camera inverse case runs headlessly",
  );
  expect(JSON.stringify(repaired)).not.toContain("logs/all-checks.json");
});
