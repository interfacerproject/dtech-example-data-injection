#!/usr/bin/env node

/**
 * Inject the InMachines Open Lab Starter Kit catalog into Interfacer.
 *
 * Source material is stored in data/inmachines.json. It was scraped from the
 * InMachines OLSK and services pages, their linked detail pages, and the linked
 * Open-Lab-Starter-Kit GitHub repositories.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
const DATA_PATH = join(__dirname, "data/inmachines.json");
const OUTPUT_PATH = join(__dirname, "results-inmachines.json");
const DRY_RUN = process.argv.includes("--dry-run");
const DPPS_ONLY = process.argv.includes("--dpps-only");

// ProjectType is a type-only export in @dyne/interfacer-client 0.6.1.
const ProjectType = Object.freeze({ DESIGN: "Design", PRODUCT: "Product", SERVICE: "Service" });

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
}

function assertRuntime() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24 || typeof File === "undefined") {
    throw new Error(`Node.js 24+ is required (running ${process.version})`);
  }
}

function loadDataset() {
  if (!existsSync(DATA_PATH)) throw new Error(`Missing scraped dataset: ${DATA_PATH}`);
  const data = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  if (!data.organization?.name || !Array.isArray(data.designs) || !Array.isArray(data.services)) {
    throw new Error("Invalid InMachines dataset");
  }

  const designKeys = new Set();
  for (const design of data.designs) {
    for (const field of ["key", "name", "description", "repo", "license", "sourceUrl", "imageUrl"]) {
      if (!design[field]) throw new Error(`Design ${design.key || "<unknown>"} is missing ${field}`);
    }
    if (designKeys.has(design.key)) throw new Error(`Duplicate design key: ${design.key}`);
    designKeys.add(design.key);
    for (const url of [design.repo, design.sourceUrl, design.imageUrl, design.bomUrl, ...design.modelUrls]) {
      if (url) new URL(url);
    }
  }
  for (const service of data.services) {
    for (const field of ["name", "description", "repo", "sourceUrl", "imageUrl"]) {
      if (!service[field]) throw new Error(`Service ${service.name || "<unknown>"} is missing ${field}`);
    }
    for (const url of [service.repo, service.sourceUrl, service.imageUrl]) new URL(url);
  }
  return data;
}

loadEnvironment();
const dataset = loadDataset();
const organization = {
  ...dataset.organization,
  name: process.env.INMACHINES_NAME || dataset.organization.name,
  username: process.env.INMACHINES_USERNAME || dataset.organization.username,
  email: process.env.INMACHINES_EMAIL || dataset.organization.email,
};

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

function accountChallenges() {
  return {
    whereParentsMet: process.env.INMACHINES_CHALLENGE_1 || "Hamburg",
    nameFirstPet: process.env.INMACHINES_CHALLENGE_2 || "OLOS",
    nameFirstTeacher: process.env.INMACHINES_CHALLENGE_3 || "Fab Lab",
    whereHomeTown: process.env.INMACHINES_CHALLENGE_4 || "Schwarzenbek",
    nameMotherMaid: process.env.INMACHINES_CHALLENGE_5 || "InMachines",
  };
}

async function createOrLoginAccount() {
  client.auth.logout();
  clearInstanceVariablesCache();

  let hmac;
  let existing = false;
  try {
    hmac = await client.auth.requestHmac(organization.email, true);
  } catch {
    existing = true;
    hmac = await client.auth.requestHmac(organization.email, false);
  }

  await client.auth.deriveKeys(accountChallenges(), organization.email, hmac);
  const privateKey = client.store.getItem("eddsaPrivateKey");
  const publicKey = client.store.getItem("eddsaPublicKey");
  if (!privateKey || !publicKey) throw new Error("Could not derive the InMachines account keys");

  try {
    await client.auth.registerUser({
      name: organization.name,
      user: organization.username,
      email: organization.email,
    });
    console.log("  ✓ InMachines account created");
  } catch (error) {
    if (!/exist|taken|registered/i.test(error.message)) throw error;
    existing = true;
    console.log("  ℹ InMachines account already exists");
  }

  let profile;
  try {
    profile = await client.auth.login({ email: organization.email });
  } catch (error) {
    if (existing) {
      throw new Error(
        `The account ${organization.email} exists but was not created with this script's credentials. ` +
          "Set INMACHINES_EMAIL and INMACHINES_CHALLENGE_1..5 to credentials you control.",
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

  const account = {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    email: profile.email,
    privateKey,
    publicKey,
  };
  authAs(account);
  console.log(`  ✓ Authenticated as ${profile.name} (${profile.id})`);
  return account;
}

function tagsForDesign(design) {
  const machineTags = design.machineTags
    .map(value => tagging.prefixedTag(TAG_PREFIX.MACHINE, value))
    .filter(Boolean);
  const materialTags = design.materialTags
    .map(value => tagging.prefixedTag(TAG_PREFIX.MATERIAL, value))
    .filter(Boolean);
  const licenseTag = tagging.prefixedTag(TAG_PREFIX.LICENSE, design.license);
  const complexityTag = tagging.prefixedTag(TAG_PREFIX.COMPLEXITY, design.complexity);

  return tagging.mergeTags(
    tagging.normalizeUserTags(design.tags),
    machineTags,
    materialTags,
    licenseTag ? [licenseTag] : [],
    complexityTag ? [complexityTag] : [],
    [MANUFACTURABLE_TRUE_TAG]
  );
}

function tagsForProduct(design) {
  const licenseTag = tagging.prefixedTag(TAG_PREFIX.LICENSE, design.license);
  const machineTags = design.machineTags
    .map(value => tagging.prefixedTag(TAG_PREFIX.MACHINE, value))
    .filter(Boolean);
  const materialTags = design.materialTags
    .map(value => tagging.prefixedTag(TAG_PREFIX.MATERIAL, value))
    .filter(Boolean);
  return tagging.mergeTags(
    tagging.normalizeUserTags([...design.tags, "manufactured-by-inmachines"]),
    tagging.derivedProductFilterTags(design.productFilters),
    machineTags,
    materialTags,
    licenseTag ? [licenseTag] : []
  );
}

function tagsForService(service) {
  return tagging.mergeTags(
    tagging.normalizeUserTags(service.tags),
    tagging.derivedServiceFilterTags({
      serviceType: service.serviceType,
      availability: service.availability,
    })
  );
}

function filenameFromUrl(url, fallback) {
  try {
    const filename = decodeURIComponent(basename(new URL(url).pathname)).replace(/[^a-zA-Z0-9._-]+/g, "-");
    return filename || fallback;
  } catch {
    return fallback;
  }
}

async function mirrorImage(imageUrl, key) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`source returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const extension = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const file = new File(
      [await response.arrayBuffer()],
      filenameFromUrl(imageUrl, `${key}.${extension}`),
      { type: contentType }
    );
    const attachment = await client.files.uploadToDpp(file);
    console.log(`    ✓ Mirrored source image: ${attachment.fileName}`);
    return client.dpp.getFileUrl(attachment.id);
  } catch (error) {
    console.log(`    ⚠ Could not mirror image; retaining source URL: ${error.message}`);
    return imageUrl;
  }
}

async function createDesign(design, account, image) {
  authAs(account);
  const processId = await client.resources.createProcess(`creation of ${design.name} by ${organization.name}`);
  const resource = await client.resources.createProject({
    projectType: ProjectType.DESIGN,
    name: design.name,
    note: design.description,
    repo: design.repo,
    license: design.license,
    tags: tagsForDesign(design),
    processId,
    metadata: {
      contributors: [],
      licenses: [{ scope: "Hardware", licenseId: design.license }],
      relations: [],
      declarations: {},
      remote: true,
      design: false,
      image,
      models: design.modelUrls,
      bom: design.bomUrl,
      complexity: design.complexity,
      sourceUrl: design.sourceUrl,
      sourceOrganization: organization.name,
    },
  });
  return { id: resource.id, name: resource.name, processId };
}

async function createProduct(design, linkedDesign, account, image, locationId) {
  authAs(account);
  const name = `${design.name} — InMachines build`;
  const processId = await client.resources.createProcess(`creation of ${name} by ${organization.name}`);
  const resource = await client.resources.createProject({
    projectType: ProjectType.PRODUCT,
    name,
    note: design.description,
    repo: design.repo,
    license: design.license,
    tags: tagsForProduct(design),
    locationId,
    processId,
    metadata: {
      contributors: [],
      licenses: [{ scope: "Hardware", licenseId: design.license }],
      relations: [],
      declarations: { repairable: "yes", recyclable: "yes", certifications: [] },
      remote: false,
      design: linkedDesign.id,
      image,
      availability: "Contact InMachines",
      sourceUrl: design.sourceUrl,
      sourceOrganization: organization.name,
    },
  });
  await client.resources.citeResource(linkedDesign.id, processId);
  return { id: resource.id, name: resource.name, processId, designId: linkedDesign.id };
}

async function createService(service, account, image, locationId) {
  authAs(account);
  const processId = await client.resources.createProcess(`creation of ${service.name} by ${organization.name}`);
  const resource = await client.resources.createProject({
    projectType: ProjectType.SERVICE,
    name: service.name,
    note: service.description,
    repo: service.repo,
    tags: tagsForService(service),
    locationId,
    processId,
    metadata: {
      contributors: [],
      licenses: [],
      relations: [],
      declarations: {},
      remote: service.remote || false,
      design: false,
      image,
      sourceUrl: service.sourceUrl,
      sourceOrganization: organization.name,
    },
  });
  return { id: resource.id, name: resource.name, processId };
}

function saveResults(results) {
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`);
}

async function createProductDpps(results, account) {
  authAs(account);
  results.dpps ||= [];

  for (const product of results.products) {
    const definition = dataset.designs.find(design => design.key === product.sourceKey);
    if (!definition) throw new Error(`No source definition found for product ${product.id}`);

    console.log(`  ${product.name}`);
    const completedIndexes = new Set(
      results.dpps.filter(dpp => dpp.productId === product.id).map(dpp => dpp.index)
    );

    for (let index = 0; index < 3; index += 1) {
      if (completedIndexes.has(index)) {
        console.log(`    ℹ DPP #${index + 1} already recorded; skipping`);
        continue;
      }

      const number = index + 1;
      const dpp = await client.dpp.createDpp({
        productId: product.id,
        batchType: index === 0 ? "batch" : "unit",
        batchId: `OLSK-${definition.key.toUpperCase()}-${number}`,
        status: "active",
        productOverview: {
          productName: { type: "Text", value: product.name },
          productDescription: { type: "Text", value: definition.description },
          modelName: { type: "Text", value: definition.name },
          brandName: { type: "Text", value: organization.name },
          countryOfOrigin: { type: "Text", value: "Germany" },
          conditionOfTheProduct: { type: "Text", value: "New" },
          safetyInstructions: { type: "Text", value: `Documentation: ${definition.repo}` },
        },
        reparability: {
          serviceAndRepairInstructions: {
            type: "Text",
            value: `Open-source service and repair documentation: ${definition.repo}`,
          },
          availabilityOfSpareParts: { type: "Text", value: "Contact InMachines" },
        },
        certificates: {
          nameOfCertificate: { type: "Text", value: `Open hardware license: ${definition.license}` },
        },
        recyclability: {
          materialComposition: { type: "Text", value: definition.materialTags.join(", ") },
          recyclingInstructions: { type: "Text", value: "Contact InMachines for component-level guidance" },
        },
        economicOperator: {
          companyName: { type: "Text", value: organization.name },
          addressLine1: { type: "Text", value: organization.location.address },
          contactInformation: {
            type: "Text",
            value: `${organization.email} — ${organization.website}`,
          },
        },
      });

      const name = `DPP #${number} for ${product.name}`;
      const resource = await client.resources.createDppResource({
        name,
        note: `Digital Product Passport #${number} for ${product.name}`,
        dppUlid: dpp.insertedID,
      });
      await client.resources.citeResource(resource.id, product.processId);

      results.dpps.push({
        dppUlid: dpp.insertedID,
        resourceId: resource.id,
        productId: product.id,
        sourceKey: product.sourceKey,
        index,
      });
      saveResults(results);
      console.log(`    ✓ DPP #${number}: ${dpp.insertedID} / ${resource.id}`);
    }
  }
}

function printDatasetSummary() {
  console.log("═══ InMachines dataset ═══");
  console.log(`  Scraped:  ${dataset.scrapedAt}`);
  console.log(`  Account:  ${organization.name} <${organization.email}>`);
  console.log(`  Designs:  ${dataset.designs.length}`);
  console.log(`  Products: ${dataset.designs.length}`);
  console.log(`  Services: ${dataset.services.length}`);
}

export async function main() {
  assertRuntime();
  printDatasetSummary();
  if (DRY_RUN) {
    console.log("\nDry run complete: no backend requests were made.");
    return dataset;
  }

  console.log(`  Zenflows: ${client.config.zenflowsUrl}`);
  console.log(`  DPP:      ${client.config.dppUrl}`);
  console.log("");

  console.log("── Step 1: Validate instance specifications ──");
  clearInstanceVariablesCache();
  const specs = await getInstanceVariables(client.graphql);
  console.log(`  ✓ ${specs.projectDesign.name}, ${specs.projectProduct?.name}, ${specs.projectService?.name}`);
  console.log("");

  console.log("── Step 2: Create or authenticate the InMachines account ──");
  const account = await createOrLoginAccount();
  console.log("");

  if (DPPS_ONLY) {
    if (!existsSync(OUTPUT_PATH)) {
      throw new Error(`${OUTPUT_PATH} is required for --dpps-only`);
    }
    const previousResults = JSON.parse(readFileSync(OUTPUT_PATH, "utf8"));
    if (!Array.isArray(previousResults.products) || previousResults.products.length === 0) {
      throw new Error("The previous results do not contain any products");
    }
    console.log("── Add three DPPs to each previously created product ──");
    await createProductDpps(previousResults, account);
    console.log(`\n✓ DPP backfill complete: ${previousResults.dpps.length} DPPs recorded in ${OUTPUT_PATH}`);
    return previousResults;
  }

  console.log("── Step 3: Create the InMachines location ──");
  const location = await client.resources.createLocation(organization.location);
  console.log(`  ✓ ${organization.location.address} (${location.id})`);
  console.log("");

  const results = {
    source: {
      scrapedAt: dataset.scrapedAt,
      pages: [
        "https://www.inmachines.net/open-lab-starter-kit",
        "https://www.inmachines.net/services8f05a8a7",
      ],
    },
    account: {
      id: account.id,
      name: account.name,
      username: account.username,
      email: account.email,
      publicKey: account.publicKey,
    },
    location: { ...organization.location, id: location.id },
    designs: [],
    products: [],
    services: [],
    dpps: [],
  };

  console.log("── Step 4: Create OLSK designs and linked products ──");
  for (const designDefinition of dataset.designs) {
    console.log(`  ${designDefinition.name}`);
    const image = await mirrorImage(designDefinition.imageUrl, designDefinition.key);
    const design = await createDesign(designDefinition, account, image);
    console.log(`    ✓ Design: ${design.id}`);
    const product = await createProduct(designDefinition, design, account, image, location.id);
    console.log(`    ✓ Product: ${product.id}`);
    results.designs.push({ ...design, sourceKey: designDefinition.key });
    results.products.push({ ...product, sourceKey: designDefinition.key });
  }
  console.log("");

  console.log("── Step 5: Create InMachines services ──");
  for (const [index, serviceDefinition] of dataset.services.entries()) {
    console.log(`  ${serviceDefinition.name}`);
    const image = await mirrorImage(serviceDefinition.imageUrl, `service-${index + 1}`);
    const service = await createService(serviceDefinition, account, image, location.id);
    console.log(`    ✓ Service: ${service.id}`);
    results.services.push({ ...service, sourceUrl: serviceDefinition.sourceUrl });
  }
  console.log("");

  saveResults(results);
  console.log("── Step 6: Create three DPPs per product ──");
  await createProductDpps(results, account);

  saveResults(results);
  console.log("");
  console.log("═══════════════════════════════════════");
  console.log("  INMACHINES INJECTION COMPLETE");
  console.log("═══════════════════════════════════════");
  console.log(`  Designs:  ${results.designs.length}`);
  console.log(`  Products: ${results.products.length}`);
  console.log(`  Services: ${results.services.length}`);
  console.log(`  DPPs:     ${results.dpps.length}`);
  console.log(`  Output:   ${OUTPUT_PATH}`);
  return results;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch(error => {
    console.error("\n✗ InMachines data injection failed:", error);
    process.exitCode = 1;
  });
}
