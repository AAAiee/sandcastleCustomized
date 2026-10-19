import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  createCommandRunner,
  createGitHubReader,
  discoverWindowsProxy,
  findExecutable,
  IntegrationError,
  proxyEnvironment,
  publishCommentOnce,
  withPreparedWorktree,
  type Command,
  type WorktreeRecovery,
} from "./workflow-integrations.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "sandcastle-integrations-"));
  cleanup.push(() => {
    const real = realpathSync(path);
    expect(real.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    expect(basename(real).startsWith("sandcastle-integrations-")).toBe(true);
    rmSync(real, { recursive: true, force: true });
  });
  return path;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trimEnd();
function repositories() {
  const root = temporary();
  const source = join(root, "source");
  const prepared = join(root, "prepared");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Integration fixture");
  git(source, "config", "user.email", "integration@example.invalid");
  git(source, "config", "core.autocrlf", "false");
  writeFileSync(join(source, ".gitignore"), "cache/\n");
  writeFileSync(join(source, "first.txt"), "first\n");
  writeFileSync(join(source, "second.txt"), "second\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "-b", "candidate");
  writeFileSync(join(source, "first.txt"), "candidate\n");
  writeFileSync(join(source, "future.txt"), "future\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "candidate");
  const candidate = git(source, "rev-parse", "HEAD");
  git(source, "checkout", "main");
  git(source, "worktree", "add", "-b", "validation", prepared, base);
  writeFileSync(join(source, "second.txt"), "owner edit\n");
  git(source, "add", "second.txt");
  writeFileSync(join(source, "owner.txt"), "owner untracked\n");
  const records: WorktreeRecovery[] = [];
  const options = {
    source,
    prepared,
    candidate,
    command: createCommandRunner({ cwd: source }),
    saveRecovery: async (state: WorktreeRecovery) => {
      records.push(state);
    },
  };
  const snapshot = (path: string) => ({
    head: git(path, "rev-parse", "HEAD"),
    branch: git(path, "branch", "--show-current"),
    status: git(path, "status", "--porcelain"),
    staged: git(path, "diff", "--cached", "--binary"),
    unstaged: git(path, "diff", "--binary"),
  });
  return { source, prepared, candidate, options, records, snapshot };
}

describe("prepared Git worktree integration", () => {
  it("retains the candidate and preservation record while owned process quiescence is uncertain", async () => {
    const f = repositories();
    const before = f.snapshot(f.prepared);
    let quiescent = true;
    await expect(
      withPreparedWorktree(
        { ...f.options, quiescent: () => quiescent },
        async () => {
          quiescent = false;
          throw new Error("Supervisor outcome unknown");
        },
      ),
    ).rejects.toMatchObject({ kind: "restoration" });
    expect(git(f.prepared, "rev-parse", "HEAD")).toBe(f.candidate);
    expect(f.records.at(-1)?.phase).toBe("restoration-required");
    expect(f.snapshot(f.source).status).toContain("owner.txt");
    expect(f.snapshot(f.prepared)).not.toEqual(before);
  });
  it("preserves staged, unstaged and untracked work in both checkouts and reuses ignored cache", async () => {
    const f = repositories();
    writeFileSync(join(f.prepared, "first.txt"), "staged\n");
    git(f.prepared, "add", "first.txt");
    writeFileSync(join(f.prepared, "first.txt"), "staged plus unstaged\n");
    writeFileSync(join(f.prepared, "notes.txt"), "untracked\n");
    mkdirSync(join(f.prepared, "cache"));
    writeFileSync(
      join(f.prepared, "cache/dependency.bin"),
      "prepared dependency\n",
    );
    const before = f.snapshot(f.prepared);
    const owner = f.snapshot(f.source);
    expect(
      await withPreparedWorktree(f.options, async (path) => {
        expect(git(path, "rev-parse", "HEAD")).toBe(f.candidate);
        expect(readFileSync(join(path, "first.txt"), "utf8")).toBe(
          "candidate\n",
        );
        expect(readFileSync(join(path, "cache/dependency.bin"), "utf8")).toBe(
          "prepared dependency\n",
        );
        return "passed";
      }),
    ).toBe("passed");
    expect(f.snapshot(f.prepared)).toEqual(before);
    expect(f.snapshot(f.source)).toEqual(owner);
    expect(readFileSync(join(f.prepared, "notes.txt"), "utf8")).toBe(
      "untracked\n",
    );
    expect(f.records.at(-1)?.phase).toBe("restored");
    expect(f.records.at(-1)?.stash).toMatch(/^[a-f0-9]+$/);
  });
  it("refuses untracked candidate collisions before preserving or changing anything", async () => {
    const f = repositories();
    writeFileSync(join(f.prepared, "future.txt"), "local work\n");
    const before = f.snapshot(f.prepared);
    await expect(
      withPreparedWorktree(f.options, async () => {
        throw Error("must not run");
      }),
    ).rejects.toMatchObject({ kind: "preservation" });
    expect(f.snapshot(f.prepared)).toEqual(before);
    expect(f.records).toEqual([]);
  });
  it("requires a separate worktree and leaves owner edits untouched", async () => {
    const f = repositories();
    const before = f.snapshot(f.source);
    await expect(
      withPreparedWorktree(
        { ...f.options, prepared: f.source },
        async () => {},
      ),
    ).rejects.toMatchObject({ kind: "configuration" });
    expect(f.snapshot(f.source)).toEqual(before);
  });
  it("restores edits and rethrows the original validation failure", async () => {
    const f = repositories();
    writeFileSync(join(f.prepared, "first.txt"), "local work\n");
    const before = f.snapshot(f.prepared);
    const failure = new Error("native assertion failed");
    await expect(
      withPreparedWorktree(f.options, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(f.snapshot(f.prepared)).toEqual(before);
    expect(f.records.at(-1)?.phase).toBe("restored");
  });
  it("retains both the backup and new work when restoration would conflict", async () => {
    const f = repositories();
    writeFileSync(join(f.prepared, "notes.txt"), "original notes\n");
    await expect(
      withPreparedWorktree(f.options, async (path) => {
        writeFileSync(join(path, "notes.txt"), "new partial work\n");
      }),
    ).rejects.toMatchObject({
      kind: "restoration",
      recovery: { phase: "restoration-required" },
    });
    const recovery = f.records.at(-1)!;
    expect(git(f.prepared, "show", `${recovery.stash}^3:notes.txt`)).toBe(
      "original notes",
    );
    expect(readFileSync(join(f.prepared, "notes.txt"), "utf8")).toBe(
      "new partial work\n",
    );
  });
  it("retains a recoverable stash when Git itself rejects restoration", async () => {
    const f = repositories();
    writeFileSync(join(f.prepared, "first.txt"), "preserved staged work\n");
    git(f.prepared, "add", "first.txt");
    const command: Command = async (tool, args, options) => {
      // Simulate another actor changing the file just before the real stash apply.
      if (args[0] === "stash" && args[1] === "apply")
        writeFileSync(join(f.prepared, "first.txt"), "concurrent work\n");
      return f.options.command(tool, args, options);
    };
    await expect(
      withPreparedWorktree({ ...f.options, command }, async () => {}),
    ).rejects.toMatchObject({
      kind: "restoration",
      recovery: { phase: "restoration-required" },
    });
    const recovery = f.records.at(-1)!;
    expect(git(f.prepared, "show", `${recovery.stash}:first.txt`)).toBe(
      "preserved staged work",
    );
    expect(readFileSync(join(f.prepared, "first.txt"), "utf8")).toBe(
      "concurrent work\n",
    );
  });
});

const response = (status: number, data: unknown, headers = "") => ({
  stdout: `HTTP/2.0 ${status} status\r\nContent-Type: application/json\r\n${headers}\r\n${JSON.stringify(data)}`,
  stderr: "",
  exitCode: status >= 400 ? 1 : 0,
});
describe("read-only GitHub integration", () => {
  it("uses explicit identity and labels, follows pagination, and only requests GET", async () => {
    const calls: string[][] = [];
    const command: Command = async (tool, args) => {
      expect(tool).toBe("gh");
      calls.push([...args]);
      return calls.length === 1
        ? response(
            200,
            [{ number: 1 }],
            'Link: <https://api.github.com/next>; rel="next"\r\n',
          )
        : response(200, [{ number: 2 }]);
    };
    const reader = createGitHubReader({
      repository: "example/project",
      command,
    });
    expect(
      (await reader.issues(["consumer-label"])).map((value) => value.number),
    ).toEqual([1, 2]);
    expect(calls).toEqual([
      [
        "api",
        "--method",
        "GET",
        "--include",
        "repos/example/project/issues?state=open&labels=consumer-label&per_page=100&page=1",
      ],
      [
        "api",
        "--method",
        "GET",
        "--include",
        "repos/example/project/issues?state=open&labels=consumer-label&per_page=100&page=2",
      ],
    ]);
  });
  it("bounds transient HTTP retries and stops permanent HTTP failures immediately", async () => {
    let calls = 0;
    const waits: number[] = [];
    const reader = createGitHubReader({
      repository: "example/project",
      command: async () => {
        calls++;
        return response(503, {});
      },
      wait: async (delay) => {
        waits.push(delay);
      },
    });
    await expect(reader.issues()).rejects.toMatchObject({ retryable: true });
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 1000]);
    calls = 0;
    const permanent = createGitHubReader({
      repository: "example/project",
      command: async () => {
        calls++;
        return response(401, {});
      },
    });
    await expect(permanent.issues()).rejects.toMatchObject({
      retryable: false,
    });
    expect(calls).toBe(1);
  });
  it("refuses to accept a truncated collection when the configured page bound is reached", async () => {
    const reader = createGitHubReader({
      repository: "example/project",
      maxPages: 1,
      command: async () =>
        response(
          200,
          [],
          'Link: <https://api.github.com/next>; rel="next"\r\n',
        ),
    });
    await expect(reader.issues()).rejects.toThrow("page limit");
  });
  it("reconciles a lost write response without posting twice", async () => {
    const comments: Array<{ body: string }> = [];
    let writes = 0;
    const result = await publishCommentOnce({
      marker: "unique-marker",
      body: "consumer publication",
      list: async () => comments,
      create: async (body) => {
        writes++;
        comments.push({ body });
        throw new IntegrationError("transport", "lost response", true);
      },
    });
    expect(result).toEqual(comments[0]);
    expect(writes).toBe(1);
  });
  it("stops uncertain when publication reconciliation reads are unavailable", async () => {
    let reads = 0;
    let writes = 0;
    await expect(
      publishCommentOnce({
        marker: "unique-marker",
        body: "consumer publication",
        wait: async () => {},
        list: async () => {
          reads++;
          if (reads > 1)
            throw new IntegrationError("transport", "read unavailable", true);
          return [];
        },
        create: async () => {
          writes++;
          throw new IntegrationError("transport", "lost response", true);
        },
      }),
    ).rejects.toMatchObject({ kind: "uncertain" });
    expect(writes).toBe(1);
    expect(reads).toBe(4);
  });
  it("keeps unknown write outcomes uncertain even when an immediate read is empty", async () => {
    let writes = 0;
    await expect(
      publishCommentOnce({
        marker: "unique-marker",
        body: "consumer publication",
        list: async () => [],
        create: async () => {
          writes++;
          throw Error("unknown");
        },
      }),
    ).rejects.toMatchObject({ kind: "uncertain" });
    expect(writes).toBe(1);
  });
  it("matches publication markers as complete lines rather than task-number substrings", async () => {
    let writes = 0;
    await publishCommentOnce({
      marker: "task-1",
      body: "publication",
      list: async () => [{ body: "task-10\nAnother task" }],
      create: async (body) => {
        writes++;
        return { body };
      },
    });
    expect(writes).toBe(1);
  });
  it("does not start a publication after cancellation during the initial read", async () => {
    const controller = new AbortController();
    let writes = 0;
    await expect(
      publishCommentOnce({
        marker: "unique-marker",
        body: "publication",
        signal: controller.signal,
        list: async () => {
          controller.abort(new Error("operator paused"));
          return [];
        },
        create: async (body) => {
          writes++;
          return { body };
        },
      }),
    ).rejects.toThrow("operator paused");
    expect(writes).toBe(0);
  });
});

describe("optional host configuration", () => {
  it("keeps proxy overrides and scopes GitHub environment to its child only", async () => {
    const input: NodeJS.ProcessEnv = {
      ...process.env,
      HTTP_PROXY: "http://explicit.example:80",
    };
    const environment = proxyEnvironment(
      input,
      "http=proxy.example:81;https=proxy.example:82",
    );
    expect(environment.HTTP_PROXY).toBe(input.HTTP_PROXY);
    expect(environment.HTTPS_PROXY).toBe(
      input.HTTPS_PROXY ?? "http://proxy.example:82",
    );
    expect(input).not.toBe(environment);
    const command = createCommandRunner({
      cwd: temporary(),
      tools: { git: process.execPath, gh: process.execPath },
      environment: { ...process.env, INTEGRATION_ROUTE: "default" },
      githubEnvironment: { INTEGRATION_ROUTE: "github-only" },
    });
    expect(
      (
        await command("git", [
          "-e",
          "console.log(process.env.INTEGRATION_ROUTE)",
        ])
      ).stdout.trim(),
    ).toBe("default");
    expect(
      (
        await command("gh", [
          "-e",
          "console.log(process.env.INTEGRATION_ROUTE)",
        ])
      ).stdout.trim(),
    ).toBe("github-only");
    expect(process.env.INTEGRATION_ROUTE).toBeUndefined();
  });
  it("finds an explicitly configured tool without embedding a workstation path", () => {
    expect(
      findExecutable("node", { candidates: [process.execPath], path: "" }),
    ).toBe(process.execPath);
  });
  it("reads Windows proxy settings only when explicitly requested on Windows", async () => {
    let queries = 0;
    const query = async (args: readonly string[]) => {
      queries++;
      return args.includes("ProxyEnable")
        ? "ProxyEnable REG_DWORD 0x1"
        : "ProxyServer REG_SZ https=proxy.example:82";
    };
    expect(
      await discoverWindowsProxy({ platform: "linux", query }),
    ).toBeUndefined();
    expect(queries).toBe(0);
    expect(await discoverWindowsProxy({ platform: "win32", query })).toBe(
      "https=proxy.example:82",
    );
    expect(queries).toBe(2);
  });
});
