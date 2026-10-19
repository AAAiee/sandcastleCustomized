import { Data, Effect } from "effect";
import {
  runWorkflowEffect,
  workflowProgram,
  workflowStep,
  workflowSync,
  workflowFile,
  workflowValue,
} from "./workflow-effects.js";
import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

class IntegrationInvariantFailure extends Data.TaggedError(
  "IntegrationInvariantFailure",
)<{ readonly message: string }> {}

/** Classified host integration failure; only retryable read failures may be retried automatically. */
export class IntegrationError extends Error {
  /** Creates the public classified failure, retaining the original cause when supplied. */
  constructor(
    /** Semantic failure classification; unknown or permanent failures must not be blindly retried. */
    readonly kind:
      | "configuration"
      | "transport"
      | "response"
      | "uncertain"
      | "preservation"
      | "restoration",
    message: string,
    /** Whether this transport/HTTP failure is eligible for bounded read retry; defaults to false. */
    readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "IntegrationError";
  }
}
/** Captured command output and ordinary process exit status. */
export interface CommandResult {
  /** Captured standard output; commands are never interpreted by a shell. */
  stdout: string;
  /** Captured standard error, including ordinary nonzero command exits. */
  stderr: string;
  /** Actual process exit status; ordinary nonzero exits resolve instead of rejecting. */
  exitCode: number;
}
/** Shell-free git/gh invocation capability; optional cwd overrides runner cwd and optional signal cancels the invocation. Transport/startup failures reject; ordinary nonzero exits resolve. */
export type Command = (
  tool: "git" | "gh",
  args: readonly string[],
  options?: {
    /** Working directory override; omitted invocations use the configured runner directory. */
    /** Working directory override; omitted invocations use the configured runner directory. */
    cwd?: string; /** Optional caller cancellation; abort prevents new work and preserves recovery/cleanup obligations. */
    /** Optional caller cancellation; abort prevents new work and preserves recovery/cleanup obligations. */
    signal?: AbortSignal;
  },
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

/** Read-only optional registry proxy discovery. Non-Windows hosts, disabled proxies and failed registry queries resolve undefined. Never changes the process environment. */
export function discoverWindowsProxy(
  options: {
    /** Host platform name; defaults to process.platform. */
    platform?: string;
    /** Optional registry query capability; defaults to a hidden reg.exe invocation with a five-second deadline. */
    query?: (args: readonly string[]) => Promise<string>;
  } = {},
): Promise<string | undefined> {
  return runWorkflowEffect(discoverWindowsProxyProgram(options));
}

function discoverWindowsProxyProgram(
  options: {
    platform?: string;
    query?: (args: readonly string[]) => Promise<string>;
  } = {},
) {
  return workflowProgram(
    Effect.gen(function* () {
      if ((options.platform ?? process.platform) !== "win32") return undefined;
      const query =
        options.query ??
        ((args) =>
          new Promise<string>((resolveResult, reject) => {
            execFile(
              "reg.exe",
              [...args],
              { windowsHide: true, timeout: 5000 },
              (error, stdout) =>
                error ? reject(error) : resolveResult(stdout),
            );
          }));
      try {
        const key =
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
        const enabled = workflowValue(
          yield* workflowStep(() => query(["query", key, "/v", "ProxyEnable"])),
        );
        if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled)) return undefined;
        const server = workflowValue(
          yield* workflowStep(() => query(["query", key, "/v", "ProxyServer"])),
        );
        return server.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
      } catch {
        return undefined;
      }
    }),
  );
}

/** Returns the first usable explicit/PATH executable without changing the environment. Windows searches .exe then bare names; other hosts require executable permission. Throws IntegrationError(configuration) for invalid names or unavailable executables. */
export function findExecutable(
  name: string,
  options: {
    /** Search path; defaults to process.env.PATH. */
    path?: string;
    /** Host platform name; defaults to process.platform. */
    platform?: string;
    /** Explicit executable candidates searched before PATH entries; omitted means none. */
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

/** Creates a hidden shell-free git/gh runner with a captured child environment and bounded deadline. Invalid timeout throws immediately; invocations reject transport failures or the original abort reason, and resolve ordinary process exit statuses. */
export function createCommandRunner(options: {
  /** Working directory override; omitted invocations use the configured runner directory. */
  cwd: string;
  /** Optional explicit git/gh executable paths; missing entries are discovered using the runner PATH. */
  tools?: Partial<Record<"git" | "gh", string>>;
  /** Child environment snapshot; defaults to process.env and never mutates the host. */
  environment?: NodeJS.ProcessEnv;
  /** Additional child environment for gh only; omitted means no GitHub-specific override. */
  githubEnvironment?: NodeJS.ProcessEnv;
  /** Command deadline in milliseconds; defaults to 30000 and must be between 1 and 300000. */
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
    runWorkflowEffect(
      workflowProgram(
        Effect.gen(function* () {
          return workflowValue(
            yield* workflowStep(
              () =>
                new Promise<CommandResult>((resolveResult, reject) => {
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
                      if (
                        error &&
                        (error.killed || typeof error.code !== "number")
                      ) {
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
                }),
            ),
          );
        }),
      ),
    );
}

/** Bounded retries for idempotent reads only; writes require explicit observation before replay. */
export interface RetryOptions {
  /** Maximum read invocations; defaults to 3, allowed range 1–10. Writes are never retried by this policy. */
  attempts?: number;
  /** Optional caller cancellation; abort prevents new work and preserves recovery/cleanup obligations. */
  signal?: AbortSignal;
  /** Optional millisecond backoff capability; defaults to abort-aware host timers. Must resolve only after waiting or cancellation. */
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

/** Creates a read-only GitHub GET client for an explicit repository. Invalid repository/page/retry configuration fails; collection methods reject malformed/failed responses and page overflow rather than return partial results. Only classified transient reads receive bounded retries. Labels and selection policy remain caller inputs. */
export function createGitHubReader(
  options: {
    /** Explicit Git checkout path; runtime scope uses its canonical common Git directory. */
    repository: string;
    /** Explicit shell-free git/gh invocation capability; must honor supplied cancellation and report actual process exit/output. */
    command: Command;
    /** Maximum complete collection pages; defaults to 20, allowed range 1–100; overflow rejects partial results. */
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
          new IntegrationInvariantFailure({ message: result.stderr }),
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
  const collection = <T>(path: string): Promise<T[]> => {
    return runWorkflowEffect(
      workflowProgram(
        Effect.gen(function* () {
          const values: T[] = [];
          for (let page = 1; page <= maxPages; page++) {
            const { data, next } = workflowValue(
              yield* workflowStep(() =>
                request(
                  `repos/${options.repository}/${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
                ),
              ),
            );
            if (!Array.isArray(data))
              throw new IntegrationError(
                "response",
                "Expected a GitHub collection.",
              );
            values.push(...data);
            if (!next) return values;
          }
          throw new IntegrationError(
            "response",
            "GitHub page limit reached; the partial collection was not accepted.",
          );
        }),
      ),
    );
  };
  return {
    /** Lists all open issue/PR entries matching explicit labels; rejects partial pagination or failed reads. */
    issues: (labels: readonly string[] = []) =>
      collection<GitHubIssue>(
        `issues?state=open${labels.length ? `&labels=${encodeURIComponent(labels.join(","))}` : ""}`,
      ),
    /** Lists all open pull requests, with complete bounded pagination. */
    pulls: () =>
      collection<{
        /** GitHub issue or pull request number. */
        number: number;
        /** Pull request source branch identity. */
        head: {
          /** GitHub branch reference. */
          /** GitHub branch reference. */
          ref: string;
        };
        /** Pull request target branch identity. */
        base: {
          /** GitHub branch reference. */
          /** GitHub branch reference. */
          ref: string;
        };
        /** Browser URL for this GitHub record. */
        html_url: string;
      }>("pulls?state=open"),
    /** Lists blocking dependencies for a positive issue number; throws for invalid numbers and rejects incomplete reads. */
    blockers: (number: number) => {
      if (!Number.isSafeInteger(number) || number < 1)
        throw new IntegrationError("configuration", "Invalid issue number.");
      return collection<GitHubIssue>(
        `issues/${number}/dependencies/blocked_by`,
      );
    },
  };
}
/** Read-only GitHub REST issue representation; policy and incomplete-summary handling belong to the consumer. */
export interface GitHubIssue {
  /** GitHub issue or pull request number. */
  number: number;
  /** GitHub issue title. */
  title: string;
  /** GitHub Markdown body; null means no issue body was supplied. */
  body: string | null;
  /** GitHub issue state returned by the API. */
  state: string;
  /** Browser URL for this GitHub record. */
  html_url: string;
  /** Current GitHub labels; policy selection remains consumer-owned. */
  labels: Array<{
    /** GitHub label name. */
    /** GitHub label name. */
    name: string;
  }>;
  /** Current GitHub assignee accounts. */
  assignees: Array<{
    /** GitHub account login. */
    /** GitHub account login. */
    login: string;
  }>;
  /** Present for issue-list entries representing a pull request. */
  pull_request?: unknown;
  /** Optional GitHub dependency summary; absence is not evidence of no blockers. */
  issue_dependencies_summary?: {
    /** Reported blocking dependency count. */
    /** Reported blocking dependency count. */
    blocked_by: number;
  };
  /** Optional GitHub sub-issue summary. */
  sub_issues_summary?: {
    /** Reported sub-issue count. */
    /** Reported sub-issue count. */
    total: number;
  };
}

/** Finds an exact stable marker or creates one comment through explicit capabilities. List must cover all possible matches. Writes occur once; ambiguous matches and unreconciled write outcomes reject IntegrationError(uncertain). The reader above never supplies write capabilities. */
export function publishCommentOnce<
  T extends {
    /** Publication Markdown placed after the unique marker; only one create invocation is authorized. */
    /** Publication Markdown placed after the unique marker; only one create invocation is authorized. */
    body: string;
  },
>(
  options: {
    /** Stable unique single-line publication marker; reconciliation matches the complete line. */
    marker: string;
    /** Publication Markdown placed after the unique marker; only one create invocation is authorized. */
    body: string;
    /** Read capability returning all potentially matching publications; retries only classified transient read failures. */
    list: () => Promise<T[]>;
    /** Single write capability; uncertain outcomes are reconciled, never blindly written again. */
    create: (body: string) => Promise<T>;
  } & RetryOptions,
): Promise<T> {
  return runWorkflowEffect(publishCommentOnceProgram(options));
}

function publishCommentOnceProgram<T extends { body: string }>(
  options: {
    marker: string;
    body: string;
    list: () => Promise<T[]>;
    create: (body: string) => Promise<T>;
  } & RetryOptions,
) {
  return workflowProgram(
    Effect.gen(function* () {
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
      const existing = workflowValue(yield* workflowStep(() => find()));
      if (existing) return existing;
      options.signal?.throwIfAborted();
      try {
        return workflowValue(
          yield* workflowStep(() =>
            options.create(`${options.marker}\n${options.body}`),
          ),
        );
      } catch (cause) {
        let reconciled: T | undefined;
        try {
          reconciled = workflowValue(yield* workflowStep(() => find()));
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
    }),
  );
}

/** Durable preservation coordinates; retain the exact stash and original checkout identity until restoration succeeds. */
export interface WorktreeRecovery {
  /** Separate prepared Git worktree path; must belong to the same repository as the source. */
  prepared: string;
  /** Exact commit to restore after candidate validation. */
  originalHead: string;
  /** Original branch name, or empty for a detached checkout. */
  originalBranch: string;
  /** Exact immutable implementation identity covered by this value. */
  candidate: string;
  /** Stable unique single-line publication marker; reconciliation matches the complete line. */
  marker: string;
  /** Exact preservation stash commit; omitted when no work required stashing. */
  stash?: string;
  /** Durable preservation/restoration phase; restoration-required leaves the stash and prepared work for explicit recovery. */
  phase: "starting" | "preserved" | "restored" | "restoration-required";
}
/** Restoration failure carrying preserved work coordinates and the original validation/restoration cause. */
export class WorktreeRestorationError extends IntegrationError {
  /** Creates the public classified failure, retaining the original cause when supplied. */
  constructor(
    /** Exact retained worktree/stash recovery coordinates; do not discard them while restoration is unresolved. */
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

/** Preserves prepared-tree edits, runs action at the exact candidate, then restores the original checkout. The caller must serialize repository operations, durably save recovery states, and stop owned writers before restoration. Invalid/colliding checkouts reject before preservation. Action failures rethrow unchanged after successful restoration; restoration uncertainty rejects WorktreeRestorationError and retains recovery/stash coordinates. */
export function withPreparedWorktree<T>(
  options: {
    /** Source checkout path; tracked, untracked and staged source edits are preserved. */
    source: string;
    /** Separate prepared Git worktree path; must belong to the same repository as the source. */
    prepared: string;
    /** Exact immutable implementation identity covered by this value. */
    candidate: string;
    /** Explicit shell-free git/gh invocation capability; must honor supplied cancellation and report actual process exit/output. */
    command: Command;
    /** Must durably save each recovery state before resolving; failed saves stop unsafe progress. */
    saveRecovery: (state: WorktreeRecovery) => Promise<void>;
    /** A process owner must confirm all prepared-tree writers stopped before checkout or restoration. */
    quiescent?: () => boolean | Promise<boolean>;
  },
  action: (prepared: string) => Promise<T>,
): Promise<T> {
  return runWorkflowEffect(withPreparedWorktreeProgram(options, action));
}

function withPreparedWorktreeProgram<T>(
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
) {
  return workflowProgram(
    Effect.gen(function* () {
      if (
        options.quiescent &&
        !workflowValue(yield* workflowStep(() => options.quiescent!()))
      )
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
            new IntegrationInvariantFailure({ message: result.stderr }),
          );
        return result.stdout.trimEnd();
      };
      const source = workflowValue(
        yield* workflowStep(async () =>
          realpathSync(
            await git(options.source, "rev-parse", "--show-toplevel"),
          ),
        ),
      );
      const prepared = workflowValue(
        yield* workflowStep(async () =>
          realpathSync(
            await git(options.prepared, "rev-parse", "--show-toplevel"),
          ),
        ),
      );
      if (
        source === prepared ||
        prepared !==
          workflowValue(
            yield* workflowFile((fs) => fs.realpathSync(options.prepared)),
          ) ||
        workflowValue(
          yield* workflowStep(async () =>
            realpathSync(
              await git(
                source,
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
              ),
            ),
          ),
        ) !==
          workflowValue(
            yield* workflowStep(async () =>
              realpathSync(
                await git(
                  prepared,
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-common-dir",
                ),
              ),
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
      workflowValue(
        yield* workflowStep(() =>
          git(prepared, "cat-file", "-e", `${options.candidate}^{commit}`),
        ),
      );
      const untracked = workflowValue(
        yield* workflowStep(() =>
          git(prepared, "ls-files", "--others", "--exclude-standard", "-z"),
        ),
      )
        .split("\0")
        .filter(Boolean);
      const tracked = workflowValue(
        yield* workflowStep(() =>
          git(
            prepared,
            "ls-tree",
            "-r",
            "--name-only",
            "-z",
            options.candidate,
          ),
        ),
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
        originalHead: workflowValue(
          yield* workflowStep(() => git(prepared, "rev-parse", "HEAD")),
        ),
        originalBranch: workflowValue(
          yield* workflowStep(() => git(prepared, "branch", "--show-current")),
        ),
        marker: `sandcastle-preserve:${randomUUID()}`,
        phase: "starting",
      };
      workflowValue(
        yield* workflowStep(() =>
          options.saveRecovery(structuredClone(recovery)),
        ),
      );
      let result: T | undefined;
      let actionError: unknown;
      let failed = false;
      let preservationStarted = false;
      try {
        if (
          workflowValue(
            yield* workflowStep(() => git(prepared, "status", "--porcelain")),
          ).trim()
        ) {
          preservationStarted = true;
          workflowValue(
            yield* workflowStep(() =>
              git(
                prepared,
                "stash",
                "push",
                "--include-untracked",
                "--message",
                recovery.marker,
              ),
            ),
          );
          const entry = workflowValue(
            yield* workflowStep(() =>
              git(prepared, "stash", "list", "--format=%H%x00%gs"),
            ),
          )
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
        workflowValue(
          yield* workflowStep(() =>
            options.saveRecovery(structuredClone(recovery)),
          ),
        );
        workflowValue(
          yield* workflowStep(() =>
            git(
              prepared,
              "checkout",
              "--no-overwrite-ignore",
              "--detach",
              options.candidate,
            ),
          ),
        );
        result = workflowValue(yield* workflowStep(() => action(prepared)));
      } catch (cause) {
        failed = true;
        actionError = cause;
      }
      try {
        if (
          options.quiescent &&
          !workflowValue(yield* workflowStep(() => options.quiescent!()))
        )
          throw new IntegrationInvariantFailure({
            message:
              "Owned processes may still write this prepared checkout; restoration requires explicit quiescence reconciliation.",
          });
        if (
          (preservationStarted && !recovery.stash) ||
          workflowValue(
            yield* workflowStep(() => git(prepared, "status", "--porcelain")),
          ).trim()
        )
          throw new IntegrationInvariantFailure({
            message:
              "Uncertain preservation or new work prevents safe restoration; inspect the recorded stash marker and worktree.",
          });
        if (recovery.originalBranch) {
          if (
            workflowValue(
              yield* workflowStep(() =>
                git(
                  prepared,
                  "rev-parse",
                  `refs/heads/${recovery.originalBranch}`,
                ),
              ),
            ) !== recovery.originalHead
          )
            throw new IntegrationInvariantFailure({
              message: "Original branch moved during validation.",
            });
          workflowValue(
            yield* workflowStep(() =>
              git(
                prepared,
                "checkout",
                "--no-overwrite-ignore",
                recovery.originalBranch,
              ),
            ),
          );
        } else
          workflowValue(
            yield* workflowStep(() =>
              git(
                prepared,
                "checkout",
                "--no-overwrite-ignore",
                "--detach",
                recovery.originalHead,
              ),
            ),
          );
        if (recovery.stash)
          workflowValue(
            yield* workflowStep(() =>
              git(prepared, "stash", "apply", "--index", recovery.stash!),
            ),
          );
        recovery.phase = "restored";
        workflowValue(
          yield* workflowStep(() =>
            options.saveRecovery(structuredClone(recovery)),
          ),
        );
      } catch (cause) {
        recovery.phase = "restoration-required";
        try {
          workflowValue(
            yield* workflowStep(() =>
              options.saveRecovery(structuredClone(recovery)),
            ),
          );
        } catch {}
        throw new WorktreeRestorationError(
          recovery,
          failed ? new AggregateError([actionError, cause]) : cause,
        );
      }
      if (failed) throw actionError;
      return result as T;
    }),
  );
}
