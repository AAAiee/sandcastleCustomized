import assert from "node:assert/strict";
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

const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const specifier = flag("--module");
assert(
  specifier?.endsWith("/workflow/process"),
  "Pass an installed package's public process export via --module",
);
const { createOwnedProcessRunner } = await import(specifier);
const directory = mkdtempSync(join(tmpdir(), "sandcastle-process-consumer-"));
const runner = createOwnedProcessRunner({
  directory,
  windowsPowerShell: flag("--pwsh"),
});
try {
  if (process.platform !== "win32") {
    await assert.rejects(
      runner.run({
        executable: process.execPath,
        args: ["-e", "process.exit(42)"],
        cwd: directory,
        timeoutMs: 1000,
      }),
      { kind: "configuration", quiescent: true },
    );
    console.log(
      "PASS: installed public process export rejects unsupported host before launch",
    );
  } else {
    const normal = await runner.run({
      executable: process.execPath,
      args: ["-e", "console.log('installed export');process.exitCode=9"],
      cwd: directory,
      timeoutMs: 15000,
    });
    assert.equal(normal.exitCode, 9);
    assert.match(normal.stdout, /installed export/);
    const completedRecord = JSON.parse(readFileSync(normal.record, "utf8"));
    assert.equal(completedRecord.quiescent, true);
    assert.equal(
      completedRecord.jobName,
      `Global\\SandcastleOwned-${completedRecord.id}`,
    );
    const marker = join(directory, "heartbeat"),
      grandchild = join(directory, "grandchild.cjs");
    writeFileSync(
      grandchild,
      "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[2],'x'),20);",
    );
    const controller = new AbortController();
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
    const rejection = assert.rejects(operation, {
      kind: "cancelled",
      quiescent: true,
    });
    const deadline = Date.now() + 12000;
    while (!existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await rejection;
    assert(
      existsSync(marker),
      "The real grandchild must have executed before cancellation",
    );
    runner.assertQuiescent();
    const stopped = readFileSync(marker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(readFileSync(marker, "utf8"), stopped);
    console.log(
      "PASS: installed public process export stops child/grandchild before resource restoration",
    );
    const primaryMarker = join(directory, "primary-heartbeat");
    const primary = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,[${JSON.stringify(grandchild)},${JSON.stringify(primaryMarker)}],{stdio:'ignore',detached:true}).unref();const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(primaryMarker)})){clearInterval(wait);process.exitCode=23;}},20);`,
      ],
      cwd: directory,
      timeoutMs: 15000,
      completion: "primary",
    });
    assert.equal(primary.exitCode, 23);
    assert.equal(primary.quiescent, true);
    assert.equal(JSON.parse(readFileSync(primary.record, "utf8")).exitCode, 23);
    runner.assertQuiescent();
    const primaryStopped = readFileSync(primaryMarker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(readFileSync(primaryMarker, "utf8"), primaryStopped);
    console.log(
      "PASS: installed primary completion preserves nonzero exit and stops remaining descendants",
    );
  }
} finally {
  runner.assertQuiescent();
  const actual = realpathSync(directory);
  assert(
    actual.startsWith(realpathSync(tmpdir()) + sep) &&
      basename(actual).startsWith("sandcastle-process-consumer-"),
  );
  rmSync(actual, { recursive: true, force: true });
}
