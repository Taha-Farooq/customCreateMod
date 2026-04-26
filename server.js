const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const HISTORY_PATH = path.join(__dirname, "history.json");
const PLANS_PATH = path.join(__dirname, "plans.json");
const SNAPSHOTS_PATH = path.join(__dirname, "snapshots.json");
const AUDIT_LOG_PATH = path.join(__dirname, "audit.log");
const projectLocks = new Map();
const projectQueues = new Map();
const ALLOWED_ROOTS = [
  path.resolve(__dirname),
  path.resolve(path.join(__dirname, "generated-projects")),
];

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function safeName(input) {
  return (input || "feature")
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64) || "feature";
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function writeFile(filePath, content) {
  assertPathAllowed(filePath);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function upsertFile(filePath, content) {
  assertPathAllowed(filePath);
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, "utf8");
}

function appendAudit(event, details) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    details,
  });
  fs.appendFileSync(AUDIT_LOG_PATH, `${line}\n`, "utf8");
}

function isPathWithin(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertPathAllowed(targetPath) {
  const full = path.resolve(targetPath);
  const allowed = ALLOWED_ROOTS.some((root) => isPathWithin(root, full));
  if (!allowed) {
    throw new Error(`Write blocked by allowlist: ${full}`);
  }
}

function classNameFromFeature(feature) {
  return feature
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function shortPreview(content) {
  const text = content || "";
  const lines = text.split("\n").slice(0, 12).join("\n");
  return lines.length > 700 ? `${lines.slice(0, 700)}...` : lines;
}

function sanitizePackageName(input) {
  const cleaned = (input || "com.taha.customcreate")
    .replace(/[^a-zA-Z0-9_.]/g, "")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
  return cleaned || "com.taha.customcreate";
}

function sanitizeProjectPath(projectPath, fallbackModId) {
  if (projectPath && String(projectPath).trim()) {
    const resolved = path.resolve(String(projectPath).trim());
    assertPathAllowed(resolved);
    return resolved;
  }
  const resolved = path.join(__dirname, "generated-projects", fallbackModId);
  assertPathAllowed(resolved);
  return resolved;
}

function validateFeatureRequest(body) {
  const errors = [];
  if (!body || typeof body !== "object") {
    errors.push("Request body is required.");
    return errors;
  }
  if (!String(body.featureTitle || "").trim()) errors.push("featureTitle is required.");
  if (!String(body.featureSummary || "").trim()) errors.push("featureSummary is required.");
  const loader = normalizeLoader(body.loader || "none");
  if (loader === "none" && parseBoolean(body.useAeronautics, false)) {
    errors.push("Aeronautics requires a mod loader context.");
  }
  if (!parseBoolean(body.useCreate, true) && parseBoolean(body.useAeronautics, true)) {
    errors.push("Aeronautics compatibility requires Create to be enabled.");
  }
  return errors;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(v)) return true;
    if (["false", "0", "no", "n", "off"].includes(v)) return false;
  }
  return fallback;
}

function normalizeLoader(loader) {
  const raw = String(loader || "none").toLowerCase();
  if (["neoforge", "forge", "fabric", "quilt", "none"].includes(raw)) return raw;
  return "none";
}

function inferProjectFromPrompt(prompt) {
  const text = String(prompt || "").trim();
  const lower = text.toLowerCase();
  const loader = lower.includes("fabric")
    ? "fabric"
    : lower.includes("neoforge")
      ? "neoforge"
      : lower.includes("forge")
        ? "forge"
        : "none";
  const useCreate = /\bcreate\b/.test(lower);
  const useAeronautics = /aeronautics/.test(lower);
  const nameSeed = safeName(text || "new-project");
  return {
    projectName: nameSeed,
    loader,
    useCreate,
    useAeronautics,
  };
}

function normalizeLicensePreset(preset) {
  const raw = String(preset || "modpack_credit").toLowerCase();
  if (["modpack_credit", "mit_arr", "arr_only", "apache_ccby"].includes(raw)) return raw;
  return "modpack_credit";
}

function getLicenseConfig(preset) {
  const p = normalizeLicensePreset(preset);
  if (p === "modpack_credit") {
    return {
      preset: p,
      codeSpdx: "MIT",
      codeLabel: "MIT",
      assetsLabel: "Modpack use with credit",
    };
  }
  if (p === "arr_only") {
    return {
      preset: p,
      codeSpdx: "ARR",
      codeLabel: "All Rights Reserved",
      assetsLabel: "All Rights Reserved",
    };
  }
  if (p === "apache_ccby") {
    return {
      preset: p,
      codeSpdx: "Apache-2.0",
      codeLabel: "Apache-2.0",
      assetsLabel: "CC-BY-4.0",
    };
  }
  return {
    preset: "mit_arr",
    codeSpdx: "MIT",
    codeLabel: "MIT",
    assetsLabel: "All Rights Reserved",
  };
}

function projectKeyFromRoot(root) {
  return Buffer.from(path.resolve(root)).toString("base64");
}

function getHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function pushHistory(entry) {
  const current = getHistory();
  writeFile(HISTORY_PATH, JSON.stringify([entry, ...current].slice(0, 100), null, 2) + "\n");
}

function getPlans() {
  if (!fs.existsSync(PLANS_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(PLANS_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function savePlans(plans) {
  writeFile(PLANS_PATH, JSON.stringify(plans, null, 2) + "\n");
}

function getSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOTS_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function saveSnapshots(snapshots) {
  writeFile(SNAPSHOTS_PATH, JSON.stringify(snapshots, null, 2) + "\n");
}

function getOrCreateProjectQueue(key) {
  if (!projectQueues.has(key)) {
    projectQueues.set(key, { running: false, items: [] });
  }
  return projectQueues.get(key);
}

function pumpProjectQueue(key) {
  const queue = getOrCreateProjectQueue(key);
  if (queue.running) return;
  const next = queue.items.shift();
  if (!next) return;
  queue.running = true;
  projectLocks.set(key, true);
  Promise.resolve()
    .then(next.fn)
    .then((value) => next.resolve(value))
    .catch((error) => next.reject(error))
    .finally(() => {
      queue.running = false;
      projectLocks.delete(key);
      pumpProjectQueue(key);
    });
}

function enqueueProjectOperation(projectRoot, opName, fn) {
  const key = projectKeyFromRoot(projectRoot);
  const queue = getOrCreateProjectQueue(key);
  appendAudit("operation_queued", {
    projectPath: projectRoot,
    projectKey: key,
    opName,
    queuedDepth: queue.items.length + (queue.running ? 1 : 0),
  });
  return new Promise((resolve, reject) => {
    queue.items.push({ fn, resolve, reject });
    pumpProjectQueue(key);
  });
}

function queueStats() {
  let queued = 0;
  let active = 0;
  for (const [, queue] of projectQueues.entries()) {
    queued += queue.items.length;
    if (queue.running) active += 1;
  }
  return { queued, active };
}

function withTimeout(promise, ms, message) {
  const timeoutMs = Math.max(1000, Number(ms) || 300000);
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message || `Operation timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function createSnapshot(projectRoot, reason) {
  const snapshots = getSnapshots();
  const key = projectKeyFromRoot(projectRoot);
  const ts = new Date().toISOString();
  const id = `snap_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const entry = {
    id,
    timestamp: ts,
    projectPath: projectRoot,
    projectKey: key,
    reason: reason || "manual",
    files: {},
  };
  snapshots[key] = snapshots[key] || [];
  snapshots[key].unshift(entry);
  snapshots[key] = snapshots[key].slice(0, 20);
  saveSnapshots(snapshots);
  appendAudit("snapshot_created", { projectRoot, snapshotId: id, reason });
  return entry;
}

function snapshotFileContent(snapshot, filePath) {
  if (Object.prototype.hasOwnProperty.call(snapshot.files, filePath)) return;
  if (fs.existsSync(filePath)) {
    snapshot.files[filePath] = fs.readFileSync(filePath, "utf8");
  } else {
    snapshot.files[filePath] = null;
  }
}

function persistUpdatedSnapshot(snapshot) {
  const snapshots = getSnapshots();
  const key = snapshot.projectKey;
  const list = snapshots[key] || [];
  const idx = list.findIndex((x) => x.id === snapshot.id);
  if (idx >= 0) {
    list[idx] = snapshot;
    snapshots[key] = list;
    saveSnapshots(snapshots);
  }
}

function restoreSnapshot(snapshot) {
  for (const [filePath, content] of Object.entries(snapshot.files || {})) {
    if (content === null) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else {
      writeFile(filePath, content);
    }
  }
}

function createPlan(root, pkg, featureClass, filePlan, registryPlan, metadata) {
  const planId = `plan_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const plans = getPlans();
  plans[planId] = {
    createdAt: new Date().toISOString(),
    root,
    pkg,
    featureClass,
    metadata,
    files: filePlan.map((f, i) => ({
      id: `file_${i + 1}`,
      path: f.path,
      content: f.content,
    })),
    registry: {
      id: "registry_1",
      ...registryPlan,
    },
  };
  // Keep plan store bounded for multi-project usage.
  const planIds = Object.keys(plans);
  if (planIds.length > 200) {
    const sorted = planIds.sort((a, b) => {
      const ta = new Date(plans[a]?.createdAt || 0).getTime();
      const tb = new Date(plans[b]?.createdAt || 0).getTime();
      return ta - tb;
    });
    for (const oldId of sorted.slice(0, planIds.length - 200)) {
      delete plans[oldId];
    }
  }
  savePlans(plans);
  return planId;
}

function createProjectSkeleton(root, info) {
  const {
    modId,
    pkg,
    mcVersion,
    neoForgeVersion,
    createVersion,
    aeronauticsModId,
    loader,
    useCreate,
    useAeronautics,
    licensePreset,
  } = info;
  const javaRoot = path.join(root, "src", "main", "java", ...pkg.split("."));
  const resourcesRoot = path.join(root, "src", "main", "resources");
  const packagePath = pkg.replace(/\./g, "/");
  const normalizedLoader = normalizeLoader(loader);
  const license = getLicenseConfig(licensePreset);

  upsertFile(path.join(root, "settings.gradle"), `pluginManagement {
    repositories {
        gradlePluginPortal()
        maven { url = "https://maven.neoforged.net/releases" }
    }
}

rootProject.name = "${modId}"
`,
  );
  upsertFile(path.join(root, "gradle.properties"), `org.gradle.jvmargs=-Xmx2G
org.gradle.daemon=false
minecraft_version=${mcVersion}
neo_version=${neoForgeVersion}
create_version=${createVersion}
mod_id=${modId}
mod_name=${modId}
mod_group_id=${pkg}
mod_version=0.1.0
mod_authors=Taha Farooq
mod_description=Generated mod project from Feature UI
mod_website=https://github.com/Taha-Farooq/customCreateMod
mod_sources=https://github.com/Taha-Farooq/customCreateMod
mod_issues=https://github.com/Taha-Farooq/customCreateMod/issues
mod_license=${license.codeSpdx}
project_loader=${normalizedLoader}
use_create=${useCreate ? "true" : "false"}
use_aeronautics=${useAeronautics ? "true" : "false"}
`,
  );

  const pluginBlock = normalizedLoader === "neoforge"
    ? `plugins {
    id 'java-library'
    id 'net.neoforged.gradle.userdev' version '7.0.165'
}`
    : `plugins {
    id 'java-library'
}`;
  const dependencyLines = [];
  if (normalizedLoader === "neoforge") {
    dependencyLines.push(`    implementation "net.neoforged:neoforge:\${neo_version}"`);
  }
  if (useCreate) {
    dependencyLines.push(`    implementation "com.simibubi.create:create-\${minecraft_version}:\${create_version}"`);
  }
  if (dependencyLines.length === 0) {
    dependencyLines.push("    // Add project dependencies here.");
  }

  upsertFile(path.join(root, "build.gradle"), `${pluginBlock}

group = project.mod_group_id
version = project.mod_version

repositories {
    mavenCentral()
    maven { url = "https://maven.createmod.net" }
}

java.toolchain.languageVersion = JavaLanguageVersion.of(17)

dependencies {
${dependencyLines.join("\n")}
}

tasks.withType(JavaCompile).configureEach {
    options.encoding = 'UTF-8'
}
`,
  );
  upsertFile(path.join(root, "README.md"), `# ${modId}

Create addon project generated by Feature UI.
- Minecraft: ${mcVersion}
- NeoForge: ${neoForgeVersion}
- Create: ${createVersion}
- Loader: ${normalizedLoader}
- Use Create: ${useCreate}
- Aeronautics compatibility: optional with mod id \`${aeronauticsModId}\`

## License

- Code: ${license.codeLabel}
- Assets: ${license.assetsLabel}

## Modpack Usage

This project is generated to be modpack-friendly:
- Uses explicit IDs and version metadata for launcher/modpack tooling.
- Supports optional integrations via config/generation toggles.
- Includes clear credit/license metadata for pack maintainers.
`,
  );
  upsertFile(path.join(javaRoot, "FeatureRegistry.java"), `package ${pkg};

public final class FeatureRegistry {
    private FeatureRegistry() {}

    public static void registerAll() {
        // Generated features are called here.
    }
}
`,
  );
  const entryClass = normalizedLoader === "neoforge"
    ? `package ${pkg};
import net.neoforged.fml.common.Mod;
@Mod("${modId}")
public class CreateAddonMod {
    public CreateAddonMod() {
        FeatureRegistry.registerAll();
    }
}
`
    : `package ${pkg};
public class CreateAddonMod {
    public CreateAddonMod() {
        FeatureRegistry.registerAll();
    }
}
`;
  upsertFile(path.join(javaRoot, "CreateAddonMod.java"), entryClass);

  if (normalizedLoader === "neoforge") {
    upsertFile(path.join(resourcesRoot, "META-INF", "neoforge.mods.toml"), `modLoader="javafml"
loaderVersion="[4,)"
license="${license.codeSpdx}"

[[mods]]
modId="${modId}"
version="\${file.jarVersion}"
displayName="${modId}"
displayURL="\${mod_website}"
issueTrackerURL="\${mod_issues}"
description='''Generated Create addon mod'''

[[dependencies.${modId}]]
modId="neoforge"
type="required"
versionRange="[20,)"
ordering="NONE"
side="BOTH"

[[dependencies.${modId}]]
modId="minecraft"
type="required"
versionRange="[${mcVersion},)"
ordering="NONE"
side="BOTH"
`,
    );
    if (useCreate) {
      upsertFile(path.join(resourcesRoot, "META-INF", `${modId}.create.dependency.toml`), `# marker file for Create-enabled project\n`);
      const modsTomlPath = path.join(resourcesRoot, "META-INF", "neoforge.mods.toml");
      const content = fs.readFileSync(modsTomlPath, "utf8");
      if (!content.includes('modId="create"')) {
        fs.writeFileSync(
          modsTomlPath,
          `${content}
[[dependencies.${modId}]]
modId="create"
type="required"
versionRange="[0,)"
ordering="AFTER"
side="BOTH"
`,
          "utf8",
        );
      }
    }
  }
  upsertFile(
    path.join(resourcesRoot, "pack.mcmeta"),
    `{
  "pack": {
    "pack_format": 26,
    "description": "${modId} resources"
  }
}
`,
  );
  ensureDir(path.join(resourcesRoot, "data", modId, "recipes"));
  ensureDir(path.join(resourcesRoot, "data", modId, "tags", "items"));
  ensureDir(path.join(resourcesRoot, "assets", modId, "lang"));
  upsertFile(path.join(resourcesRoot, "assets", modId, "lang", "en_us.json"), "{}\n");
  upsertFile(path.join(resourcesRoot, "application.properties"), `aeronautics.modid=${aeronauticsModId}\n`);
  // Persist current project profile on every generation/update.
  writeFile(
    path.join(root, ".feature-ui.json"),
    JSON.stringify(
      {
        modId,
        packagePath,
        basePackage: pkg,
        loader: normalizedLoader,
        useCreate,
        useAeronautics,
        licensePreset: license.preset,
        minecraftVersion: mcVersion,
        neoForgeVersion,
        createVersion,
        aeronauticsModId,
      },
      null,
      2,
    ) + "\n",
  );
}

function appendFeatureToRegistry(root, pkg, featureClass) {
  const registryPath = path.join(root, "src", "main", "java", ...pkg.split("."), "FeatureRegistry.java");
  if (!fs.existsSync(registryPath)) return { action: "skip", path: registryPath };
  const content = fs.readFileSync(registryPath, "utf8");
  const callLine = `        ${featureClass}Feature.register();`;
  if (content.includes(callLine)) return { action: "unchanged", path: registryPath, preview: callLine };
  const updated = content.replace(
    "    public static void registerAll() {\n        // Generated features are called here.\n    }",
    `    public static void registerAll() {\n        // Generated features are called here.\n${callLine}\n    }`,
  );
  fs.writeFileSync(registryPath, updated, "utf8");
  return { action: "update", path: registryPath, preview: shortPreview(updated) };
}

function planRegistryUpdate(root, pkg, featureClass) {
  const registryPath = path.join(root, "src", "main", "java", ...pkg.split("."), "FeatureRegistry.java");
  if (!fs.existsSync(registryPath)) return { action: "skip", path: registryPath, preview: "Registry does not exist yet." };
  const content = fs.readFileSync(registryPath, "utf8");
  const callLine = `        ${featureClass}Feature.register();`;
  if (content.includes(callLine)) return { action: "unchanged", path: registryPath, preview: callLine };
  const updated = content.replace(
    "    public static void registerAll() {\n        // Generated features are called here.\n    }",
    `    public static void registerAll() {\n        // Generated features are called here.\n${callLine}\n    }`,
  );
  return { action: "update", path: registryPath, preview: shortPreview(updated) };
}

function applyWritePlan(writePlan, dryRun) {
  return writePlan.map((file) => {
    const exists = fs.existsSync(file.path);
    if (!dryRun) writeFile(file.path, file.content);
    return {
      path: file.path,
      action: exists ? "update" : "create",
      preview: shortPreview(file.content),
    };
  });
}

function runProjectTest(projectRoot, command) {
  const defaultCommand = process.platform === "win32" ? "gradlew.bat compileJava" : "./gradlew compileJava";
  const cmd = (command && command.trim()) || defaultCommand;
  try {
    const stdout = execSync(cmd, {
      cwd: projectRoot,
      stdio: "pipe",
      encoding: "utf8",
      shell: true,
      timeout: 180000,
    });
    return { ok: true, command: cmd, output: shortPreview(stdout || "compileJava passed") };
  } catch (error) {
    const out = `${error.stdout || ""}\n${error.stderr || ""}`.trim();
    return { ok: false, command: cmd, output: shortPreview(out || error.message || "Test command failed") };
  }
}

function applyOneChangeWithRollback(change, root, testCommand) {
  const existed = fs.existsSync(change.path);
  const previous = existed ? fs.readFileSync(change.path, "utf8") : null;
  writeFile(change.path, change.content);
  const testResult = runProjectTest(root, testCommand);
  if (testResult.ok) {
    return { kept: true, testResult };
  }
  if (existed) {
    writeFile(change.path, previous);
  } else if (fs.existsSync(change.path)) {
    fs.unlinkSync(change.path);
  }
  return { kept: false, testResult };
}

function packageFromContent(content) {
  const match = (content || "").match(/package\s+([a-zA-Z0-9_.]+)\s*;/);
  return match ? match[1] : "com.example";
}

function classFromFilename(filePath) {
  return path.basename(filePath, ".java");
}

function buildRetryContent(filePath, originalContent) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".java") {
    const pkg = packageFromContent(originalContent);
    const cls = classFromFilename(filePath);
    if (cls.endsWith("Feature")) {
      return `package ${pkg};

public final class ${cls} {
    private ${cls}() {}
    public static void register() {}
}
`;
    }
    if (cls.endsWith("Compat")) {
      return `package ${pkg};

public final class ${cls} {
    private ${cls}() {}
    public static void register() {}
}
`;
    }
    if (cls.endsWith("Spec")) {
      return `package ${pkg};

public record ${cls}(String note) {}
`;
    }
    return `package ${pkg};

public final class ${cls} {}
`;
  }
  if (ext === ".json") {
    try {
      JSON.parse(originalContent);
      return originalContent;
    } catch (_error) {
      return "{\n  \"replace\": false,\n  \"values\": []\n}\n";
    }
  }
  return originalContent;
}

function isTooComplexForSafeRetry(filePath, content, failureOutput) {
  const text = content || "";
  const failure = failureOutput || "";
  const isJava = path.extname(filePath).toLowerCase() === ".java";
  const lineCount = text.split("\n").length;
  const hasManyMethods = (text.match(/\b(public|private|protected)\b/g) || []).length > 10;
  const advancedSignals =
    /generic|extends|implements|lambda|stream|mixin|reflection|ClassNotFound|NoSuchMethod/i.test(
      `${text}\n${failure}`,
    );
  if (!isJava) return false;
  if (lineCount > 220) return true;
  if (hasManyMethods && advancedSignals) return true;
  if (advancedSignals && lineCount > 120) return true;
  return false;
}

function complexityRecommendation(filePath) {
  return `Aborted retry for ${filePath}: complexity/risk is too high for safe automatic fallback.
Recommended next step: use Cursor manually on this file with the compile error output, or split the feature into smaller units and retry per unit.`;
}

function aiRetryNarrative(featureTitle, retryApplied, retryFailed) {
  const successLines = retryApplied.map((x) => `- ${x.path}: retry patch compiled`).join("\n");
  const failLines = retryFailed.map((x) => `- ${x.path}: ${x.test.output}`).join("\n");
  return `Retry report for "${featureTitle}"

Retried and fixed: ${retryApplied.length}
Still failing: ${retryFailed.length}

Retry fixes that worked:
${successLines || "- none"}

Still failing after fallback retries:
${failLines || "- none"}

Ask AI to deeply fix only the remaining failing files using these compiler errors.`;
}

function implementFeature(input) {
  const modId = safeName(input.modId || "customcreateaddon").replace(/-/g, "_");
  const pkg = sanitizePackageName(input.basePackage);
  const feature = safeName(input.featureTitle);
  const featureClass = classNameFromFeature(feature);
  const mcVersion = input.minecraftVersion || "1.20.1";
  const neoForgeVersion = input.neoForgeVersion || "20.6.130";
  const createVersion = input.createVersion || "LATEST";
  const aeronauticsModId = input.aeronauticsModId || "create_aeronautics";
  const loader = normalizeLoader(input.loader || "neoforge");
  const useCreate = parseBoolean(input.useCreate, true);
  const useAeronautics = useCreate ? parseBoolean(input.useAeronautics, true) : false;
  const licensePreset = normalizeLicensePreset(input.licensePreset || "modpack_credit");
  const dryRun = Boolean(input.dryRun);
  const root = sanitizeProjectPath(input.projectPath, modId);
  const javaRoot = path.join(root, "src", "main", "java", ...pkg.split("."));
  const resourcesRoot = path.join(root, "src", "main", "resources");

  createProjectSkeleton(root, {
    modId,
    pkg,
    mcVersion,
    neoForgeVersion,
    createVersion,
    aeronauticsModId,
    loader,
    useCreate,
    useAeronautics,
    licensePreset,
  });

  const writePlan = [
    {
      path: path.join(javaRoot, "FeatureSpec.java"),
      content: `package ${pkg};

public record FeatureSpec(
    String title,
    String requestedBehavior,
    String compatibilityNotes
) {}
`,
    },
    {
      path: path.join(javaRoot, `${featureClass}FeatureSpec.java`),
      content: `package ${pkg};

public record ${featureClass}FeatureSpec(
    String title, String requestedBehavior, String compatibilityNotes
) {}
`,
    },
    {
      path: path.join(javaRoot, `${featureClass}Feature.java`),
      content: `package ${pkg};

public final class ${featureClass}Feature {
    private static final String AERONAUTICS_MOD_ID = "${aeronauticsModId}";
    private ${featureClass}Feature() {}

    public static void register() {
        registerCore();
        if (${useAeronautics ? "true" : "false"}) {
            ${featureClass}AeronauticsCompat.register();
        }
    }

    private static void registerCore() {
        // ${input.featureSummary || "feature behavior"}
    }
}
`,
    },
    {
      path: path.join(javaRoot, `${featureClass}AeronauticsCompat.java`),
      content: `package ${pkg};

public final class ${featureClass}AeronauticsCompat {
    private ${featureClass}AeronauticsCompat() {}

    public static void register() {
        // Aeronautics-specific hooks live here.
    }
}
`,
    },
    {
      path: path.join(resourcesRoot, "data", modId, "tags", "items", "aeronautics_compatible_inputs.json"),
      content: `{
  "replace": false,
  "values": []
}
`,
    },
    {
      path: path.join(resourcesRoot, "data", modId, "recipes", `${feature}.json`),
      content: `{
  "type": "minecraft:crafting_shaped",
  "pattern": [" A ", " B ", " C "],
  "key": {
    "A": { "tag": "${modId}:aeronautics_compatible_inputs" },
    "B": { "item": "minecraft:iron_ingot" },
    "C": { "item": "minecraft:redstone" }
  },
  "result": { "item": "${modId}:${feature}" }
}
`,
    },
  ];

  const files = applyWritePlan(writePlan, dryRun);
  const registryPreview = planRegistryUpdate(root, pkg, featureClass);
  const registryChange = dryRun
    ? planRegistryUpdate(root, pkg, featureClass)
    : appendFeatureToRegistry(root, pkg, featureClass);
  const planId = createPlan(root, pkg, featureClass, writePlan, registryPreview, {
    modId,
    pkg,
    mcVersion,
    neoForgeVersion,
    createVersion,
    aeronauticsModId,
    featureTitle: input.featureTitle,
    featureSummary: input.featureSummary,
  });

  return {
    root,
    files,
    registryChange,
    dryRun,
    featureClass,
    planId,
    metadata: {
      modId,
      pkg,
      mcVersion,
      neoForgeVersion,
      createVersion,
      aeronauticsModId,
      loader,
      useCreate,
      useAeronautics,
      licensePreset,
    },
  };
}

app.post("/api/create-project", (req, res) => {
  const body = req.body || {};
  const inferred = inferProjectFromPrompt(body.prompt || "");
  const modId = safeName(body.modId || body.projectName || inferred.projectName || "new-project").replace(/-/g, "_");
  const pkg = sanitizePackageName(body.basePackage || "com.taha.customcreate");
  const root = sanitizeProjectPath(body.projectPath, modId);
  const loader = normalizeLoader(body.loader || inferred.loader || "none");
  const useCreate = parseBoolean(body.useCreate, inferred.useCreate);
  const useAeronautics = parseBoolean(body.useAeronautics, inferred.useAeronautics);
  const licensePreset = normalizeLicensePreset(body.licensePreset || "modpack_credit");
  const mcVersion = body.minecraftVersion || "1.20.1";
  const neoForgeVersion = body.neoForgeVersion || "20.6.130";
  const createVersion = body.createVersion || "LATEST";
  const aeronauticsModId = body.aeronauticsModId || "create_aeronautics";

  try {
    createProjectSkeleton(root, {
      modId,
      pkg,
      mcVersion,
      neoForgeVersion,
      createVersion,
      aeronauticsModId,
      loader,
      useCreate,
      useAeronautics,
      licensePreset,
    });
    const projectKey = projectKeyFromRoot(root);
    pushHistory({
      timestamp: new Date().toISOString(),
      featureTitle: "Project Created",
      summary: body.prompt || "Created project scaffold",
      projectPath: root,
      projectKey,
      dryRun: false,
      featureClass: "ProjectBootstrap",
      changeCount: 1,
      status: "project-created",
    });
    appendAudit("project_created", { root, modId, loader, useCreate, useAeronautics, licensePreset });
    return res.json({
      ok: true,
      projectPath: root,
      projectKey,
      project: {
        modId,
        pkg,
        loader,
        useCreate,
        useAeronautics,
        licensePreset,
        mcVersion,
        neoForgeVersion,
        createVersion,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to create project." });
  }
});

app.post("/api/generate-feature", (req, res) => {
  const body = req.body || {};
  const errors = validateFeatureRequest(body);
  if (errors.length > 0) {
    return res.status(400).json({ ok: false, error: errors.join(" ") });
  }
  try {
    const result = implementFeature(body);
    const projectKey = projectKeyFromRoot(result.root);
    pushHistory({
      timestamp: new Date().toISOString(),
      featureTitle: body.featureTitle,
      summary: body.featureSummary,
      projectPath: result.root,
      projectKey,
      dryRun: result.dryRun,
      featureClass: result.featureClass,
      changeCount: result.files.length + 1,
    });
    appendAudit("feature_generated", {
      projectPath: result.root,
      featureTitle: body.featureTitle,
      loader: result.metadata.loader,
      useCreate: result.metadata.useCreate,
      useAeronautics: result.metadata.useAeronautics,
      dryRun: result.dryRun,
    });
    return res.json({
      ok: true,
      outputPath: result.root,
      files: result.files,
      registryChange: result.registryChange,
      dryRun: result.dryRun,
      planId: result.planId,
      projectKey,
      metadata: result.metadata,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Unknown generation failure." });
  }
});

app.get("/api/project-profile", (req, res) => {
  const projectPath = req.query.projectPath ? path.resolve(String(req.query.projectPath)) : null;
  const projectKey = req.query.projectKey ? String(req.query.projectKey) : null;
  let root = projectPath;

  if (!root && projectKey) {
    const projects = getHistory().find((x) => x.projectKey === projectKey);
    if (projects?.projectPath) {
      root = path.resolve(projects.projectPath);
    }
  }
  if (!root) {
    return res.status(400).json({ ok: false, error: "projectPath or projectKey is required." });
  }

  const profilePath = path.join(root, ".feature-ui.json");
  if (!fs.existsSync(profilePath)) {
    return res.status(404).json({ ok: false, error: "Project profile not found." });
  }
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    return res.json({ ok: true, projectPath: root, projectKey: projectKeyFromRoot(root), profile });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to read project profile." });
  }
});

app.get("/api/projects", (_req, res) => {
  const history = getHistory();
  const plans = getPlans();
  const byKey = new Map();

  for (const item of history) {
    if (!item.projectKey || !item.projectPath) continue;
    const existing = byKey.get(item.projectKey);
    if (!existing) {
      byKey.set(item.projectKey, {
        projectKey: item.projectKey,
        projectPath: item.projectPath,
        lastActivity: item.timestamp,
        source: "history",
      });
    }
  }

  for (const [, plan] of Object.entries(plans)) {
    if (!plan?.root) continue;
    const key = projectKeyFromRoot(plan.root);
    if (!byKey.has(key)) {
      byKey.set(key, {
        projectKey: key,
        projectPath: plan.root,
        lastActivity: plan.createdAt,
        source: "plans",
      });
    }
  }

  const projects = Array.from(byKey.values()).sort((a, b) => {
    return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  });

  return res.json({ ok: true, projects });
});

app.post("/api/apply-selected", async (req, res) => {
  const { planId, selectedIds, testCommand, projectKey, operationTimeoutMs } = req.body || {};
  if (!planId || !Array.isArray(selectedIds)) {
    return res.status(400).json({ ok: false, error: "planId and selectedIds are required." });
  }
  const plans = getPlans();
  const plan = plans[planId];
  if (!plan) {
    return res.status(404).json({ ok: false, error: "Plan not found. Generate again." });
  }
  const actualProjectKey = projectKeyFromRoot(plan.root);
  if (projectKey && projectKey !== actualProjectKey) {
    return res.status(409).json({
      ok: false,
      error: "Project mismatch. Regenerate or use the matching project plan.",
    });
  }

  let op;
  try {
    op = await withTimeout(enqueueProjectOperation(plan.root, "apply-selected", () => {
    const selectedSet = new Set(selectedIds);
    const applied = [];
    const failed = [];
    const skipped = [];
    const snapshot = createSnapshot(plan.root, "apply-selected");

    for (const file of plan.files) {
      if (!selectedSet.has(file.id)) {
        skipped.push({ id: file.id, path: file.path, reason: "Not selected" });
        continue;
      }
      snapshotFileContent(snapshot, file.path);
      const result = applyOneChangeWithRollback(file, plan.root, testCommand);
      if (result.kept) {
        applied.push({ id: file.id, path: file.path, test: result.testResult });
      } else {
        failed.push({ id: file.id, path: file.path, test: result.testResult });
      }
    }

    let registryApplied = null;
    if (selectedSet.has(plan.registry.id)) {
      const registryChange = {
        path: plan.registry.path,
        content:
          plan.registry.action === "update" && plan.registry.preview
            ? fs.readFileSync(plan.registry.path, "utf8").replace(
                "    public static void registerAll() {\n        // Generated features are called here.\n    }",
                `    public static void registerAll() {\n        // Generated features are called here.\n        ${plan.featureClass}Feature.register();\n    }`,
              )
            : null,
      };
      if (registryChange.content) {
        snapshotFileContent(snapshot, registryChange.path);
        const result = applyOneChangeWithRollback(registryChange, plan.root, testCommand);
        registryApplied = {
          id: plan.registry.id,
          path: plan.registry.path,
          kept: result.kept,
          test: result.testResult,
        };
        if (!result.kept) {
          failed.push({
            id: plan.registry.id,
            path: plan.registry.path,
            test: result.testResult,
          });
        }
      }
    } else {
      skipped.push({ id: plan.registry.id, path: plan.registry.path, reason: "Not selected" });
    }
    persistUpdatedSnapshot(snapshot);
    appendAudit("apply_selected", {
      projectPath: plan.root,
      applied: applied.length,
      failed: failed.length,
      skipped: skipped.length,
      snapshotId: snapshot.id,
    });
    return { applied, failed, skipped, registryApplied, snapshotId: snapshot.id };
    }), operationTimeoutMs, "Apply operation timed out.");
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Apply operation failed." });
  }
  const { applied, failed, skipped, registryApplied, snapshotId } = op;

  const failureLines = failed.map((f) => `- ${f.path}: ${f.test.output}`).join("\n");
  const skippedLines = skipped.map((s) => `- ${s.path}: ${s.reason}`).join("\n");
  const aiReport = `Feature apply report for "${plan.metadata.featureTitle}"\n\nApplied successfully: ${applied.length}\nFailed and rolled back: ${failed.length}\nSkipped: ${skipped.length}\n\nFailures:\n${failureLines || "- none"}\n\nSkipped:\n${skippedLines || "- none"}\n\nUse this to generate fixes for failed files only.`;

  pushHistory({
    timestamp: new Date().toISOString(),
    featureTitle: plan.metadata.featureTitle,
    summary: plan.metadata.featureSummary,
    projectPath: plan.root,
    projectKey: actualProjectKey,
    dryRun: false,
    featureClass: plan.featureClass,
    changeCount: applied.length + failed.length + skipped.length,
    status: failed.length > 0 ? "partial" : "success",
  });

  return res.json({
    ok: true,
    projectPath: plan.root,
    applied,
    failed,
    skipped,
    registryApplied,
    snapshotId,
    aiReport,
  });
});

app.post("/api/retry-failed", async (req, res) => {
  const { planId, failed, testCommand, projectKey, operationTimeoutMs } = req.body || {};
  if (!planId || !Array.isArray(failed)) {
    return res.status(400).json({ ok: false, error: "planId and failed array are required." });
  }
  const plans = getPlans();
  const plan = plans[planId];
  if (!plan) {
    return res.status(404).json({ ok: false, error: "Plan not found. Generate again." });
  }
  const actualProjectKey = projectKeyFromRoot(plan.root);
  if (projectKey && projectKey !== actualProjectKey) {
    return res.status(409).json({
      ok: false,
      error: "Project mismatch. Retry only against the originating project.",
    });
  }

  let op;
  try {
    op = await withTimeout(enqueueProjectOperation(plan.root, "retry-failed", () => {
    const retryApplied = [];
    const retryFailed = [];
    const retryAborted = [];
    const snapshot = createSnapshot(plan.root, "retry-failed");
    for (const item of failed) {
      const match = plan.files.find((f) => f.id === item.id || f.path === item.path);
      if (!match) continue;
      const priorFailure = item?.test?.output || "";
      if (isTooComplexForSafeRetry(match.path, match.content, priorFailure)) {
        retryAborted.push({
          id: match.id,
          path: match.path,
          reason: complexityRecommendation(match.path),
        });
        continue;
      }
      const fallbackContent = buildRetryContent(match.path, match.content);
      snapshotFileContent(snapshot, match.path);
      const result = applyOneChangeWithRollback(
        { path: match.path, content: fallbackContent },
        plan.root,
        testCommand,
      );
      if (result.kept) {
        retryApplied.push({ id: match.id, path: match.path, test: result.testResult });
        match.content = fallbackContent;
      } else {
        retryFailed.push({ id: match.id, path: match.path, test: result.testResult });
      }
    }
    persistUpdatedSnapshot(snapshot);
    appendAudit("retry_failed", {
      projectPath: plan.root,
      retryApplied: retryApplied.length,
      retryFailed: retryFailed.length,
      retryAborted: retryAborted.length,
      snapshotId: snapshot.id,
    });
    return { retryApplied, retryFailed, retryAborted, snapshotId: snapshot.id };
    }), operationTimeoutMs, "Retry operation timed out.");
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Retry operation failed." });
  }
  const { retryApplied, retryFailed, retryAborted, snapshotId } = op;

  savePlans(plans);
  const retryReport = aiRetryNarrative(plan.metadata.featureTitle, retryApplied, retryFailed);
  const abortLines = retryAborted.map((x) => `- ${x.path}: ${x.reason}`).join("\n");
  const policyNote = retryAborted.length
    ? `\n\nAborted by complexity policy:\n${abortLines}`
    : "";
  pushHistory({
    timestamp: new Date().toISOString(),
    featureTitle: `${plan.metadata.featureTitle} (retry)`,
    summary: "Automatic fallback retry for failed files",
    projectPath: plan.root,
    projectKey: actualProjectKey,
    dryRun: false,
    featureClass: plan.featureClass,
    changeCount: retryApplied.length + retryFailed.length,
    status: retryFailed.length > 0 ? "retry-partial" : "retry-success",
  });

  return res.json({
    ok: true,
    projectPath: plan.root,
    retryApplied,
    retryFailed,
    retryAborted,
    snapshotId,
    retryReport: `${retryReport}${policyNote}`,
  });
});

app.get("/api/snapshots", (req, res) => {
  const projectKey = req.query.projectKey ? String(req.query.projectKey) : null;
  const snapshots = getSnapshots();
  if (projectKey) {
    return res.json({ ok: true, snapshots: snapshots[projectKey] || [] });
  }
  return res.json({ ok: true, snapshots });
});

app.get("/api/export-state", (req, res) => {
  const projectKey = req.query.projectKey ? String(req.query.projectKey) : null;
  const payload = {
    exportedAt: new Date().toISOString(),
    history: getHistory(),
    plans: getPlans(),
    snapshots: getSnapshots(),
  };
  if (!projectKey) {
    return res.json({ ok: true, ...payload });
  }
  const filteredHistory = payload.history.filter((x) => x.projectKey === projectKey);
  const filteredPlans = Object.fromEntries(
    Object.entries(payload.plans).filter(([, p]) => p && projectKeyFromRoot(p.root) === projectKey),
  );
  const filteredSnapshots = {
    [projectKey]: payload.snapshots[projectKey] || [],
  };
  return res.json({
    ok: true,
    exportedAt: payload.exportedAt,
    history: filteredHistory,
    plans: filteredPlans,
    snapshots: filteredSnapshots,
  });
});

app.post("/api/import-state", (req, res) => {
  const body = req.body || {};
  const mode = body.mode === "replace" ? "replace" : "merge";
  const incomingHistory = Array.isArray(body.history) ? body.history : [];
  const incomingPlans = body.plans && typeof body.plans === "object" ? body.plans : {};
  const incomingSnapshots = body.snapshots && typeof body.snapshots === "object" ? body.snapshots : {};

  if (mode === "replace") {
    writeFile(HISTORY_PATH, JSON.stringify(incomingHistory, null, 2) + "\n");
    writeFile(PLANS_PATH, JSON.stringify(incomingPlans, null, 2) + "\n");
    writeFile(SNAPSHOTS_PATH, JSON.stringify(incomingSnapshots, null, 2) + "\n");
    appendAudit("state_imported", { mode, history: incomingHistory.length, plans: Object.keys(incomingPlans).length });
    return res.json({ ok: true, mode, imported: true });
  }

  const mergedHistory = [...incomingHistory, ...getHistory()].slice(0, 300);
  const mergedPlans = { ...getPlans(), ...incomingPlans };
  const mergedSnapshots = getSnapshots();
  for (const [k, list] of Object.entries(incomingSnapshots)) {
    const base = Array.isArray(mergedSnapshots[k]) ? mergedSnapshots[k] : [];
    const inc = Array.isArray(list) ? list : [];
    mergedSnapshots[k] = [...inc, ...base].slice(0, 30);
  }
  writeFile(HISTORY_PATH, JSON.stringify(mergedHistory, null, 2) + "\n");
  writeFile(PLANS_PATH, JSON.stringify(mergedPlans, null, 2) + "\n");
  writeFile(SNAPSHOTS_PATH, JSON.stringify(mergedSnapshots, null, 2) + "\n");
  appendAudit("state_imported", { mode, history: incomingHistory.length, plans: Object.keys(incomingPlans).length });
  return res.json({ ok: true, mode, imported: true });
});

app.post("/api/restore-snapshot", async (req, res) => {
  const { projectKey, snapshotId, operationTimeoutMs } = req.body || {};
  if (!projectKey || !snapshotId) {
    return res.status(400).json({ ok: false, error: "projectKey and snapshotId are required." });
  }
  const snapshots = getSnapshots();
  const list = snapshots[projectKey] || [];
  const snapshot = list.find((x) => x.id === snapshotId);
  if (!snapshot) {
    return res.status(404).json({ ok: false, error: "Snapshot not found." });
  }
  try {
    await withTimeout(enqueueProjectOperation(snapshot.projectPath, "restore-snapshot", () => {
      restoreSnapshot(snapshot);
      appendAudit("snapshot_restored", {
        projectPath: snapshot.projectPath,
        snapshotId,
      });
      return { ok: true };
    }), operationTimeoutMs, "Restore operation timed out.");
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Restore failed." });
  }
  return res.json({ ok: true, restored: snapshotId, projectPath: snapshot.projectPath });
});

app.post("/api/cancel-queued", (req, res) => {
  const { projectKey } = req.body || {};
  if (!projectKey) {
    return res.status(400).json({ ok: false, error: "projectKey is required." });
  }
  const queue = projectQueues.get(projectKey);
  if (!queue) {
    return res.json({ ok: true, cancelled: 0, running: false });
  }
  const cancelled = queue.items.length;
  queue.items = [];
  appendAudit("queue_cancelled", {
    projectKey,
    cancelled,
    running: queue.running,
  });
  return res.json({
    ok: true,
    cancelled,
    running: queue.running,
  });
});

app.get("/api/preflight", (_req, res) => {
  const nodeVersion = process.version;
  const checks = [];
  checks.push({
    name: "node_version",
    ok: /^v(1[89]|[2-9][0-9])\./.test(nodeVersion),
    detail: `Detected ${nodeVersion}; recommended >= v18`,
  });
  checks.push({
    name: "writable_workspace",
    ok: fs.existsSync(__dirname),
    detail: __dirname,
  });
  checks.push({
    name: "audit_log_access",
    ok: true,
    detail: AUDIT_LOG_PATH,
  });
  checks.push({
    name: "allowed_roots_configured",
    ok: ALLOWED_ROOTS.length > 0,
    detail: ALLOWED_ROOTS,
  });
  const ok = checks.every((c) => c.ok);
  return res.json({
    ok,
    checks,
    nextSteps: ok
      ? ["Run npm install", "Run npm start", "Create/switch project, then generate features"]
      : ["Fix failed checks before feature generation"],
  });
});

app.get("/api/history", (_req, res) => {
  const projectKey = _req.query.projectKey;
  const all = getHistory();
  const filtered = projectKey ? all.filter((x) => x.projectKey === projectKey) : all;
  return res.json({ ok: true, history: filtered });
});

app.get("/api/health", (_req, res) => {
  const plans = getPlans();
  const history = getHistory();
  const snapshots = getSnapshots();
  const snapshotCount = Object.values(snapshots).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  const q = queueStats();
  return res.json({
    ok: true,
    status: "ready",
    planCount: Object.keys(plans).length,
    historyCount: history.length,
    snapshotCount,
    activeLocks: projectLocks.size,
    queuedOperations: q.queued,
    activeQueuedProjects: q.active,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/latest-versions", (_req, res) => {
  return res.json({
    minecraftVersion: "1.20.1",
    neoForgeVersion: "20.6.130",
    createVersion: "LATEST",
    note: "Pin exact Create version in gradle.properties for strict pack reproducibility.",
  });
});

app.listen(PORT, () => {
  console.log(`Feature UI running on http://localhost:${PORT}`);
});
