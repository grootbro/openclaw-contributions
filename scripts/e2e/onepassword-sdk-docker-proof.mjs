// Run only inside a disposable image built from the repository Dockerfile.
// Provider I/O is synthetic; the shipped static resolver and SDK imports are real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const resolver = "/app/dist/extensions/onepassword/onepassword-secret-ref-resolver.js";
const alias = "/app/dist/extensions/node_modules/openclaw";
const goodId = "op://Fixture/Item/password";
const badId = "op://Fixture/Item/failure";
const token = "synthetic-onepassword-service-token";
const value = "synthetic-onepassword-result";
const rejectedValue = "synthetic-rejected-secret";
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 1000, "exercise the official image's default node user");
assert.equal(fs.statSync(resolver).isFile(), true, "selected plugin must remain shipped");
assert.equal(fs.existsSync("/app/dist/extensions/anthropic-vertex"), false, "an omitted plugin must remain omitted");
assert.equal(fs.existsSync("/app/node_modules/openclaw"), false, "do not repair the image with a root package symlink");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "onepassword-sdk-proof-"));
fs.chmodSync(root, 0o700);
const state = path.join(root, "state");
const tokenDir = path.join(state, "credentials", "onepassword");
fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(tokenDir, "service-account-token"), token, { mode: 0o600 });
// The executable-owner guard is preserved: both fake op and its interpreter are
// current-user-owned copies in a private directory, as in the plugin's tests.
const node = path.join(root, "node");
fs.copyFileSync(process.execPath, node);
fs.chmodSync(node, 0o700);
const receipt = path.join(root, "op-receipts");
const op = path.join(root, "op");
fs.writeFileSync(op, `#!${node}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 3), ["read", "--cache=false", "--no-newline"]);
assert.equal(args.length, 4);
assert.equal(process.env.OP_SERVICE_ACCOUNT_TOKEN, ${JSON.stringify(token)});
assert.equal(process.env.OP_BIOMETRIC_UNLOCK_ENABLED, "false");
assert.equal(process.env.OP_LOAD_DESKTOP_APP_SETTINGS, "false");
fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({reference:args[3], uid:process.getuid()}) + "\\n", {mode:0o600});
if (args[3] === ${JSON.stringify(goodId)}) process.stdout.write(${JSON.stringify(value)});
else if (args[3] === ${JSON.stringify(badId)}) {
  process.stdout.write(${JSON.stringify(rejectedValue)});
  process.stderr.write(${JSON.stringify(`${token} ${rejectedValue} deliberate fake-op failure`)});
  process.exitCode = 7;
} else throw new Error("unexpected synthetic reference");
`, { mode: 0o700 });

function runResolver(ids) {
  const result = spawnSync(process.execPath, [resolver], {
    cwd: "/app",
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      OPENCLAW_STATE_DIR: state,
      CLAW_1PASSWORD_OP: op,
    },
    input: JSON.stringify({ protocolVersion: 1, provider: "onepassword", ids }) + "\n",
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, "resolver must exit without supervisor termination");
  assert.equal(result.stderr.includes(token), false);
  return result;
}

function packageInventory() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--offline", "--cache", path.join(root, "npm-cache")], {
    cwd: "/app", encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.slice(-1500));
  const [packed] = JSON.parse(result.stdout);
  return packed.files.map((file) => file.path).sort();
}

try {
  const result = runResolver([goodId]);
  assert.equal(result.status, 0, result.stderr.slice(-1500));
  assert.deepEqual(JSON.parse(result.stdout), { protocolVersion: 1, values: { [goodId]: value }, errors: {} });
  const failed = runResolver([badId]);
  assert.equal(failed.status, 0, failed.stderr.slice(-1500));
  const failure = JSON.parse(failed.stdout);
  assert.deepEqual(failure.values, {});
  assert.match(failure.errors[badId].message, /exit code 7/u);
  assert.match(failure.errors[badId].message, /deliberate fake-op failure/u);
  assert.equal(failed.stdout.includes(token), false);
  assert.equal(failed.stdout.includes(rejectedValue), false);
  assert.deepEqual(fs.readFileSync(receipt, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
    { reference: goodId, uid: 1000 }, { reference: badId, uid: 1000 },
  ]);
  assert.equal(fs.statSync(alias).isDirectory(), true, "the shipped SDK alias must remain available");
  const before = packageInventory();
  const backup = path.join(root, "sdk-alias-backup");
  fs.cpSync(alias, backup, { recursive: true });
  try {
    fs.rmSync(alias, { recursive: true });
    assert.deepEqual(packageInventory(), before, "retaining the Docker SDK alias must not change npm package contents");
  } finally {
    fs.cpSync(backup, alias, { recursive: true });
  }
  console.log(JSON.stringify({ proof: "resolver-success-and-redacted-op-failure", uid: process.getuid(), aliasPresent: true, exitCode: result.status, opCalls: 2, npmFiles: before.length, npmInventoryDelta: 0 }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
