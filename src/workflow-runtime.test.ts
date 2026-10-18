import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { createCommandRunner } from "./workflow-integrations.js";
import {
  withWorkflowRuntime,
  reconcileWorkflowRuntimeLock,
  type WorkflowRuntime,
} from "./workflow-runtime.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-runtime-"));
  cleanups.push(() => {
    const path = realpathSync(root);
    expect(path.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    expect(basename(path).startsWith("sandcastle-runtime-")).toBe(true);
    rmSync(path, { recursive: true, force: true });
  });
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Runtime fixture");
  git(root, "config", "user.email", "runtime@example.invalid");
  git(root, "commit", "--allow-empty", "-m", "base");
  const options = {
    repository: root,
    projectId: "consumer-A",
    runId: "run-1",
    compatibility: "dependencies-v1",
    command: createCommandRunner({ cwd: root }),
  };
  return { root, options };
}

describe("repository/run-scoped workflow runtime", () => {
  it("keeps projects A and B isolated in one process, even with the same run and resource names", async () => {
    const a = fixture();
    const b = fixture();
    let aPath = "";
    let bPath = "";
    for (const [name, f] of [
      ["A", a],
      ["B", b],
    ] as const) {
      await withWorkflowRuntime(
        { ...f.options, projectId: `consumer-${name}` },
        async (runtime) => {
          expect(await runtime.read("checkpoint")).toBeUndefined();
          await runtime.save("checkpoint", {
            project: name,
            prompt: `${name}-prompt`,
            credential: `${name}-fixture-token`,
            evidence: `${name}-evidence`,
          });
          const dependency = await runtime.resource("dependencies", {
            identity: "manifest-v1",
            create: async (path) => {
              expect(existsSync(join(path, "dependency.txt"))).toBe(false);
              writeFileSync(join(path, "dependency.txt"), name);
              return path;
            },
          });
          if (name === "A") aPath = dependency;
          else bPath = dependency;
        },
      );
    }
    expect(aPath).not.toBe(bPath);
    expect(readFileSync(join(aPath, "dependency.txt"), "utf8")).toBe("A");
    expect(readFileSync(join(bPath, "dependency.txt"), "utf8")).toBe("B");
    await withWorkflowRuntime(a.options, async (runtime) => {
      expect(await runtime.read("checkpoint")).toMatchObject({
        project: "A",
        prompt: "A-prompt",
        evidence: "A-evidence",
      });
    });
  });
  it("separates projects and runs inside one repository", async () => {
    const f = fixture();
    const directories: string[] = [];
    for (const [projectId, runId] of [
      ["A", "1"],
      ["B", "1"],
      ["A", "2"],
    ])
      await withWorkflowRuntime(
        { ...f.options, projectId: projectId!, runId: runId! },
        async (runtime) => {
          directories.push(runtime.directory);
          expect(await runtime.read("checkpoint")).toBeUndefined();
          await runtime.save("checkpoint", { projectId, runId });
        },
      );
    expect(new Set(directories).size).toBe(3);
  });
  it("rejects changed compatibility before calling the consumer or replacing records", async () => {
    const f = fixture();
    let directory = "";
    await withWorkflowRuntime(f.options, async (runtime) => {
      directory = runtime.directory;
      await runtime.save("checkpoint", { retained: true });
    });
    const before = readFileSync(join(directory, "records/checkpoint.json"));
    let calls = 0;
    await expect(
      withWorkflowRuntime(
        { ...f.options, compatibility: "changed-toolchain" },
        async () => {
          calls++;
        },
      ),
    ).rejects.toMatchObject({ code: "identity" });
    expect(calls).toBe(0);
    expect(readFileSync(join(directory, "records/checkpoint.json"))).toEqual(
      before,
    );
  });
  it("rejects a copied foreign record without interpreting it as a new checkpoint", async () => {
    const f = fixture();
    let foreign = "";
    await withWorkflowRuntime(f.options, async (runtime) => {
      await runtime.save("checkpoint", { project: "consumer-A" });
      foreign = join(runtime.directory, "records/checkpoint.json");
    });
    await expect(
      withWorkflowRuntime(
        { ...f.options, projectId: "consumer-B" },
        async (runtime) => {
          copyFileSync(
            foreign,
            join(runtime.directory, "records/checkpoint.json"),
          );
          await runtime.read("checkpoint");
        },
      ),
    ).rejects.toMatchObject({ code: "identity" });
    expect(existsSync(foreign)).toBe(true);
  });
  it("prevents conflicting runs across linked worktrees and releases the lock after success", async () => {
    const f = fixture();
    const linked = join(f.root, "linked");
    git(f.root, "worktree", "add", "-b", "linked", linked);
    let calls = 0;
    await withWorkflowRuntime(f.options, async () => {
      await expect(
        withWorkflowRuntime(
          { ...f.options, repository: linked, runId: "other-run" },
          async () => {
            calls++;
          },
        ),
      ).rejects.toMatchObject({ code: "locked" });
    });
    await withWorkflowRuntime(
      { ...f.options, repository: linked },
      async (runtime) => {
        expect(runtime.repository).toBe(realpathSync(join(f.root, ".git")));
        calls++;
      },
    );
    expect(calls).toBe(1);
  });
  it("creates one compatible resource for concurrent requests, closes it once, and reuses its prepared files", async () => {
    const f = fixture();
    let creates = 0;
    let closes = 0;
    let path = "";
    await withWorkflowRuntime(f.options, async (runtime) => {
      const resource = {
        identity: "image-and-dependencies-v1",
        create: async (directory: string) => {
          creates++;
          path = directory;
          writeFileSync(join(path, "cache.bin"), "prepared");
          return { mount: directory };
        },
        close: async () => {
          closes++;
        },
      };
      const [first, second] = await Promise.all([
        runtime.resource("sandbox", resource),
        runtime.resource("sandbox", resource),
      ]);
      expect(first).toBe(second);
      expect(closes).toBe(0);
    });
    expect(creates).toBe(1);
    expect(closes).toBe(1);
    await withWorkflowRuntime(f.options, async (runtime) => {
      expect(
        await runtime.resource("sandbox", {
          identity: "image-and-dependencies-v1",
          create: async (directory) => {
            expect(directory).toBe(path);
            return readFileSync(join(directory, "cache.bin"), "utf8");
          },
        }),
      ).toBe("prepared");
      expect(() =>
        runtime.resource("sandbox", {
          identity: "different-image",
          create: async () => "must-not-run",
        }),
      ).toThrow("compatibility changed");
    });
    await expect(
      withWorkflowRuntime(f.options, async (runtime) => {
        await runtime.resource("sandbox", {
          identity: "different-image",
          create: async () => "must-not-run",
        });
      }),
    ).rejects.toMatchObject({ code: "identity" });
    expect(readFileSync(join(path, "cache.bin"), "utf8")).toBe("prepared");
  });
  it("closes resources after an action failure and invalidates retained handles", async () => {
    const f = fixture();
    const error = new Error("native acceptance failed");
    let held: WorkflowRuntime | undefined;
    let closed = 0;
    await expect(
      withWorkflowRuntime(f.options, async (runtime) => {
        held = runtime;
        await runtime.resource("sandbox", {
          identity: "fixture",
          create: async () => ({}),
          close: async () => {
            closed++;
          },
        });
        throw error;
      }),
    ).rejects.toBe(error);
    expect(closed).toBe(1);
    await expect(held!.save("checkpoint", {})).rejects.toMatchObject({
      code: "closed",
    });
    await withWorkflowRuntime(f.options, async () => {});
  });
  it("retains the lock if resource cleanup fails", async () => {
    const f = fixture();
    await expect(
      withWorkflowRuntime(f.options, async (runtime) => {
        await runtime.resource("sandbox", {
          identity: "fixture",
          create: async () => ({}),
          close: async () => {
            throw Error("container still running");
          },
        });
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    await expect(
      withWorkflowRuntime(f.options, async () => {}),
    ).rejects.toMatchObject({ code: "locked" });
  });
  it("releases a retained runtime lock only after explicit owner and observable resource reconciliation", async () => {
    const f = fixture();
    let lock = "";
    let resourceLive = true;
    let cache = "";
    await expect(
      withWorkflowRuntime(f.options, async (runtime) => {
        lock = join(dirname(runtime.directory), "writer.lock");
        await runtime.resource("sandbox", {
          identity: "fixture-image-v1",
          create: async (directory) => {
            cache = join(directory, "cache.bin");
            writeFileSync(cache, "preserved");
            return {};
          },
          close: async () => {
            throw Error("lost container stop response");
          },
        });
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    const owner = JSON.parse(readFileSync(lock, "utf8")).owner;
    let observations = 0;
    const reconcile = async (context: {
      resources: Readonly<Record<string, string>>;
    }) => {
      observations++;
      expect(context.resources).toEqual({ sandbox: "fixture-image-v1" });
      return resourceLive
        ? { status: "uncertain" as const }
        : {
            status: "released" as const,
            evidence: ["No owned containers or subprocesses remain"],
          };
    };
    await expect(
      reconcileWorkflowRuntimeLock({
        ...f.options,
        expectedOwner: "wrong-owner",
        reconcile,
      }),
    ).rejects.toMatchObject({ code: "locked" });
    expect(observations).toBe(0);
    await expect(
      reconcileWorkflowRuntimeLock({
        ...f.options,
        expectedOwner: owner,
        reconcile,
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    expect(existsSync(lock)).toBe(true);
    resourceLive = false;
    await reconcileWorkflowRuntimeLock({
      ...f.options,
      expectedOwner: owner,
      reconcile,
    });
    await withWorkflowRuntime(f.options, async () => {});
    expect(readFileSync(cache, "utf8")).toBe("preserved");
  });
  it("refuses explicit recovery of an active owner before any callback or lock mutation", async () => {
    const f = fixture();
    await withWorkflowRuntime(f.options, async (runtime) => {
      const lock = join(dirname(runtime.directory), "writer.lock");
      const before = readFileSync(lock, "utf8");
      let observations = 0;
      await expect(
        reconcileWorkflowRuntimeLock({
          ...f.options,
          expectedOwner: JSON.parse(before).owner,
          reconcile: async () => {
            observations++;
            return { status: "released", evidence: ["must not be reached"] };
          },
        }),
      ).rejects.toMatchObject({ code: "locked" });
      expect(observations).toBe(0);
      expect(readFileSync(lock, "utf8")).toBe(before);
    });
  });
  it("retains the lock when a resource factory throws with an unknown outcome", async () => {
    const f = fixture();
    await expect(
      withWorkflowRuntime(f.options, async (runtime) => {
        await runtime.resource("sandbox", {
          identity: "fixture",
          create: async () => {
            throw Error("lost create response");
          },
        });
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    await expect(
      withWorkflowRuntime(f.options, async () => {}),
    ).rejects.toMatchObject({ code: "locked" });
  });
  it("never steals a stale lock based on PID alone", async () => {
    const f = fixture();
    let lock = "";
    await withWorkflowRuntime(f.options, async (runtime) => {
      lock = join(dirname(runtime.directory), "writer.lock");
    });
    const stale = JSON.stringify({ owner: "retained-owner", pid: 2147483647 });
    writeFileSync(lock, stale);
    await expect(
      withWorkflowRuntime(f.options, async () => {}),
    ).rejects.toMatchObject({ code: "locked" });
    expect(readFileSync(lock, "utf8")).toBe(stale);
  });
  it("refuses path traversal and non-JSON records", async () => {
    const f = fixture();
    await withWorkflowRuntime(f.options, async (runtime) => {
      await expect(runtime.save("../foreign", {})).rejects.toMatchObject({
        code: "configuration",
      });
      await expect(runtime.save("checkpoint", undefined)).rejects.toMatchObject(
        { code: "configuration" },
      );
      expect(await runtime.read("checkpoint")).toBeUndefined();
    });
  });
  it("does not start Git discovery for a pre-aborted scope", async () => {
    const f = fixture();
    let calls = 0;
    await expect(
      withWorkflowRuntime(
        {
          ...f.options,
          signal: AbortSignal.abort(new Error("paused")),
          command: async () => {
            calls++;
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
        async () => {},
      ),
    ).rejects.toThrow("paused");
    expect(calls).toBe(0);
  });
});
