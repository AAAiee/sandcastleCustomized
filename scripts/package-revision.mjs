#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flags = {};
const allowed = [
  "--revision",
  "--image",
  "--dependencies",
  "--output",
  "--docker",
];
for (let index = 0; index < args.length; index += 2) {
  assert.ok(
    allowed.includes(args[index]) && args[index + 1] && !flags[args[index]],
    "Expected unique --revision, --image, --dependencies, --output and optional --docker values",
  );
  flags[args[index]] = args[index + 1];
}
assert.match(
  flags["--revision"] ?? "",
  /^[a-f0-9]{40}$/i,
  "Use a full committed Git revision",
);
assert.match(
  flags["--image"] ?? "",
  /^sha256:[a-f0-9]{64}$/,
  "Use a locally available immutable Docker image ID",
);
assert.ok(
  flags["--dependencies"] && flags["--output"],
  "Prepared Linux node_modules and a fresh output directory are required",
);
const revision = flags["--revision"];
const image = flags["--image"];
const docker = flags["--docker"] ?? "docker";
const dependencies = realpathSync(flags["--dependencies"]);
assert.equal(basename(dependencies), "node_modules");
const git = (...arguments_) =>
  execFileSync("git", arguments_, {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lock = git("show", `${revision}:package-lock.json`);
// Git exports LF; a prepared Windows cache may contain equivalent CRLF bytes.
const canonicalLock = (bytes) =>
  bytes.toString("utf8").replaceAll("\r\n", "\n");
assert.equal(
  hash(
    canonicalLock(
      readFileSync(join(dirname(dependencies), "package-lock.json")),
    ),
  ),
  hash(canonicalLock(lock)),
  "Prepared dependencies belong to a different lockfile",
);
const manifest = JSON.parse(git("show", `${revision}:package.json`));
execFileSync(docker, ["image", "inspect", image], {
  windowsHide: true,
  stdio: "ignore",
  timeout: 15000,
});
const output = resolve(flags["--output"]);
mkdirSync(output, { recursive: true });
assert.deepEqual(
  readdirSync(output),
  [],
  "Use a fresh output directory; earlier evidence is never overwritten",
);
const archive = join(output, "source.tar");
git(
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "archive",
  "--format=tar",
  "--output",
  archive,
  revision,
);
const name = "sandcastle-package-" + randomUUID();
const fd = openSync(join(output, "build.log"), "wx");
const script = [
  "set -eu",
  "mkdir /tmp/package-source",
  "tar -xf /opt/source.tar -C /tmp/package-source",
  "ln -s /opt/dependencies/node_modules /tmp/package-source/node_modules",
  "cd /tmp/package-source",
  "npm run build",
  "npm_config_ignore_scripts=true npm pack --json --pack-destination /opt/output > /opt/output/pack.json",
  `node -e 'require("fs").writeFileSync("/opt/output/toolchain.json",JSON.stringify({node:process.version,npm:require("child_process").execFileSync("npm",["--version"],{encoding:"utf8"}).trim(),platform:process.platform,arch:process.arch}))'`,
].join("\n");
try {
  execFileSync(
    docker,
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--name",
      name,
      "--network",
      "none",
      "--user",
      "0:0",
      "--env",
      "HUSKY=0",
      "--env",
      "CI=1",
      "--mount",
      `type=bind,source=${archive},target=/opt/source.tar,readonly`,
      "--mount",
      `type=bind,source=${dependencies},target=/opt/dependencies/node_modules,readonly`,
      "--mount",
      `type=bind,source=${output},target=/opt/output`,
      "--entrypoint",
      "sh",
      image,
      "-lc",
      script,
    ],
    { windowsHide: true, stdio: ["ignore", fd, fd], timeout: 180000 },
  );
} finally {
  closeSync(fd);
  try {
    execFileSync(docker, ["rm", "--force", name], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15000,
    });
  } catch {}
}
const raw = readFileSync(join(output, "pack.json"), "utf8");
const packed = JSON.parse(raw.slice(raw.indexOf("[")));
assert.equal(packed.length, 1);
assert.equal(packed[0].name, manifest.name);
assert.equal(packed[0].version, manifest.version);
assert.equal(basename(packed[0].filename), packed[0].filename);
assert.ok(existsSync(join(output, packed[0].filename)));
const provenance = {
  version: 1,
  revision,
  name: manifest.name,
  packageVersion: manifest.version,
  filename: packed[0].filename,
  sha256: hash(readFileSync(join(output, packed[0].filename))),
  sourceArchiveSha256: hash(readFileSync(archive)),
  lockSha256: hash(lock),
  image,
  toolchain: JSON.parse(readFileSync(join(output, "toolchain.json"))),
};
writeFileSync(
  join(output, "provenance.json"),
  JSON.stringify(provenance, null, 2) + "\n",
);
console.log(JSON.stringify(provenance, null, 2));
