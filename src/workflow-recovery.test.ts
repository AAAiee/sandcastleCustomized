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
  runWorkflow,
  WorkflowOperationError,
  type WorkflowCheckpoint,
  type WorkflowOperations,
} from "./workflow.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-recovery-"));
  cleanups.push(() => {
    const path = realpathSync(directory);
    expect(path.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    expect(basename(path).startsWith("sandcastle-recovery-")).toBe(true);
    rmSync(path, { recursive: true, force: true });
  });
  const file = join(directory, "checkpoint.json");
  const calls: string[] = [];
  const project = { id: "recovery-consumer", config: {} };
  let candidate = "candidate-0";
  let commits = 0;
  const operations: WorkflowOperations<{}> = {
    selectTask: async () => ({
      id: "task",
      criteria: [{ id: "behavior", description: "Works" }],
    }),
    implement: async () => {
      calls.push("implement");
      candidate = `candidate-${++commits}`;
      return candidate;
    },
    currentCandidate: async () => candidate,
    validate: async ({ candidate }) => {
      calls.push("validate");
      return { candidate, passed: true, evidence: ["host-check.log"] };
    },
    review: async ({ candidate }) => {
      calls.push("review");
      return {
        candidate,
        approved: true,
        criteria: [
          { id: "behavior", satisfied: true, evidence: "Inspected behavior" },
        ],
      };
    },
    deliver: async ({ candidate }) => {
      calls.push("deliver");
      return { candidate, reference: "local-receipt" };
    },
    save: async (state) => {
      writeFileSync(file, JSON.stringify(state));
    },
  };
  return {
    operations,
    project,
    calls,
    load: () => JSON.parse(readFileSync(file, "utf8")) as WorkflowCheckpoint,
  };
}

it("retries a review transport interruption without repeating passing code or validation", async () => {
  const f = fixture();
  const review = f.operations.review;
  let disconnected = true;
  f.operations.review = async (context) => {
    if (disconnected) {
      disconnected = false;
      f.calls.push("review-transport");
      throw new WorkflowOperationError("transport", "Connection lost");
    }
    return review(context);
  };
  const delays: number[] = [];
  const result = await runWorkflow({
    ...f,
    recovery: {
      now: () => 1000,
      wait: async (ms) => {
        delays.push(ms);
      },
    },
  });
  expect(result.phase).toBe("ready");
  expect(f.calls).toEqual([
    "implement",
    "validate",
    "review-transport",
    "review",
    "deliver",
  ]);
  expect(delays).toEqual([500]);
  expect(result.recovery?.implementationAttempts).toBe(1);
});

it("reloads consumed transport attempts and persisted backoff, then remains exhausted across restarts", async () => {
  const f = fixture();
  f.operations.review = async () => {
    f.calls.push("review-transport");
    throw new WorkflowOperationError("transport", "Connection lost");
  };
  await expect(
    runWorkflow({
      ...f,
      recovery: {
        now: () => 1000,
        wait: async () => {
          throw Error("Process stopped during backoff");
        },
      },
    }),
  ).rejects.toThrow("Process stopped");
  expect(f.load().recovery?.operations["review/1"]).toMatchObject({
    attempts: 1,
    status: "interrupted",
    nextAttemptAt: 1500,
  });
  const delays: number[] = [];
  const resume = () =>
    runWorkflow({
      ...f,
      checkpoint: f.load(),
      recovery: {
        now: () => 1200,
        wait: async (ms) => {
          delays.push(ms);
        },
      },
    });
  await expect(resume()).rejects.toMatchObject({ code: "exhausted" });
  expect(delays).toEqual([300, 1000]);
  expect(f.load().recovery?.operations["review/1"]?.attempts).toBe(3);
  const before = [...f.calls];
  await expect(resume()).rejects.toMatchObject({ code: "exhausted" });
  expect(f.calls).toEqual(before);
  expect(f.calls.filter((call) => call === "implement")).toHaveLength(1);
  expect(f.calls.filter((call) => call === "validate")).toHaveLength(1);
});

it("cannot bypass an exhausted durable budget by omitting recovery on an ordinary retry", async () => {
  const f = fixture();
  f.operations.review = async () => {
    throw new WorkflowOperationError("transport", "Connection lost");
  };
  await expect(
    runWorkflow({ ...f, recovery: { wait: async () => {} } }),
  ).rejects.toMatchObject({ code: "exhausted" });
  const review = f.operations.review;
  let calls = 0;
  f.operations.review = async (context) => {
    calls++;
    return review(context);
  };
  await expect(
    runWorkflow({ ...f, checkpoint: f.load() }),
  ).rejects.toMatchObject({ code: "exhausted" });
  expect(calls).toBe(0);
});

it("repairs substantive validation failures with three total implementations and fresh acceptance", async () => {
  const f = fixture();
  const feedback: unknown[] = [];
  const implement = f.operations.implement;
  f.operations.implement = async (context) => {
    feedback.push(context.repair);
    return implement(context);
  };
  f.operations.validate = async ({ candidate }) => {
    f.calls.push("validate-rejected");
    return {
      candidate,
      passed: false,
      evidence: ["unit assertion: expected 42, received 21"],
    };
  };
  await expect(runWorkflow({ ...f, recovery: {} })).rejects.toMatchObject({
    code: "exhausted",
  });
  expect(f.calls).toEqual([
    "implement",
    "validate-rejected",
    "implement",
    "validate-rejected",
    "implement",
    "validate-rejected",
  ]);
  expect(feedback[1]).toMatchObject({
    phase: "validate",
    message: expect.stringContaining("expected 42"),
  });
  expect(f.load().recovery?.implementationAttempts).toBe(3);
  await expect(
    runWorkflow({ ...f, checkpoint: f.load(), recovery: {} }),
  ).rejects.toMatchObject({ code: "exhausted" });
  expect(f.calls.filter((call) => call === "implement")).toHaveLength(3);
});

it("routes a substantive review rejection to repair rather than treating it as transport or format", async () => {
  const f = fixture();
  const review = f.operations.review;
  let rejected = false;
  f.operations.review = async (context) => {
    if (!rejected) {
      rejected = true;
      f.calls.push("review-rejected");
      return {
        candidate: context.candidate,
        approved: false,
        criteria: [
          {
            id: "behavior",
            satisfied: false,
            evidence: "Negative input is unhandled",
          },
        ],
      };
    }
    return review(context);
  };
  const result = await runWorkflow({ ...f, recovery: {} });
  expect(result.phase).toBe("ready");
  expect(result.recovery?.implementationAttempts).toBe(2);
  expect(f.calls).toEqual([
    "implement",
    "validate",
    "review-rejected",
    "implement",
    "validate",
    "review",
    "deliver",
  ]);
});

it("reconciles a lost delivery response as completed without publishing twice, including after restart", async () => {
  const f = fixture();
  let publication: unknown;
  f.operations.deliver = async ({ candidate }) => {
    f.calls.push("publish");
    publication = { candidate, reference: "remote-receipt-73" };
    throw new WorkflowOperationError(
      "transport",
      "Lost response after publication",
    );
  };
  await expect(runWorkflow({ ...f, recovery: {} })).rejects.toMatchObject({
    code: "uncertain",
  });
  expect(f.load().phase).toBe("deliver");
  expect(f.load().delivery).toBeUndefined();
  const result = await runWorkflow({
    ...f,
    checkpoint: f.load(),
    recovery: {
      reconcile: async (context) => {
        expect(context.phase).toBe("deliver");
        expect(context.attempt.transport).toBe(1);
        return { status: "completed", value: publication };
      },
    },
  });
  expect(result.phase).toBe("ready");
  expect(result.delivery?.reference).toBe("remote-receipt-73");
  expect(f.calls).toEqual(["implement", "validate", "review", "publish"]);
});

it.each(["permanent", "format"] as const)(
  "keeps %s failures distinct from repair and persists the stop across restart",
  async (kind) => {
    const f = fixture();
    f.operations.review = async () => {
      f.calls.push(kind);
      throw new WorkflowOperationError(kind, "Requires attention");
    };
    await expect(runWorkflow({ ...f, recovery: {} })).rejects.toMatchObject({
      code: kind,
    });
    const before = [...f.calls];
    await expect(
      runWorkflow({ ...f, checkpoint: f.load() }),
    ).rejects.toMatchObject({ code: kind });
    expect(f.calls).toEqual(before);
    expect(f.load().recovery?.implementationAttempts).toBe(1);
    expect(f.load().recovery?.operations["review/1"]?.failure?.kind).toBe(kind);
  },
);

it("refuses a legacy mid-task checkpoint with unknown consumed budgets", async () => {
  const f = fixture();
  f.operations.review = async () => {
    throw Error("legacy interruption");
  };
  await expect(runWorkflow(f)).rejects.toThrow("legacy interruption");
  const before = [...f.calls];
  await expect(
    runWorkflow({ ...f, checkpoint: f.load(), recovery: {} }),
  ).rejects.toMatchObject({ code: "invalid-checkpoint" });
  expect(f.calls).toEqual(before);
});

it("bounds unavailable reconciliation reads across checkpoints and never repeats the uncertain write", async () => {
  const f = fixture();
  f.operations.deliver = async () => {
    f.calls.push("publish");
    throw new WorkflowOperationError("transport", "Write response unavailable");
  };
  let reads = 0;
  const recovery = {
    wait: async () => {},
    reconcile: async () => {
      reads++;
      throw new WorkflowOperationError(
        "transport",
        "Reconciliation read unavailable",
      );
    },
  };
  await expect(runWorkflow({ ...f, recovery })).rejects.toMatchObject({
    code: "exhausted",
  });
  expect(reads).toBe(3);
  await expect(
    runWorkflow({ ...f, recovery, checkpoint: f.load() }),
  ).rejects.toMatchObject({ code: "exhausted" });
  expect(reads).toBe(3);
  expect(f.calls).toEqual(["implement", "validate", "review", "publish"]);
  expect(f.load().delivery).toBeUndefined();
});

it("retries a candidate observation transport failure without trusting its previous successful observation", async () => {
  const f = fixture();
  const current = f.operations.currentCandidate;
  let disconnected = true;
  f.operations.currentCandidate = async (context) => {
    if (disconnected) {
      disconnected = false;
      throw new WorkflowOperationError("transport", "Git service unavailable");
    }
    return current(context);
  };
  const result = await runWorkflow({
    ...f,
    recovery: { wait: async () => {} },
  });
  expect(result.phase).toBe("ready");
  f.operations.currentCandidate = async () => "another-candidate";
  await expect(
    runWorkflow({ ...f, checkpoint: f.load() }),
  ).rejects.toMatchObject({ code: "gate" });
  expect(f.calls).toEqual(["implement", "validate", "review", "deliver"]);
});

it.each(["selectTask", "implement", "validate", "deliver"] as const)(
  "bounds %s transport attempts without consuming extra code attempts or claiming completion",
  async (operation) => {
    const f = fixture();
    let attempts = 0;
    f.operations[operation] = async () => {
      attempts++;
      throw new WorkflowOperationError(
        "transport",
        "Unavailable before effect",
      );
    };
    const recovery = {
      wait: async () => {},
      reconcile: async () => ({ status: "not-started" as const }),
    };
    await expect(runWorkflow({ ...f, recovery })).rejects.toMatchObject({
      code: "exhausted",
    });
    await expect(
      runWorkflow({ ...f, recovery, checkpoint: f.load() }),
    ).rejects.toMatchObject({ code: "exhausted" });
    expect(attempts).toBe(3);
    expect(f.load().recovery?.implementationAttempts).toBe(
      operation === "selectTask" ? 0 : 1,
    );
    expect(f.load().phase).not.toBe("ready");
    expect(f.load().delivery).toBeUndefined();
  },
);

it("reconciles process interruption after a successful effect but before its result is durably saved", async () => {
  const f = fixture();
  const save = f.operations.save;
  let crash = true;
  f.operations.save = async (state) => {
    if (
      crash &&
      state.recovery?.operations["deliver/1"]?.status === "completed"
    ) {
      crash = false;
      throw Error("process ended before durable receipt");
    }
    return save(state);
  };
  await expect(runWorkflow({ ...f, recovery: {} })).rejects.toMatchObject({
    code: "persistence",
  });
  expect(f.load().recovery?.operations["deliver/1"]?.status).toBe("running");
  const result = await runWorkflow({
    ...f,
    checkpoint: f.load(),
    recovery: {
      reconcile: async () => ({
        status: "completed",
        value: { candidate: "candidate-1", reference: "local-receipt" },
      }),
    },
  });
  expect(result.phase).toBe("ready");
  expect(f.calls).toEqual(["implement", "validate", "review", "deliver"]);
});

it("keeps an unresolved or invalid delivery reconciliation from becoming completion", async () => {
  const f = fixture();
  f.operations.deliver = async () => {
    f.calls.push("publish");
    throw new WorkflowOperationError("transport", "Unknown receipt");
  };
  await expect(
    runWorkflow({
      ...f,
      recovery: { reconcile: async () => ({ status: "uncertain" }) },
    }),
  ).rejects.toMatchObject({ code: "uncertain" });
  await expect(
    runWorkflow({
      ...f,
      checkpoint: f.load(),
      recovery: {
        reconcile: async () => ({
          status: "completed",
          value: { candidate: "wrong-candidate", reference: "receipt" },
        }),
      },
    }),
  ).rejects.toMatchObject({ code: "gate" });
  expect(f.load().phase).toBe("deliver");
  expect(f.load().delivery).toBeUndefined();
  expect(f.calls.filter((call) => call === "publish")).toHaveLength(1);
});

it("re-observes an earlier uncertain reconciliation on resume when the remote receipt becomes visible", async () => {
  const f = fixture();
  f.operations.deliver = async () => {
    f.calls.push("publish");
    throw new WorkflowOperationError("transport", "Receipt not visible yet");
  };
  await expect(
    runWorkflow({
      ...f,
      recovery: { reconcile: async () => ({ status: "uncertain" }) },
    }),
  ).rejects.toMatchObject({ code: "uncertain" });
  const result = await runWorkflow({
    ...f,
    checkpoint: f.load(),
    recovery: {
      reconcile: async () => ({
        status: "completed",
        value: { candidate: "candidate-1", reference: "visible-receipt" },
      }),
    },
  });
  expect(result.phase).toBe("ready");
  expect(f.calls.filter((call) => call === "publish")).toHaveLength(1);
});

it("accepts observable completion after an unknown write interruption while refusing blind replay", async () => {
  const f = fixture();
  f.operations.deliver = async () => {
    f.calls.push("publish");
    throw Error("Unfamiliar failure after write");
  };
  await expect(runWorkflow({ ...f, recovery: {} })).rejects.toMatchObject({
    code: "operation",
  });
  await expect(
    runWorkflow({
      ...f,
      checkpoint: f.load(),
      recovery: { reconcile: async () => ({ status: "not-started" }) },
    }),
  ).rejects.toMatchObject({ code: "uncertain" });
  const result = await runWorkflow({
    ...f,
    checkpoint: f.load(),
    recovery: {
      reconcile: async () => ({
        status: "completed",
        value: { candidate: "candidate-1", reference: "observed-receipt" },
      }),
    },
  });
  expect(result.phase).toBe("ready");
  expect(f.calls.filter((call) => call === "publish")).toHaveLength(1);
});

it("retains a backoff deadline when the process ends after persisting operation intent", async () => {
  const f = fixture();
  const save = f.operations.save;
  let crash = true;
  f.operations.save = async (state) => {
    await save(state);
    if (crash && state.recovery?.operations["review/1"]?.status === "running") {
      crash = false;
      throw Error("Process ended after intent flush");
    }
  };
  await expect(
    runWorkflow({ ...f, recovery: { now: () => 1000 } }),
  ).rejects.toMatchObject({ code: "persistence" });
  const delays: number[] = [];
  const result = await runWorkflow({
    ...f,
    checkpoint: f.load(),
    recovery: {
      now: () => 1000,
      wait: async (ms) => {
        delays.push(ms);
      },
    },
  });
  expect(result.phase).toBe("ready");
  expect(delays).toEqual([500]);
});

it("cannot start implementation repair before a valid task has been selected", async () => {
  const f = fixture();
  f.operations.selectTask = async () => {
    throw new WorkflowOperationError(
      "substantive",
      "Invalid issue requirements",
    );
  };
  await expect(runWorkflow({ ...f, recovery: {} })).rejects.toMatchObject({
    code: "gate",
  });
  expect(f.calls).toEqual([]);
  expect(f.load().phase).toBe("select");
  expect(f.load().recovery?.implementationAttempts).toBe(0);
});
