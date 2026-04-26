const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const port = 4317;
const baseUrl = `http://127.0.0.1:${port}`;
let serverProcess;

async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_error) {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Server did not become ready in time.");
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  await waitForServer(`${baseUrl}/api/health`);
});

test.after(() => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});

test("preflight endpoint returns checks", async () => {
  const res = await fetch(`${baseUrl}/api/preflight`);
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(typeof data.ok, "boolean");
  assert.ok(Array.isArray(data.checks));
  assert.ok(data.checks.length > 0);
});

test("create project then generate dry-run feature", async () => {
  const projectPath = path.join(repoRoot, "generated-projects", `integration-${Date.now()}`);
  const createRes = await fetch(`${baseUrl}/api/create-project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "plain utility project without create",
      projectPath,
      loader: "none",
      useCreate: false,
      useAeronautics: false,
      modId: "integration_mod",
      basePackage: "com.taha.integration",
    }),
  });
  assert.equal(createRes.ok, true);
  const created = await createRes.json();
  assert.equal(created.ok, true);
  assert.ok(created.projectKey);

  const featureRes = await fetch(`${baseUrl}/api/generate-feature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      featureTitle: "integration feature",
      featureSummary: "basic test feature",
      projectPath,
      loader: "none",
      useCreate: false,
      useAeronautics: false,
      dryRun: true,
      modId: "integration_mod",
      basePackage: "com.taha.integration",
    }),
  });
  assert.equal(featureRes.ok, true);
  const feature = await featureRes.json();
  assert.equal(feature.ok, true);
  assert.equal(feature.dryRun, true);
  assert.ok(Array.isArray(feature.files));
  assert.ok(feature.files.length > 0);
});

test("apply selected creates snapshot and snapshot can be restored", async () => {
  const projectPath = path.join(repoRoot, "generated-projects", `integration-apply-${Date.now()}`);
  const createRes = await fetch(`${baseUrl}/api/create-project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "plain utility project without create",
      projectPath,
      loader: "none",
      useCreate: false,
      useAeronautics: false,
      modId: "integration_apply_mod",
      basePackage: "com.taha.integration.apply",
    }),
  });
  assert.equal(createRes.ok, true);
  const created = await createRes.json();

  const featureRes = await fetch(`${baseUrl}/api/generate-feature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      featureTitle: "apply test feature",
      featureSummary: "exercise apply and snapshot restore",
      projectPath,
      loader: "none",
      useCreate: false,
      useAeronautics: false,
      dryRun: true,
      modId: "integration_apply_mod",
      basePackage: "com.taha.integration.apply",
    }),
  });
  assert.equal(featureRes.ok, true);
  const feature = await featureRes.json();
  assert.ok(feature.planId);
  assert.ok(feature.projectKey);

  const selectedIds = ["file_1"]; // apply a minimal file write
  const applyRes = await fetch(`${baseUrl}/api/apply-selected`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      planId: feature.planId,
      selectedIds,
      projectKey: feature.projectKey,
      testCommand: `${process.execPath} -v`,
    }),
  });
  assert.equal(applyRes.ok, true);
  const applied = await applyRes.json();
  assert.ok(applied.snapshotId);

  const restoreRes = await fetch(`${baseUrl}/api/restore-snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectKey: feature.projectKey,
      snapshotId: applied.snapshotId,
    }),
  });
  assert.equal(restoreRes.ok, true);
  const restored = await restoreRes.json();
  assert.equal(restored.ok, true);
  assert.equal(restored.projectPath, projectPath);

  const exportRes = await fetch(`${baseUrl}/api/export-state?projectKey=${encodeURIComponent(feature.projectKey)}`);
  assert.equal(exportRes.ok, true);
  const exported = await exportRes.json();
  assert.equal(exported.ok, true);
  assert.ok(Array.isArray(exported.history));
  assert.equal(typeof exported.snapshots, "object");

  // keep variable used for clarity
  assert.ok(created.projectKey);
});

test("validation and queue cancel endpoints behave correctly", async () => {
  const badRes = await fetch(`${baseUrl}/api/generate-feature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      featureTitle: "bad combo",
      featureSummary: "should fail validation",
      loader: "none",
      useCreate: false,
      useAeronautics: true,
      dryRun: true,
    }),
  });
  assert.equal(badRes.ok, false);
  const badBody = await badRes.json();
  assert.equal(typeof badBody.error, "string");

  const cancelRes = await fetch(`${baseUrl}/api/cancel-queued`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey: "non-existent-project-key" }),
  });
  assert.equal(cancelRes.ok, true);
  const cancelBody = await cancelRes.json();
  assert.equal(cancelBody.ok, true);
  assert.equal(typeof cancelBody.cancelled, "number");
});
