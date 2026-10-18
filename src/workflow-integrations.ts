import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export class IntegrationError extends Error {
  constructor(
    readonly kind:
      | "configuration"
      | "transport"
      | "response"
      | "uncertain"
      | "preservation"
      | "restoration",
    message: string,
    readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "IntegrationError";
  }
}
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export type Command = (
  tool: "git" | "gh",
  args: readonly string[],
  options?: { cwd?: string; signal?: AbortSignal },
) => Promise<CommandResult>;

/** Returns a child-process environment; never mutates the model or host environment. */
export function proxyEnvironment(
  environment: NodeJS.ProcessEnv,
  proxy?: string,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (!proxy) return result;
  const entries = proxy
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const scheme of ["http", "https"]) {
    if (result[`${scheme.toUpperCase()}_PROXY`] || result[`${scheme}_proxy`])
      continue;
    const selected = entries.find((value) => value.startsWith(`${scheme}=`));
    const address = selected
      ? selected.slice(scheme.length + 1)
      : entries.find((value) => !value.includes("="));
    if (address)
      result[`${scheme.toUpperCase()}_PROXY`] = address.includes("://")
        ? address
        : `http://${address}`;
  }
  return result;
}

/** Optional discovery only. Calling this does not change any process environment. */
export async function discoverWindowsProxy(
  options: {
    platform?: string;
    query?: (args: readonly string[]) => Promise<string>;
  } = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const query =
    options.query ??
    ((args) =>
      new Promise<string>((resolveResult, reject) => {
        execFile(
          "reg.exe",
          [...args],
          { windowsHide: true, timeout: 5000 },
          (error, stdout) => (error ? reject(error) : resolveResult(stdout)),
        );
      }));
  try {
    const key =
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enabled = await query(["query", key, "/v", "ProxyEnable"]);
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled)) return undefined;
    const server = await query(["query", key, "/v", "ProxyServer"]);
    return server.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export function findExecutable(
  name: string,
  options: {
    path?: string;
    platform?: string;
    candidates?: readonly string[];
  } = {},
): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name))
    throw new IntegrationError(
      "configuration",
      "Executable names must not contain paths.",
    );
  const windows = (options.platform ?? process.platform) === "win32";
  const names = windows ? [`${name}.exe`, name] : [name];
  const candidates = [
    ...(options.candidates ?? []),
    ...(options.path ?? process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((directory) => names.map((file) => join(directory, file))),
  ];
  for (const path of candidates) {
    try {
      if (statSync(path).isFile()) {
        accessSync(path, windows ? constants.F_OK : constants.X_OK);
        return resolve(path);
      }
    } catch {}
  }
  throw new IntegrationError(
    "configuration",
    `Required executable is unavailable: ${name}`,
  );
}

export function createCommandRunner(options: {
  cwd: string;
  tools?: Partial<Record<"git" | "gh", string>>;
  environment?: NodeJS.ProcessEnv;
  githubEnvironment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Command {
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 300000)
    throw new IntegrationError(
      "configuration",
      "Command timeout must be between 1 and 300000 milliseconds.",
    );
  const environment = { ...(options.environment ?? process.env) };
  return (tool, args, invocation = {}) =>
    new Promise((resolveResult, reject) => {
      const executable =
        options.tools?.[tool] ??
        findExecutable(tool, { path: environment.PATH });
      execFile(
        executable,
        [...args],
        {
          cwd: invocation.cwd ?? options.cwd,
          windowsHide: true,
          timeout,
          signal: invocation.signal,
          env: {
            ...environment,
            ...(tool === "gh" ? options.githubEnvironment : {}),
            LC_ALL: "C",
          },
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (invocation.signal?.aborted) {
            reject(invocation.signal.reason);
            return;
          }
          if (error && (error.killed || typeof error.code !== "number")) {
            const code = error.code;
            reject(
              new IntegrationError(
                "transport",
                `The ${tool} command could not complete.`,
                error.killed ||
                  [
                    "ETIMEDOUT",
                    "ECONNRESET",
                    "ECONNREFUSED",
                    "EAI_AGAIN",
                    "ENETUNREACH",
                  ].includes(String(code)),
                error,
              ),
            );
          } else
            resolveResult({
              stdout,
              stderr,
              exitCode: error ? Number(error.code) : 0,
            });
        },
      );
    });
}

export interface RetryOptions {
  attempts?: number;
  signal?: AbortSignal;
  wait?: (milliseconds: number) => Promise<void>;
}
async function readWithRetry<T>(
  read: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)
    throw new IntegrationError(
      "configuration",
      "Read attempt limit must be between 1 and 10.",
    );
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      if (
        !(error instanceof IntegrationError) ||
        !error.retryable ||
        attempt + 1 >= attempts
      )
        throw error;
      const delay = Math.min(4000, 500 * 2 ** attempt);
      if (options.wait) await options.wait(delay);
      else
        await new Promise<void>((finish) => {
          const stop = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", stop);
            finish();
          };
          const timer = setTimeout(stop, delay);
          options.signal?.addEventListener("abort", stop, { once: true });
          if (options.signal?.aborted) stop();
        });
    }
  }
}

/** Read-only CLI client. Repository identity, labels and selection policy are caller inputs. */
export function createGitHubReader(
  options: {
    repository: string;
    command: Command;
    maxPages?: number;
  } & RetryOptions,
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository))
    throw new IntegrationError(
      "configuration",
      "Expected an explicit owner/repository identity.",
    );
  const maxPages = options.maxPages ?? 20;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100)
    throw new IntegrationError(
      "configuration",
      "Page limit must be between 1 and 100.",
    );
  const request = (endpoint: string) =>
    readWithRetry(async () => {
      const result = await options.command(
        "gh",
        ["api", "--method", "GET", "--include", endpoint],
        { signal: options.signal },
      );
      const match = result.stdout.match(
        /^HTTP\/\S+\s+(\d{3})[^\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/,
      );
      if (!match)
        throw new IntegrationError(
          "response",
          "GitHub returned no readable HTTP response.",
          false,
          new Error(result.stderr),
        );
      const status = Number(match[1]);
      const headers = Object.fromEntries(
        match[2]!.split(/\r?\n/).map((line) => {
          const colon = line.indexOf(":");
          return [
            line.slice(0, colon).toLowerCase(),
            line.slice(colon + 1).trim(),
          ];
        }),
      );
      if (status < 200 || status >= 300)
        throw new IntegrationError(
          "response",
          `GitHub GET failed with HTTP ${status}.`,
          [408, 429].includes(status) ||
            status >= 500 ||
            (status === 403 && Boolean(headers["retry-after"])),
        );
      if (result.exitCode !== 0)
        throw new IntegrationError(
          "response",
          "GitHub CLI failed despite its HTTP response.",
        );
      return {
        data: JSON.parse(match[3]!),
        next: /<[^>]+>; rel="next"/.test(headers.link ?? ""),
      };
    }, options);
  const collection = async <T>(path: string): Promise<T[]> => {
    const values: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, next } = await request(
        `repos/${options.repository}/${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (!Array.isArray(data))
        throw new IntegrationError("response", "Expected a GitHub collection.");
      values.push(...data);
      if (!next) return values;
    }
    throw new IntegrationError(
      "response",
      "GitHub page limit reached; the partial collection was not accepted.",
    );
  };
  return {
    issues: (labels: readonly string[] = []) =>
      collection<GitHubIssue>(
        `issues?state=open${labels.length ? `&labels=${encodeURIComponent(labels.join(","))}` : ""}`,
      ),
    pulls: () =>
      collection<{
        number: number;
        head: { ref: string };
        base: { ref: string };
        html_url: string;
      }>("pulls?state=open"),
    blockers: (number: number) => {
      if (!Number.isSafeInteger(number) || number < 1)
        throw new IntegrationError("configuration", "Invalid issue number.");
      return collection<GitHubIssue>(
        `issues/${number}/dependencies/blocked_by`,
      );
    },
  };
}
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  pull_request?: unknown;
  issue_dependencies_summary?: { blocked_by: number };
  sub_issues_summary?: { total: number };
}

/** Optional write integration through explicit capabilities. The reader above never supplies them. */
export async function publishCommentOnce<T extends { body: string }>(
  options: {
    marker: string;
    body: string;
    list: () => Promise<T[]>;
    create: (body: string) => Promise<T>;
  } & RetryOptions,
): Promise<T> {
  if (!options.marker.trim() || /[\r\n]/.test(options.marker))
    throw new IntegrationError(
      "configuration",
      "A stable single-line publication marker is required.",
    );
  const find = async () => {
    const matches = (await readWithRetry(options.list, options)).filter(
      (entry) => entry.body.split(/\r?\n/).includes(options.marker),
    );
    if (matches.length > 1)
      throw new IntegrationError(
        "uncertain",
        "Multiple matching publications exist; no additional write was attempted.",
      );
    return matches[0];
  };
  const existing = await find();
  if (existing) return existing;
  options.signal?.throwIfAborted();
  try {
    return await options.create(`${options.marker}\n${options.body}`);
  } catch (cause) {
    let reconciled: T | undefined;
    try {
      reconciled = await find();
    } catch (readError) {
      throw new IntegrationError(
        "uncertain",
        "Publication outcome could not be reconciled; no write was repeated.",
        false,
        new AggregateError([cause, readError]),
      );
    }
    if (reconciled) return reconciled;
    throw new IntegrationError(
      "uncertain",
      "Publication outcome is uncertain; no write was repeated.",
      false,
      cause,
    );
  }
}

export interface WorktreeRecovery {
  prepared: string;
  originalHead: string;
  originalBranch: string;
  candidate: string;
  marker: string;
  stash?: string;
  phase: "starting" | "preserved" | "restored" | "restoration-required";
}
export class WorktreeRestorationError extends IntegrationError {
  constructor(
    readonly recovery: WorktreeRecovery,
    cause: unknown,
  ) {
    super(
      "restoration",
      "Prepared worktree requires restoration; preserved changes remain in its recorded Git stash.",
      false,
      cause,
    );
  }
}

/** Git-native preservation. Calls sharing a repository must be serialized by the consumer. */
export async function withPreparedWorktree<T>(
  options: {
    source: string;
    prepared: string;
    candidate: string;
    command: Command;
    saveRecovery: (state: WorktreeRecovery) => Promise<void>;
    /** A process owner must confirm all prepared-tree writers stopped before checkout or restoration. */
    quiescent?: () => boolean | Promise<boolean>;
  },
  action: (prepared: string) => Promise<T>,
): Promise<T> {
  if (options.quiescent && !(await options.quiescent()))
    throw new IntegrationError(
      "uncertain",
      "Prepared process quiescence is unknown; no checkout or preservation was started.",
    );
  const git = async (cwd: string, ...args: string[]) => {
    const result = await options.command("git", args, { cwd });
    if (result.exitCode !== 0)
      throw new IntegrationError(
        "preservation",
        `Git operation failed: ${args[0]}`,
        false,
        new Error(result.stderr),
      );
    return result.stdout.trimEnd();
  };
  const source = realpathSync(
    await git(options.source, "rev-parse", "--show-toplevel"),
  );
  const prepared = realpathSync(
    await git(options.prepared, "rev-parse", "--show-toplevel"),
  );
  if (
    source === prepared ||
    prepared !== realpathSync(options.prepared) ||
    realpathSync(
      await git(
        source,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    ) !==
      realpathSync(
        await git(
          prepared,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ),
      )
  )
    throw new IntegrationError(
      "configuration",
      "Validation requires a separate worktree of the same repository.",
    );
  if (!/^[a-fA-F0-9]{40,64}$/.test(options.candidate))
    throw new IntegrationError(
      "configuration",
      "Validation candidate must be a full commit identity.",
    );
  await git(prepared, "cat-file", "-e", `${options.candidate}^{commit}`);
  const untracked = (
    await git(prepared, "ls-files", "--others", "--exclude-standard", "-z")
  )
    .split("\0")
    .filter(Boolean);
  const tracked = (
    await git(prepared, "ls-tree", "-r", "--name-only", "-z", options.candidate)
  )
    .split("\0")
    .filter(Boolean);
  if (
    untracked.some((path) =>
      tracked.some(
        (target) =>
          path === target ||
          path.startsWith(target + "/") ||
          target.startsWith(path + "/"),
      ),
    )
  )
    throw new IntegrationError(
      "preservation",
      "Untracked paths collide with the candidate; no checkout or stash was performed.",
    );
  const recovery: WorktreeRecovery = {
    prepared,
    candidate: options.candidate,
    originalHead: await git(prepared, "rev-parse", "HEAD"),
    originalBranch: await git(prepared, "branch", "--show-current"),
    marker: `sandcastle-preserve:${randomUUID()}`,
    phase: "starting",
  };
  await options.saveRecovery(structuredClone(recovery));
  let result: T | undefined;
  let actionError: unknown;
  let failed = false;
  let preservationStarted = false;
  try {
    if ((await git(prepared, "status", "--porcelain")).trim()) {
      preservationStarted = true;
      await git(
        prepared,
        "stash",
        "push",
        "--include-untracked",
        "--message",
        recovery.marker,
      );
      const entry = (await git(prepared, "stash", "list", "--format=%H%x00%gs"))
        .split("\n")
        .find((line) => line.includes(recovery.marker));
      if (!entry)
        throw new IntegrationError(
          "preservation",
          "The preservation stash could not be identified; inspect its recorded marker.",
        );
      recovery.stash = entry.split("\0")[0];
    }
    recovery.phase = "preserved";
    await options.saveRecovery(structuredClone(recovery));
    await git(
      prepared,
      "checkout",
      "--no-overwrite-ignore",
      "--detach",
      options.candidate,
    );
    result = await action(prepared);
  } catch (cause) {
    failed = true;
    actionError = cause;
  }
  try {
    if (options.quiescent && !(await options.quiescent()))
      throw new Error(
        "Owned processes may still write this prepared checkout; restoration requires explicit quiescence reconciliation.",
      );
    if (
      (preservationStarted && !recovery.stash) ||
      (await git(prepared, "status", "--porcelain")).trim()
    )
      throw new Error(
        "Uncertain preservation or new work prevents safe restoration; inspect the recorded stash marker and worktree.",
      );
    if (recovery.originalBranch) {
      if (
        (await git(
          prepared,
          "rev-parse",
          `refs/heads/${recovery.originalBranch}`,
        )) !== recovery.originalHead
      )
        throw new Error("Original branch moved during validation.");
      await git(
        prepared,
        "checkout",
        "--no-overwrite-ignore",
        recovery.originalBranch,
      );
    } else
      await git(
        prepared,
        "checkout",
        "--no-overwrite-ignore",
        "--detach",
        recovery.originalHead,
      );
    if (recovery.stash)
      await git(prepared, "stash", "apply", "--index", recovery.stash);
    recovery.phase = "restored";
    await options.saveRecovery(structuredClone(recovery));
  } catch (cause) {
    recovery.phase = "restoration-required";
    try {
      await options.saveRecovery(structuredClone(recovery));
    } catch {}
    throw new WorktreeRestorationError(
      recovery,
      failed ? new AggregateError([actionError, cause]) : cause,
    );
  }
  if (failed) throw actionError;
  return result as T;
}
