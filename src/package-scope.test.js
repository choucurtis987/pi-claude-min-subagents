import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(srcDir, "..", "package.json"), "utf8"),
);

test("uses the current host-provided Pi package scope", () => {
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });

  const deprecatedImport = /@mariozechner\/pi-|@sinclair\/typebox/;
  const offenders = fs.readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => deprecatedImport.test(fs.readFileSync(path.join(srcDir, name), "utf8")));

  assert.deepEqual(offenders, []);
});
