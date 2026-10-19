import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { windowsSupervisor } from "./workflow-process-supervisor.js";

/** A failed command boundary; quiescent=false forbids restoring or releasing owned resources. */
export class OwnedProcessError extends Error {
  /** Classifies confirmed cancellation, timeout, invalid configuration, or unknown ownership. */
  readonly kind: "cancelled" | "timeout" | "configuration" | "uncertain";
  /** True only after this boundary has confirmed that no owned child can execute. */
  readonly quiescent: boolean;
  /** Authoritative durable receipt, when an operation was created. */
  readonly record?: string;
  constructor(
    kind: OwnedProcessError["kind"],
    message: string,
    quiescent: boolean,
    record?: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "OwnedProcessError";
    this.kind = kind;
    this.quiescent = quiescent;
    this.record = record;
  }
}
/** One explicit executable invocation; arguments are never interpreted by a shell. */
export interface OwnedProcessCommand {
  /** Absolute executable path. */ readonly executable: string;
  /** Literal command arguments. */ readonly args: readonly string[];
  /** Absolute working directory. */ readonly cwd: string;
  /** Cancellation stops and accounts for the entire owned job before rejecting. */ readonly signal?: AbortSignal;
  /** Positive, bounded watchdog deadline including startup, in milliseconds. */ readonly timeoutMs: number;
  /** Completion waits for the whole tree by default; primary stops remaining descendants after the primary exits. */ readonly completion?:
    | "tree"
    | "primary";
}
/** Durable process receipt; no child runs until its assigned job identity is saved. */
export interface OwnedProcessRecord {
  /** Receipt format version. */ version: 1;
  /** Unique operation identity. */ id: string;
  /** Parent owner identity; a live owner may still authorize its supervisor. */ ownerPid: number;
  /** Named Windows job, never reused for another operation. */ jobName: string;
  /** Current durable lifecycle state. */ state:
    | "intent"
    | "supervisor"
    | "owned"
    | "completed"
    | "unknown"
    | "reconciled";
  /** Supervisor identity checked during read-only reconciliation. */ supervisorPid?: number;
  /** Exact supervisor process start time, as a string to preserve precision. */ supervisorStart?: string;
  /** Suspended child identity, before execution was authorized. */ childPid?: number;
  /** Whether this receipt confirms the whole job has stopped. */ quiescent: boolean;
  /** Terminal child exit, when known. */ exitCode?: number;
  /** Terminal outcome, when known. */ reason?: string;
  /** ISO timestamp of latest durable state transition. */ updated: string;
}
/** A completed command, including ordinary nonzero child exits. */
export interface OwnedProcessResult {
  /** Captured child stdout, also retained beside the receipt. */ stdout: string;
  /** Captured child stderr, also retained beside the receipt. */ stderr: string;
  /** Actual child exit status. */ exitCode: number;
  /** Authoritative durable receipt path. */ record: string;
  /** Confirms all processes in this operation's job have stopped. */ quiescent: true;
}
/** Long-lived ownership boundary for a single caller-owned resource directory. */
export interface OwnedProcessRunner {
  /** Runs one command; unresolved earlier operations prevent replay. */ run(
    command: OwnedProcessCommand,
  ): Promise<OwnedProcessResult>;
  /** False during an operation and after an unknown outcome, including after reload. */ isQuiescent(): boolean;
  /** Throws while active or unknown; call before restoring/releasing prepared resources. */ assertQuiescent(): void;
  /** Explicit read-only observation of recorded jobs; never kills processes or retries commands. */ reconcile(): Promise<boolean>;
}
/** Configuration for an explicit host process boundary. */
export interface OwnedProcessOptions {
  /** Caller-owned project/run scoped directory for durable receipts and output artifacts. */ directory: string;
  /** Absolute PowerShell 7 executable on Windows; no tool or credential discovery occurs. */ windowsPowerShell?: string;
  /** Optional durable observer. The primary receipt is saved before invoking this observer. */ save?: (
    record: OwnedProcessRecord,
  ) => Promise<void>;
}
class ProcessBoundaryFailure extends Data.TaggedError(
  "ProcessBoundaryFailure",
)<{ readonly failure: OwnedProcessError }> {}
function boundary<T>(action: () => Promise<T>): Promise<T> {
  return Effect.tryPromise({
    try: action,
    catch: (cause) =>
      new ProcessBoundaryFailure({
        failure:
          cause instanceof OwnedProcessError
            ? cause
            : new OwnedProcessError(
                "uncertain",
                "Owned process boundary failed without confirmed cleanup.",
                false,
                undefined,
                cause,
              ),
      }),
  })
    .pipe(Effect.either, Effect.runPromise)
    .then((result) => {
      if (result._tag === "Left") throw result.left.failure;
      return result.right;
    });
}
function atomic(path: string, value: unknown) {
  const temporary = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
type Event = {
  type: string;
  supervisorPid?: number;
  supervisorStart?: string;
  childPid?: number;
  quiescent?: boolean;
  exitCode?: number;
  reason?: string;
  message?: string;
};

/** Creates a fail-closed Windows JobObject owner. Other hosts reject before launching commands. */
export function createOwnedProcessRunner(
  options: OwnedProcessOptions,
): OwnedProcessRunner {
  const directory = resolve(options.directory);
  if (!isAbsolute(options.directory))
    throw new OwnedProcessError(
      "configuration",
      "Owned process directory must be absolute.",
      true,
    );
  mkdirSync(directory, { recursive: true });
  let active = false;
  function receipts(): Array<{ path: string; value: OwnedProcessRecord }> {
    return readdirSync(directory)
      .filter((name) => /^operation-[a-f0-9-]+\.json$/.test(name))
      .map((name) => {
        const path = join(directory, name);
        const value = JSON.parse(
          readFileSync(path, "utf8"),
        ) as OwnedProcessRecord;
        if (
          value.version !== 1 ||
          !value.id ||
          value.jobName !== `SandcastleOwned-${value.id}` ||
          ![
            "intent",
            "supervisor",
            "owned",
            "completed",
            "unknown",
            "reconciled",
          ].includes(value.state) ||
          typeof value.quiescent !== "boolean"
        )
          throw new OwnedProcessError(
            "uncertain",
            "Unrecognized owned-process receipt.",
            false,
            path,
          );
        return { path, value };
      });
  }
  const quiet = () => {
    try {
      return !active && receipts().every(({ value }) => value.quiescent);
    } catch {
      return false;
    }
  };
  function configured() {
    if (process.platform !== "win32")
      throw new OwnedProcessError(
        "configuration",
        "Owned process groups are unsupported on this host; no command was launched.",
        quiet(),
      );
    if (
      !options.windowsPowerShell ||
      !isAbsolute(options.windowsPowerShell) ||
      !existsSync(options.windowsPowerShell)
    )
      throw new OwnedProcessError(
        "configuration",
        "An explicit absolute PowerShell 7 executable is required.",
        quiet(),
      );
    return options.windowsPowerShell;
  }
  async function save(path: string, value: OwnedProcessRecord) {
    value.updated = new Date().toISOString();
    atomic(path, value);
    await options.save?.(structuredClone(value));
  }
  function supervise(
    configPath: string,
    onEvent: (event: Event, write: (line: string) => void) => Promise<void>,
    command?: OwnedProcessCommand,
  ): Promise<{ event: Event; failure?: unknown }> {
    const script = join(directory, "supervisor-v1.ps1");
    writeFileSync(script, windowsSupervisor);
    return new Promise((fulfill, reject) => {
      const child = spawn(
        configured(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          script,
          configPath,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let buffer = "",
        diagnostics = "",
        terminal: Event | undefined,
        failure: unknown,
        chain = Promise.resolve(),
        closed = false;
      const write = (line: string) => {
        if (!closed && !child.stdin.destroyed) child.stdin.write(line + "\n");
      };
      child.stdin.on("error", () => {});
      const abort = () => write("stop");
      command?.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(
        () => write("stop"),
        command?.timeoutMs ?? 30000,
      );
      const watchdog = setTimeout(
        () => {
          failure ??= new OwnedProcessError(
            "uncertain",
            "Supervisor did not confirm process-tree cleanup.",
            false,
          );
          child.kill();
        },
        (command?.timeoutMs ?? 30000) + 30000,
      );
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          chain = chain.then(async () => {
            try {
              const event = JSON.parse(line) as Event;
              if (
                event.type === "done" ||
                event.type === "failed" ||
                event.type === "observed"
              ) {
                terminal = event;
                child.stdin.end();
              }
              await onEvent(event, write);
            } catch (error) {
              failure ??= error;
              write("stop");
              child.stdin.end();
            }
          });
        }
      });
      child.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-16000);
      });
      child.on("error", (error) => {
        failure ??= error;
      });
      child.on("close", () => {
        closed = true;
        clearTimeout(timeout);
        clearTimeout(watchdog);
        command?.signal?.removeEventListener("abort", abort);
        // A caller's receipt observer may never settle. Once the supervisor is
        // gone, retain unknown ownership rather than hanging its resource owner.
        let drained = false;
        let observerDeadline: ReturnType<typeof setTimeout>;
        const deadline = new Promise<void>((resolveDeadline) => {
          observerDeadline = setTimeout(resolveDeadline, 1000);
        });
        void Promise.race([
          chain.then(() => {
            drained = true;
          }),
          deadline,
        ])
          .then(() => {
            if (!drained || !terminal)
              reject(
                new OwnedProcessError(
                  "uncertain",
                  `Supervisor exited without a durable quiescence acknowledgment. ${diagnostics}`,
                  false,
                  undefined,
                  failure,
                ),
              );
            else fulfill({ event: terminal, failure });
          }, reject)
          .finally(() => clearTimeout(observerDeadline));
      });
    });
  }
  return {
    isQuiescent: quiet,
    assertQuiescent() {
      if (!quiet())
        throw new OwnedProcessError(
          "uncertain",
          "Owned processes remain active or unresolved; preserve resources and lock.",
          false,
        );
    },
    run(command) {
      return boundary(async () => {
        if (!quiet())
          throw new OwnedProcessError(
            "uncertain",
            "An earlier operation remains unresolved; reconcile before another command.",
            false,
          );
        configured();
        if (
          !isAbsolute(command.executable) ||
          !isAbsolute(command.cwd) ||
          !existsSync(command.executable) ||
          !Number.isInteger(command.timeoutMs) ||
          command.timeoutMs < 1 ||
          command.timeoutMs > 2147400000 ||
          (command.completion !== undefined &&
            command.completion !== "tree" &&
            command.completion !== "primary") ||
          command.args.some(
            (arg) => typeof arg !== "string" || arg.includes("\0"),
          )
        )
          throw new OwnedProcessError(
            "configuration",
            "Absolute executable/cwd, literal arguments, positive bounded timeout and tree/primary completion are required.",
            true,
          );
        if (command.signal?.aborted)
          throw new OwnedProcessError(
            "cancelled",
            "Command cancelled before process creation.",
            true,
          );
        active = true;
        const id = randomUUID(),
          record = join(directory, `operation-${id}.json`),
          stdout = join(directory, `${id}.stdout`),
          stderr = join(directory, `${id}.stderr`);
        const value: OwnedProcessRecord = {
          version: 1,
          id,
          ownerPid: process.pid,
          jobName: `SandcastleOwned-${id}`,
          state: "intent",
          quiescent: false,
          updated: new Date().toISOString(),
        };
        let observedQuiet = false,
          launched = false;
        try {
          await save(record, value);
          const config = join(directory, `${id}.config.json`);
          atomic(config, {
            mode: "run",
            jobName: value.jobName,
            executable: command.executable,
            args: command.args,
            cwd: command.cwd,
            timeoutMs: command.timeoutMs,
            completion: command.completion ?? "tree",
            stdout,
            stderr,
          });
          launched = true;
          const { event, failure } = await supervise(
            config,
            async (event, write) => {
              if (event.type === "identity") {
                value.supervisorPid = event.supervisorPid;
                value.supervisorStart = event.supervisorStart;
                value.state = "supervisor";
                await save(record, value);
                write(command.signal?.aborted ? "stop" : "prepare");
              } else if (event.type === "owned") {
                value.childPid = event.childPid;
                value.state = "owned";
                await save(record, value);
                write(command.signal?.aborted ? "stop" : "go");
              }
            },
            command,
          );
          observedQuiet = event.quiescent === true;
          value.quiescent = observedQuiet;
          value.state = observedQuiet ? "completed" : "unknown";
          value.exitCode = event.exitCode;
          value.reason = event.reason ?? event.message;
          await save(record, value);
          if (!observedQuiet)
            throw new OwnedProcessError(
              "uncertain",
              "Supervisor could not confirm the owned process tree stopped.",
              false,
              record,
              failure,
            );
          if (failure || event.type === "failed")
            throw new OwnedProcessError(
              "configuration",
              event.message ??
                "Process receipt observer failed; owned processes were stopped.",
              true,
              record,
              failure,
            );
          if (event.reason !== "completed")
            throw new OwnedProcessError(
              command.signal?.aborted ? "cancelled" : "timeout",
              "Owned process tree stopped after cancellation or timeout.",
              true,
              record,
            );
          return {
            stdout: existsSync(stdout) ? readFileSync(stdout, "utf8") : "",
            stderr: existsSync(stderr) ? readFileSync(stderr, "utf8") : "",
            exitCode: event.exitCode!,
            record,
            quiescent: true,
          };
        } catch (cause) {
          if (!launched) {
            observedQuiet = true;
            value.state = "completed";
            value.quiescent = true;
            try {
              atomic(record, value);
            } catch {
              observedQuiet = false;
            }
          }
          if (!observedQuiet) {
            value.state = "unknown";
            value.quiescent = false;
            try {
              atomic(record, value);
            } catch {
              /* The previous intent remains unresolved. */
            }
          }
          throw cause instanceof OwnedProcessError
            ? new OwnedProcessError(
                cause.kind,
                cause.message,
                observedQuiet,
                record,
                cause,
              )
            : new OwnedProcessError(
                observedQuiet ? "configuration" : "uncertain",
                "Owned process invocation failed.",
                observedQuiet,
                record,
                cause,
              );
        } finally {
          active = false;
        }
      });
    },
    reconcile() {
      return boundary(async () => {
        if (active) return false;
        configured();
        for (const { path, value } of receipts()) {
          if (value.quiescent) continue;
          if (
            value.supervisorPid === undefined &&
            value.supervisorStart === undefined
          ) {
            if (!Number.isInteger(value.ownerPid) || value.ownerPid < 1)
              return false;
            try {
              process.kill(value.ownerPid, 0);
              return false;
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
                return false;
            }
            value.state = "reconciled";
            value.quiescent = true;
            await save(path, value);
            continue;
          }
          if (
            !Number.isInteger(value.supervisorPid) ||
            typeof value.supervisorStart !== "string"
          )
            return false;
          const config = join(directory, `${value.id}.observe.json`);
          atomic(config, {
            mode: "observe",
            jobName: value.jobName,
            supervisorPid: value.supervisorPid,
            supervisorStart: value.supervisorStart,
          });
          const { event, failure } = await supervise(config, async () => {});
          if (failure || event.type !== "observed" || event.quiescent !== true)
            return false;
          value.state = "reconciled";
          value.quiescent = true;
          await save(path, value);
        }
        return quiet();
      });
    },
  };
}
