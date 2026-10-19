import { afterEach, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createOwnedProcessRunner } from "./workflow-process.js";
import type { OwnedProcessCommand } from "./workflow-process.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const actual = realpathSync(root);
    expect(actual.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    expect(basename(actual).startsWith("sandcastle-process-")).toBe(true);
    rmSync(actual, { recursive: true, force: true });
  }
});
const windowsPowerShell =
  process.platform === "win32"
    ? execFileSync(
        "pwsh.exe",
        ["-NoProfile", "-Command", "(Get-Process -Id $PID).Path"],
        { encoding: "utf8", windowsHide: true },
      ).trim()
    : undefined;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-process-"));
  roots.push(directory);
  return {
    directory,
    runner: createOwnedProcessRunner({ directory, windowsPowerShell }),
  };
}

it.runIf(process.platform === "win32")(
  "records an owned job in the global namespace where a session-local lookup cannot substitute for it",
  async () => {
    const { directory } = fixture();
    const query = join(directory, "query-job.ps1");
    writeFileSync(
      query,
      String.raw`
param([string]$Name)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class JobQuery {
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Active(string name) {
    var job=OpenJobObject(4,false,name);
    if(job==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(error==2) return -1; throw new Win32Exception(error); }
    try { Accounting value; if(!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf<Accounting>(),IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error()); return (int)value.Active; }
    finally { CloseHandle(job); }
  }
}
'@
@{global=[JobQuery]::Active($Name);local=[JobQuery]::Active($Name.Replace('Global\','Local\'))} | ConvertTo-Json -Compress
`,
    );
    let observation: unknown;
    let name: string | undefined;
    const runner = createOwnedProcessRunner({
      directory,
      windowsPowerShell,
      save: async (record) => {
        if (record.state === "owned") {
          name = record.jobName;
          observation = JSON.parse(
            execFileSync(
              windowsPowerShell!,
              [
                "-NoProfile",
                "-File",
                query,
                `Global\\SandcastleOwned-${record.id}`,
              ],
              { encoding: "utf8", windowsHide: true },
            ),
          );
        }
      },
    });
    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.exitCode=7"],
      cwd: directory,
      timeoutMs: 15000,
    });
    expect(result).toMatchObject({ exitCode: 7, quiescent: true });
    expect(observation).toEqual({ global: 1, local: -1 });
    expect(name).toMatch(/^Global\\SandcastleOwned-/);
    runner.assertQuiescent();
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "captures a real command's output and nonzero exit only after owned processes stop",
  async () => {
    const { directory, runner } = fixture();
    const result = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        "console.log('a b \\\"quoted\\\"');console.error('diagnostic');process.exitCode=7",
      ],
      cwd: directory,
      timeoutMs: 15000,
    });
    expect(result).toMatchObject({
      stdout: 'a b "quoted"\n',
      stderr: "diagnostic\n",
      exitCode: 7,
      quiescent: true,
    });
    expect(runner.isQuiescent()).toBe(true);
    expect(() => runner.assertQuiescent()).not.toThrow();
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "legacy unresolved jobs cannot be cleared by absence in an unproven session namespace",
  async () => {
    const { directory, runner } = fixture();
    const command = {
      executable: process.execPath,
      args: ["-e", "process.exitCode=7"],
      cwd: directory,
      timeoutMs: 15000,
    };
    const result = await runner.run(command);
    const legacy = JSON.parse(readFileSync(result.record, "utf8"));
    legacy.jobName = `SandcastleOwned-${legacy.id}`;
    legacy.quiescent = false;
    for (const state of ["supervisor", "owned", "unknown"]) {
      legacy.state = state;
      const receipt = JSON.stringify(legacy);
      writeFileSync(result.record, receipt);
      const reloaded = createOwnedProcessRunner({
        directory,
        windowsPowerShell,
      });
      expect(await reloaded.reconcile()).toBe(false);
      expect(reloaded.isQuiescent()).toBe(false);
      expect(() => reloaded.assertQuiescent()).toThrow();
      await expect(reloaded.run(command)).rejects.toMatchObject({
        kind: "uncertain",
        quiescent: false,
      });
      expect(readFileSync(result.record, "utf8")).toBe(receipt);
    }
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "legacy intent without creation authorization can reconcile only after its owner is gone",
  async () => {
    const { directory, runner } = fixture();
    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.exitCode=7"],
      cwd: directory,
      timeoutMs: 15000,
    });
    const legacy = JSON.parse(readFileSync(result.record, "utf8"));
    legacy.jobName = `SandcastleOwned-${legacy.id}`;
    const deadOwner = legacy.supervisorPid;
    delete legacy.supervisorPid;
    delete legacy.supervisorStart;
    delete legacy.childPid;
    legacy.state = "intent";
    legacy.quiescent = false;
    writeFileSync(result.record, JSON.stringify(legacy));
    const reloaded = createOwnedProcessRunner({ directory, windowsPowerShell });
    expect(await reloaded.reconcile()).toBe(false);
    expect(reloaded.isQuiescent()).toBe(false);
    legacy.ownerPid = deadOwner;
    writeFileSync(result.record, JSON.stringify(legacy));
    expect(await reloaded.reconcile()).toBe(true);
    expect(
      createOwnedProcessRunner({ directory, windowsPowerShell }).isQuiescent(),
    ).toBe(true);
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "legacy completed receipts allow reuse but legacy namespace-only reconciliation does not",
  async () => {
    const { directory, runner } = fixture();
    const command = {
      executable: process.execPath,
      args: ["-e", "process.exitCode=7"],
      cwd: directory,
      timeoutMs: 15000,
    };
    const result = await runner.run(command);
    const legacy = JSON.parse(readFileSync(result.record, "utf8"));
    legacy.jobName = `SandcastleOwned-${legacy.id}`;
    const completedReceipt = JSON.stringify(legacy);
    writeFileSync(result.record, completedReceipt);
    const reloaded = createOwnedProcessRunner({ directory, windowsPowerShell });
    expect(reloaded.isQuiescent()).toBe(true);
    expect(await reloaded.reconcile()).toBe(true);
    expect((await reloaded.run(command)).exitCode).toBe(7);
    expect(readFileSync(result.record, "utf8")).toBe(completedReceipt);

    legacy.state = "reconciled";
    const reconciledReceipt = JSON.stringify(legacy);
    writeFileSync(result.record, reconciledReceipt);
    expect(reloaded.isQuiescent()).toBe(false);
    expect(await reloaded.reconcile()).toBe(false);
    expect(() => reloaded.assertQuiescent()).toThrow();
    await expect(reloaded.run(command)).rejects.toMatchObject({
      kind: "uncertain",
      quiescent: false,
    });
    expect(readFileSync(result.record, "utf8")).toBe(reconciledReceipt);
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "malformed owned receipts without supervisor identity cannot become uncreated intents",
  async () => {
    const { directory, runner } = fixture();
    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.exitCode=7"],
      cwd: directory,
      timeoutMs: 15000,
    });
    const legacy = JSON.parse(readFileSync(result.record, "utf8"));
    legacy.jobName = `SandcastleOwned-${legacy.id}`;
    legacy.ownerPid = legacy.supervisorPid;
    delete legacy.supervisorPid;
    delete legacy.supervisorStart;
    legacy.state = "owned";
    legacy.quiescent = false;
    const receipt = JSON.stringify(legacy);
    writeFileSync(result.record, receipt);
    const reloaded = createOwnedProcessRunner({ directory, windowsPowerShell });
    expect(await reloaded.reconcile()).toBe(false);
    expect(reloaded.isQuiescent()).toBe(false);
    expect(readFileSync(result.record, "utf8")).toBe(receipt);
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "abort stops a real grandchild before prepared resources can be restored",
  async () => {
    const { directory, runner } = fixture();
    const marker = join(directory, "heartbeat.txt");
    const controller = new AbortController();
    const grandchild = join(directory, "grandchild.cjs");
    writeFileSync(
      grandchild,
      `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[2],'x'),20);`,
    );
    const operation = runner.run({
      executable: process.execPath,
      args: [
        "-e",
        `require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)},${JSON.stringify(marker)}],{stdio:'ignore'});setInterval(()=>{},1000)`,
      ],
      cwd: directory,
      timeoutMs: 15000,
      signal: controller.signal,
    });
    while (!existsSync(marker)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runner.isQuiescent()).toBe(false);
    controller.abort();
    await expect(operation).rejects.toMatchObject({
      kind: "cancelled",
      quiescent: true,
    });
    runner.assertQuiescent();
    const stopped = readFileSync(marker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(marker, "utf8")).toBe(stopped);
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "timeout stops every owned descendant before returning confirmed quiescence",
  async () => {
    const { directory, runner } = fixture();
    const marker = join(directory, "timed-heartbeat.txt");
    const grandchild = join(directory, "timed-grandchild.cjs");
    writeFileSync(
      grandchild,
      `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[2],'x'),20);`,
    );
    await expect(
      runner.run({
        executable: process.execPath,
        args: [
          "-e",
          `require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)},${JSON.stringify(marker)}],{stdio:'ignore'});setInterval(()=>{},1000)`,
        ],
        cwd: directory,
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ kind: "timeout", quiescent: true });
    expect(existsSync(marker)).toBe(true);
    const stopped = readFileSync(marker, "utf8");
    runner.assertQuiescent();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(marker, "utf8")).toBe(stopped);
  },
  20000,
);

it.runIf(process.platform === "win32")(
  "lost supervisor remains unknown after reload until explicit read-only job reconciliation",
  async () => {
    const { directory, runner } = fixture();
    const marker = join(directory, "lost-supervisor-heartbeat.txt");
    const grandchild = join(directory, "lost-grandchild.cjs");
    writeFileSync(
      grandchild,
      `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[2],'x'),20);`,
    );
    const code = `const fs=require('node:fs'),path=require('node:path');require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)},${JSON.stringify(marker)}],{stdio:'ignore'});const check=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){const receipt=JSON.parse(fs.readFileSync(path.join(process.cwd(),fs.readdirSync(process.cwd()).find(n=>n.startsWith('operation-')&&n.endsWith('.json')))));process.kill(receipt.supervisorPid);clearInterval(check);}},20);`;
    await expect(
      runner.run({
        executable: process.execPath,
        args: ["-e", code],
        cwd: directory,
        timeoutMs: 15000,
      }),
    ).rejects.toMatchObject({ kind: "uncertain", quiescent: false });
    const reloaded = createOwnedProcessRunner({ directory, windowsPowerShell });
    expect(reloaded.isQuiescent()).toBe(false);
    expect(() => reloaded.assertQuiescent()).toThrow();
    await expect(
      reloaded.run({
        executable: process.execPath,
        args: ["-e", "console.log('must not replay')"],
        cwd: directory,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "uncertain", quiescent: false });
    expect(await reloaded.reconcile()).toBe(true);
    const stopped = readFileSync(marker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(marker, "utf8")).toBe(stopped);
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "failed receipt observer stops the assigned suspended child before it can execute",
  async () => {
    const { directory } = fixture();
    const marker = join(directory, "must-not-execute");
    const runner = createOwnedProcessRunner({
      directory,
      windowsPowerShell,
      save: async (record) => {
        if (record.state === "owned")
          throw new Error("disk observer unavailable");
      },
    });
    await expect(
      runner.run({
        executable: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`,
        ],
        cwd: directory,
        timeoutMs: 15000,
      }),
    ).rejects.toMatchObject({ kind: "configuration", quiescent: true });
    expect(existsSync(marker)).toBe(false);
    expect(
      createOwnedProcessRunner({ directory, windowsPowerShell }).isQuiescent(),
    ).toBe(true);
  },
  25000,
);

it.runIf(process.platform !== "win32")(
  "unsupported hosts reject before launching an unowned command",
  async () => {
    const { directory, runner } = fixture();
    await expect(
      runner.run({
        executable: process.execPath,
        args: ["-e", "process.exit(42)"],
        cwd: directory,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "configuration", quiescent: true });
    expect(runner.isQuiescent()).toBe(true);
  },
);

it.runIf(process.platform === "win32")(
  "parent process loss closes the control pipe and stops the descendant job",
  async () => {
    const { directory } = fixture();
    const marker = join(directory, "parent-loss-heartbeat");
    const grandchild = join(directory, "parent-loss-grandchild.cjs");
    writeFileSync(
      grandchild,
      `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[2],'x'),20);`,
    );
    const worker = join(directory, "owner.mjs");
    const module = pathToFileURL(
      join(process.cwd(), "src/workflow-process.ts"),
    ).href;
    const childCode = `require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)},${JSON.stringify(marker)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    writeFileSync(
      worker,
      `import {createOwnedProcessRunner} from ${JSON.stringify(module)};await createOwnedProcessRunner({directory:${JSON.stringify(directory)},windowsPowerShell:${JSON.stringify(windowsPowerShell)}}).run({executable:process.execPath,args:['-e',${JSON.stringify(childCode)}],cwd:${JSON.stringify(directory)},timeoutMs:15000});`,
    );
    const owner = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
        worker,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const ownerClosed = new Promise<void>((resolve) =>
      owner.once("close", () => resolve()),
    );
    const deadline = Date.now() + 10000;
    while (!existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    owner.kill();
    await ownerClosed;
    expect(existsSync(marker)).toBe(true);
    const reloaded = createOwnedProcessRunner({ directory, windowsPowerShell });
    expect(reloaded.isQuiescent()).toBe(false);
    let reconciled = false;
    for (let attempt = 0; attempt < 4 && !reconciled; attempt++) {
      reconciled = await reloaded.reconcile();
      if (!reconciled) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(reconciled).toBe(true);
    const stopped = readFileSync(marker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(marker, "utf8")).toBe(stopped);
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "reload cannot declare an operation quiet while its owner is still preparing it",
  async () => {
    const { directory } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intent!: () => void;
    const saved = new Promise<void>((resolve) => {
      intent = resolve;
    });
    const owner = createOwnedProcessRunner({
      directory,
      windowsPowerShell,
      save: async (record) => {
        if (record.state === "intent") {
          intent();
          await gate;
        }
      },
    });
    const operation = owner.run({
      executable: process.execPath,
      args: ["-e", "console.log('done')"],
      cwd: directory,
      timeoutMs: 15000,
    });
    await saved;
    try {
      const reloaded = createOwnedProcessRunner({
        directory,
        windowsPowerShell,
      });
      expect(await reloaded.reconcile()).toBe(false);
    } finally {
      release();
      await operation;
    }
  },
  25000,
);

it.runIf(process.platform === "win32")(
  "unresponsive receipt observer cannot prevent a bounded unknown outcome after supervisor stops",
  async () => {
    const { directory } = fixture();
    const runner = createOwnedProcessRunner({
      directory,
      windowsPowerShell,
      save: async (record) => {
        if (record.state === "supervisor") await new Promise(() => {});
      },
    });
    await expect(
      runner.run({
        executable: process.execPath,
        args: ["-e", "console.log('must not execute')"],
        cwd: directory,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "uncertain", quiescent: false });
    expect(runner.isQuiescent()).toBe(false);
  },
  12000,
);

it.runIf(process.platform === "win32")(
  "default completion waits for descendants after the primary exits",
  async () => {
    const { directory, runner } = fixture();
    const marker = join(directory, "tree-completion");
    const grandchild = join(directory, "tree-completion-grandchild.cjs");
    writeFileSync(
      grandchild,
      `const fs=require('node:fs');fs.writeFileSync(process.argv[2],'started');setTimeout(()=>fs.appendFileSync(process.argv[2],' finished'),400);`,
    );
    const code = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)},${JSON.stringify(marker)}],{stdio:'ignore',detached:true}).unref();const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(wait);process.exitCode=17;}},20);`;
    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", code],
      cwd: directory,
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ exitCode: 17, quiescent: true });
    expect(readFileSync(marker, "utf8")).toBe("started finished");
    runner.assertQuiescent();
  },
  15000,
);

it.runIf(process.platform === "win32")(
  "primary completion stops lingering descendants and preserves the primary's nonzero exit",
  async () => {
    const { directory, runner } = fixture();
    const marker = join(directory, "primary-completion-heartbeat");
    const grandchild = join(directory, "primary-completion-grandchild.cjs");
    writeFileSync(
      grandchild,
      `const fs=require('node:fs');fs.appendFileSync(process.argv[2],'started');setInterval(()=>fs.appendFileSync(process.argv[2],'x'),20);`,
    );
    const code = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)},${JSON.stringify(marker)}],{stdio:'ignore',detached:true}).unref();const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(wait);console.log('primary completed');process.exitCode=23;}},20);`;
    const command: OwnedProcessCommand = {
      executable: process.execPath,
      args: ["-e", code],
      cwd: directory,
      timeoutMs: 5000,
      completion: "primary",
    };
    const result = await runner.run(command);
    expect(result).toMatchObject({
      exitCode: 23,
      stdout: "primary completed\n",
      quiescent: true,
    });
    expect(existsSync(marker)).toBe(true);
    runner.assertQuiescent();
    const stopped = readFileSync(marker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(marker, "utf8")).toBe(stopped);
  },
  15000,
);
