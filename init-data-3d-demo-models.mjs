#!/usr/bin/env node

/**
 * Inject the interfacer-3d-demo-models catalog into Interfacer.
 *
 * Creates one demo account and three Design projects owned by it, one per
 * model published in
 * https://github.com/interfacerproject/interfacer-3d-demo-models
 *
 * Model files and images are referenced directly from raw.githubusercontent.com;
 * the primary image is additionally mirrored to the DPP file store so the GUI
 * has a stable thumbnail. Descriptions and licenses come from each model's
 * README.txt / LICENSE.txt.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  clearInstanceVariablesCache,
  createConfig,
  getInstanceVariables,
  InterfacerClient,
  MANUFACTURABLE_TRUE_TAG,
  TAG_PREFIX,
} from "@dyne/interfacer-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUI_DIR = resolve(__dirname, "../interfacer-gui");
const OUTPUT_PATH = join(__dirname, "results-3d-demo-models.json");
const DRY_RUN = process.argv.includes("--dry-run");

// ProjectType is a type-only export in @dyne/interfacer-client 0.6.1.
const ProjectType = Object.freeze({ DESIGN: "Design", PRODUCT: "Product", SERVICE: "Service" });

const REPO = "interfacerproject/interfacer-3d-demo-models";
const REPO_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${REPO_BRANCH}`;

// GitHub folder names contain spaces and punctuation; encode each path segment
// but keep the "/" separators.
function rawUrl(folder, relativePath) {
  return `${RAW_BASE}/${[folder, ...relativePath.split("/")].map(encodeURIComponent).join("/")}`;
}

/**
 * One entry per model directory in the source repository.
 * `license` values are the SPDX-style identifiers interfacer-gui expects.
 */
const MODEL_DEFINITIONS = [
  {
    key: "arduino-robot-arm",
    folder: "Arduino Robot Arm and Controller (v2 R.A.D.) - 7405875",
    name: "Arduino Robot Arm and Controller (v2 R.A.D.)",
    description:
      "A fully 3D-printed robot arm and matching controller (v2 R.A.D.), redesigned " +
      "from the ground up to print with zero support material and run on an Arduino " +
      "Nano. Designed by Kelton Serra (Build Some Stuff).",
    thing: "https://www.thingiverse.com/thing:7405875",
    license: "CC-BY-NC-ND-4.0",
    complexity: "Advanced",
    machineTags: ["3D Printer"],
    materialTags: ["PLA"],
    tags: ["robotics", "robot-arm", "arduino", "3d-printing"],
    modelFiles: [
      "files/v2RAD_ALL_PARTS.step",
      "files/v2CD_ALL_PARTS.step",
      "files/v2RAD_and_v2CD_PRINT.gcode.3mf",
    ],
    imageFile: "images/v2_R.A.D._FILES.png",
  },
  {
    key: "in-line-fuse-box",
    folder: "In line fuse box - 7406466",
    name: "In-line fuse box",
    description:
      "A compact in-line fuse box for a single automotive blade fuse (regular ATO, " +
      "19.1 × 5.1 × 18.5 mm). Prints in place with working hinges. The 'bolt' version " +
      "has two fixing holes for standalone use; the plain version pairs with a TPU " +
      "cover that carries the fixing holes. Avoid conductive / carbon-fibre filament " +
      "and PLA because of its low melting point.",
    thing: "https://www.thingiverse.com/thing:7406466",
    license: "CC-BY-NC-4.0",
    complexity: "Beginner",
    machineTags: ["3D Printer"],
    materialTags: ["PETG", "TPU"],
    tags: ["automotive", "electronics", "fuse-box", "3d-printing"],
    modelFiles: [
      "files/fusebox.stl",
      "files/fusebox_-_bolt.stl",
      "files/fusebox_cover.stl",
      "files/fusebox.3mf",
      "files/fusebox_cover.3mf",
    ],
    imageFile: "images/fusebox.png",
  },
  {
    key: "tube-end-caps",
    folder:
      "Round, Square & Rectangular Tube End Caps – Free STL Set + Custom Size Configurator - 7404757",
    name: "Round, Square & Rectangular Tube End Caps",
    description:
      "A set of simple tube end caps — round, square and rectangular — for closing off " +
      "open furniture legs, steel profiles, workshop frames, shelves and gates. The " +
      "insertion section sits inside the tube while the wider flange covers the sharp " +
      "edge. The STLs are ready to slice; custom sizes can be generated online with " +
      "the buildyour3d configurator.",
    thing: "https://www.thingiverse.com/thing:7404757",
    license: "CC-BY-SA-4.0",
    complexity: "Beginner",
    machineTags: ["3D Printer"],
    materialTags: ["PLA", "PETG", "ASA"],
    tags: ["furniture", "workshop", "tube-caps", "3d-printing"],
    modelFiles: ["files/kappe_square_518c882c.stl"],
    imageFile: "images/tube-cap-set-round-square-rectangular-thumbnail-en.png",
  },
];

// Demo account. Every field is overridable so the script can be pointed at
// credentials the operator controls.
const account = {
  name: process.env.DEMO_MODELS_NAME || "Dana Prototyper",
  username: process.env.DEMO_MODELS_USERNAME || "dana_prototyper",
  email: process.env.DEMO_MODELS_EMAIL || "dana.prototyper@example.com",
};

function accountChallenges() {
  return {
    whereParentsMet: process.env.DEMO_MODELS_CHALLENGE_1 || "Turin",
    nameFirstPet: process.env.DEMO_MODELS_CHALLENGE_2 || "Bolt",
    nameFirstTeacher: process.env.DEMO_MODELS_CHALLENGE_3 || "Ferraris",
    whereHomeTown: process.env.DEMO_MODELS_CHALLENGE_4 || "Ivrea",
    nameMotherMaid: process.env.DEMO_MODELS_CHALLENGE_5 || "Prototyper",
  };
}

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(
    readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
      .map(line => {
        const equals = line.indexOf("=");
        if (equals < 0) return null;
        return [
          line.slice(0, equals).trim(),
          line
            .slice(equals + 1)
            .trim()
            .replace(/^(['"])(.*)\1$/, "$2"),
        ];
      })
      .filter(Boolean)
  );
}

function loadEnvironment() {
  // A project-local .env takes precedence over the GUI defaults so this
  // importer can be pointed at a different backend without editing the GUI.
  const fromFiles = {
    ...parseEnvFile(join(GUI_DIR, ".env")),
    ...parseEnvFile(join(GUI_DIR, ".env.local")),
    ...parseEnvFile(join(__dirname, ".env")),
    ...parseEnvFile(join(__dirname, ".env.local")),
  };
  const originalEnvironment = { ...process.env };

  const expand = (value, depth = 0) => {
    if (depth > 10) return value;
    return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (match, braced, plain) => {
      const key = braced || plain;
      const replacement = originalEnvironment[key] ?? fromFiles[key];
      return replacement == null ? match : expand(replacement, depth + 1);
    });
  };

  for (const [key, value] of Object.entries(fromFiles)) {
    if (originalEnvironment[key] == null) process.env[key] = expand(value);
  }

  return [".env.local", ".env"].find(name => existsSync(join(GUI_DIR, name))) || "shell environment";
}

function assertRuntime() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24 || typeof File === "undefined") {
    throw new Error(`Node.js 24+ is required (running ${process.version})`);
  }
}

const envSource = loadEnvironment();
const proxyUrl = process.env.BASE_URL || "https://proxy.dpp-dev.ddns.dyne.org";
const client = new InterfacerClient(
  createConfig({
    proxyUrl,
    zenflowsUrl: process.env.NEXT_PUBLIC_ZENFLOWS_URL,
    zenflowsFileUrl: process.env.NEXT_PUBLIC_ZENFLOWS_FILE_URL,
    dppUrl: process.env.NEXT_PUBLIC_DPP_URL,
    feedbackUrl: process.env.NEXT_PUBLIC_FEEDBACK_URL,
    zenflowsAdmin: process.env.NEXT_PUBLIC_ZENFLOWS_ADMIN,
    loshId: process.env.NEXT_PUBLIC_LOSH_ID,
    specs: {
      dpp: process.env.NEXT_PUBLIC_SPEC_DPP,
      machine: process.env.NEXT_PUBLIC_SPEC_MACHINE,
      material: process.env.NEXT_PUBLIC_SPEC_MATERIAL,
      product: process.env.NEXT_PUBLIC_SPEC_PRODUCT,
      service: process.env.NEXT_PUBLIC_SPEC_SERVICE,
    },
  })
);
const tagging = client.tagging;

function authAs(user) {
  client.store.setItem("eddsaPrivateKey", user.privateKey);
  client.store.setItem("eddsaPublicKey", user.publicKey);
  client.store.setItem("authId", user.id);
  client.store.setItem("authName", user.name);
  client.store.setItem("authUsername", user.username);
  client.store.setItem("authEmail", user.email);
  client.graphql.setSigningEnabled(true);
}

async function createOrLoginAccount() {
  client.auth.logout();
  clearInstanceVariablesCache();

  let hmac;
  let existing = false;
  try {
    hmac = await client.auth.requestHmac(account.email, true);
  } catch {
    existing = true;
    hmac = await client.auth.requestHmac(account.email, false);
  }

  await client.auth.deriveKeys(accountChallenges(), account.email, hmac);
  const privateKey = client.store.getItem("eddsaPrivateKey");
  const publicKey = client.store.getItem("eddsaPublicKey");
  if (!privateKey || !publicKey) throw new Error("Could not derive the demo account keys");

  try {
    await client.auth.registerUser({
      name: account.name,
      user: account.username,
      email: account.email,
    });
    console.log("  ✓ Demo account created");
  } catch (error) {
    if (!/exist|taken|registered/i.test(error.message)) throw error;
    existing = true;
    console.log("  ℹ Demo account already exists");
  }

  let profile;
  try {
    profile = await client.auth.login({ email: account.email });
  } catch (error) {
    if (existing) {
      throw new Error(
        `The account ${account.email} exists but was not created with this script's credentials. ` +
          "Set DEMO_MODELS_EMAIL and DEMO_MODELS_CHALLENGE_1..5 to credentials you control.",
        { cause: error }
      );
    }
    throw error;
  }

  try {
    await client.auth.claimDid(profile.id);
  } catch {
    console.log("  ℹ DID already claimed");
  }

  const resolved = {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    email: profile.email,
    privateKey,
    publicKey,
  };
  authAs(resolved);
  console.log(`  ✓ Authenticated as ${profile.name} (${profile.id})`);
  return resolved;
}

function tagsForDesign(model) {
  const machineTags = model.machineTags
    .map(value => tagging.prefixedTag(TAG_PREFIX.MACHINE, value))
    .filter(Boolean);
  const materialTags = model.materialTags
    .map(value => tagging.prefixedTag(TAG_PREFIX.MATERIAL, value))
    .filter(Boolean);
  const licenseTag = tagging.prefixedTag(TAG_PREFIX.LICENSE, model.license);
  const complexityTag = tagging.prefixedTag(TAG_PREFIX.COMPLEXITY, model.complexity);

  return tagging.mergeTags(
    tagging.normalizeUserTags(model.tags),
    machineTags,
    materialTags,
    licenseTag ? [licenseTag] : [],
    complexityTag ? [complexityTag] : [],
    [MANUFACTURABLE_TRUE_TAG]
  );
}

async function mirrorImage(imageUrl, key) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`source returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";")[0] || "image/png";
    const extension = contentType.includes("jpeg")
      ? "jpg"
      : contentType.includes("webp")
        ? "webp"
        : "png";
    const file = new File([await response.arrayBuffer()], `${key}.${extension}`, {
      type: contentType,
    });
    const attachment = await client.files.uploadToDpp(file);
    console.log(`    ✓ Mirrored source image: ${attachment.fileName}`);
    return client.dpp.getFileUrl(attachment.id);
  } catch (error) {
    console.log(`    ⚠ Could not mirror image; retaining source URL: ${error.message}`);
    return imageUrl;
  }
}

async function createDesign(model, owner, image, modelUrls) {
  authAs(owner);
  const processId = await client.resources.createProcess(`creation of ${model.name} by ${owner.name}`);
  const resource = await client.resources.createProject({
    projectType: ProjectType.DESIGN,
    name: model.name,
    note: model.description,
    repo: model.thing,
    license: model.license,
    tags: tagsForDesign(model),
    processId,
    metadata: {
      contributors: [],
      licenses: [{ scope: "Hardware", licenseId: model.license }],
      relations: [],
      declarations: {},
      remote: true,
      design: false,
      image,
      models: modelUrls,
      complexity: model.complexity,
      sourceUrl: rawUrl(model.folder, ""),
      sourceOrganization: "interfacer-3d-demo-models",
    },
  });
  return { id: resource.id, name: resource.name, processId };
}

function resolveModel(model) {
  return {
    key: model.key,
    name: model.name,
    license: model.license,
    thing: model.thing,
    imageUrl: rawUrl(model.folder, model.imageFile),
    modelUrls: model.modelFiles.map(file => rawUrl(model.folder, file)),
  };
}

function saveResults(results) {
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`);
}

export async function main() {
  assertRuntime();

  console.log("═══ interfacer-3d-demo-models injection ═══");
  console.log(`  Environment: ${join("../interfacer-gui", envSource)}`);
  console.log(`  Zenflows:    ${client.config.zenflowsUrl}`);
  console.log(`  DPP:         ${client.config.dppUrl}`);
  console.log(`  Source:      https://github.com/${REPO}`);
  console.log(`  Account:     ${account.name} <${account.email}>`);
  console.log(`  Designs:     ${MODEL_DEFINITIONS.length}`);
  console.log("");

  if (DRY_RUN) {
    for (const model of MODEL_DEFINITIONS) {
      const resolved = resolveModel(model);
      console.log(`  ${resolved.name}  [${resolved.license}]`);
      console.log(`    image:  ${resolved.imageUrl}`);
      for (const url of resolved.modelUrls) console.log(`    model:  ${url}`);
      console.log(`    tags:   ${tagsForDesign(model).join(", ")}`);
      console.log("");
    }
    console.log("Dry run complete: no backend requests were made.");
    return MODEL_DEFINITIONS.map(resolveModel);
  }

  console.log("── Step 1: Validate instance specifications ──");
  clearInstanceVariablesCache();
  const specs = await getInstanceVariables(client.graphql);
  console.log(`  ✓ ${specs.projectDesign?.name} (${specs.projectDesign?.id})`);
  console.log("");

  console.log("── Step 2: Create or authenticate the demo account ──");
  const owner = await createOrLoginAccount();
  console.log("");

  const results = {
    source: {
      repo: `https://github.com/${REPO}`,
      branch: REPO_BRANCH,
      injectedAt: new Date().toISOString(),
    },
    account: {
      id: owner.id,
      name: owner.name,
      username: owner.username,
      email: owner.email,
      publicKey: owner.publicKey,
    },
    designs: [],
  };

  console.log("── Step 3: Create designs ──");
  for (const model of MODEL_DEFINITIONS) {
    const resolved = resolveModel(model);
    console.log(`  ${resolved.name}`);
    const image = await mirrorImage(resolved.imageUrl, model.key);
    const design = await createDesign(model, owner, image, resolved.modelUrls);
    console.log(`    ✓ Design: ${design.id}`);
    results.designs.push({
      ...design,
      sourceKey: model.key,
      license: model.license,
      thing: model.thing,
      modelUrls: resolved.modelUrls,
    });
    saveResults(results);
  }
  console.log("");

  saveResults(results);
  console.log("═══════════════════════════════════════");
  console.log("  3D DEMO MODELS INJECTION COMPLETE");
  console.log("═══════════════════════════════════════");
  console.log(`  Account: ${owner.name} (${owner.id})`);
  console.log(`  Designs: ${results.designs.length}`);
  console.log(`  Output:  ${OUTPUT_PATH}`);
  return results;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch(error => {
    console.error("\n✗ 3D demo models injection failed:", error);
    process.exitCode = 1;
  });
}
