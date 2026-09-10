#!/usr/bin/env node

/**
 * Interfacer demo-data injector.
 *
 * This is intentionally implemented only through the public
 * @dyne/interfacer-client API, mirroring the current interfacer-gui data model.
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

// ProjectType is currently a type-only SDK export, so keep the runtime values
// used by Zenflows and interfacer-gui here.
const ProjectType = Object.freeze({
  DESIGN: "Design",
  PRODUCT: "Product",
  SERVICE: "Service",
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
const GUI_DIR = resolve(__dirname, "../interfacer-gui");
const DEFAULT_MODEL_URL =
  "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/stl/ascii/slotted_disk.stl";

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
        const key = line.slice(0, equals).trim();
        const value = line
          .slice(equals + 1)
          .trim()
          .replace(/^(['"])(.*)\1$/, "$2");
        return [key, value];
      })
      .filter(Boolean)
  );
}

function loadGuiEnvironment() {
  // Next.js gives .env.local precedence over .env. Explicit shell variables
  // still take precedence over both files.
  const fromFiles = {
    ...parseEnvFile(join(GUI_DIR, ".env")),
    ...parseEnvFile(join(GUI_DIR, ".env.local")),
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

const envSource = loadGuiEnvironment();
const proxyUrl = process.env.BASE_URL || "https://proxy.dpp-dev.ddns.dyne.org";
const feedbackUrl = process.env.NEXT_PUBLIC_FEEDBACK_URL || "https://feedback.dpp-dev.ddns.dyne.org";
const locationSearchUrl =
  process.env.NEXT_PUBLIC_LOCATION_AUTOCOMPLETE || "https://nominatim.openstreetmap.org/search";
const modelUrl = process.env.MODEL_URL || DEFAULT_MODEL_URL;

const client = new InterfacerClient(
  createConfig({
    proxyUrl,
    zenflowsUrl: process.env.NEXT_PUBLIC_ZENFLOWS_URL,
    zenflowsFileUrl: process.env.NEXT_PUBLIC_ZENFLOWS_FILE_URL,
    dppUrl: process.env.NEXT_PUBLIC_DPP_URL,
    feedbackUrl,
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

function assertNodeRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24 || typeof File === "undefined") {
    throw new Error(`Node.js 24+ is required (running ${process.version})`);
  }
}

function authAs(user) {
  client.store.setItem("eddsaPrivateKey", user.privateKey);
  client.store.setItem("eddsaPublicKey", user.publicKey);
  client.store.setItem("authId", user.id);
  client.store.setItem("authName", user.name);
  client.store.setItem("authUsername", user.username);
  client.store.setItem("authEmail", user.email);
  client.graphql.setSigningEnabled(true);
}

function tagsWithCommonFields(definition, extraTags = []) {
  return tagging.mergeTags(
    tagging.normalizeUserTags(definition.tags || []),
    definition.license ? [tagging.prefixedTag(TAG_PREFIX.LICENSE, definition.license)].filter(Boolean) : [],
    extraTags
  );
}

function projectMetadata(definition, image, extra = {}) {
  return {
    contributors: [],
    licenses: definition.license
      ? [{ scope: definition.licenseScope || "Hardware", licenseId: definition.license }]
      : [],
    relations: [],
    declarations: definition.declarations || {},
    remote: definition.remote ?? false,
    design: false,
    image: image || undefined,
    ...extra,
  };
}

async function uploadImage(seed) {
  try {
    const response = await fetch(`https://picsum.photos/seed/${encodeURIComponent(seed)}/800/600`);
    if (!response.ok) throw new Error(`image download returned HTTP ${response.status}`);

    const file = new File([await response.arrayBuffer()], `${seed}.jpg`, { type: "image/jpeg" });
    const attachment = await client.files.uploadToDpp(file);
    console.log(`    ✓ Image: ${attachment.fileName}`);
    return client.dpp.getFileUrl(attachment.id);
  } catch (error) {
    console.log(`    ⚠ Image skipped: ${error.message}`);
    return null;
  }
}

async function lookupLocation(query) {
  try {
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: "1",
    });
    const separator = locationSearchUrl.includes("?") ? "&" : "?";
    const response = await fetch(`${locationSearchUrl}${separator}${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const matches = await response.json();
    if (!Array.isArray(matches) || !matches[0]) return null;

    return {
      address: matches[0].display_name || query,
      lat: Number(matches[0].lat),
      lng: Number(matches[0].lon),
    };
  } catch (error) {
    console.log(`    ⚠ Location lookup skipped: ${error.message}`);
    return null;
  }
}

async function createLocation(name, query) {
  const location = await lookupLocation(query);
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return { id: undefined, remote: true };
  }

  const spatialThing = await client.resources.createLocation({ name, ...location });
  console.log(`    ✓ Location: ${name} (${location.lat.toFixed(4)}, ${location.lng.toFixed(4)})`);
  return { id: spatialThing.id, remote: false };
}

async function createProject(definition, owner, fallbackImage) {
  authAs(owner);
  const image = (await uploadImage(definition.imageSeed)) || fallbackImage;
  const location = definition.location
    ? await createLocation(definition.location[0], definition.location[1])
    : { id: undefined, remote: true };
  const processId = await client.resources.createProcess(`creation of ${definition.name} by ${owner.name}`);

  const project = await client.resources.createProject({
    projectType: definition.projectType,
    name: definition.name,
    note: definition.description,
    tags: definition.classifiedAs,
    repo: definition.repo,
    license: definition.license,
    locationId: location.id,
    processId,
    metadata: projectMetadata(definition, image, {
      remote: definition.projectType === ProjectType.DESIGN ? true : location.remote,
      ...definition.metadata,
    }),
  });

  return { id: project.id, name: project.name, processId, image };
}

async function createUsers() {
  const definitions = [
    {
      name: "Alice Designer",
      username: "alice_designer",
      email: "alice.designer@example.com",
      challenges: {
        whereParentsMet: "Paris",
        nameFirstPet: "Rex",
        nameFirstTeacher: "Smith",
        whereHomeTown: "Berlin",
        nameMotherMaid: "Maria",
      },
    },
    {
      name: "Bob Maker",
      username: "bob_maker",
      email: "bob.maker@example.com",
      challenges: {
        whereParentsMet: "London",
        nameFirstPet: "Max",
        nameFirstTeacher: "Johnson",
        whereHomeTown: "Tokyo",
        nameMotherMaid: "Anna",
      },
    },
    {
      name: "Clara Reviewer",
      username: "clara_reviewer",
      email: "clara.reviewer@example.com",
      challenges: {
        whereParentsMet: "Rome",
        nameFirstPet: "Luna",
        nameFirstTeacher: "Brown",
        whereHomeTown: "Madrid",
        nameMotherMaid: "Sophia",
      },
    },
  ];

  const users = [];
  for (const definition of definitions) {
    console.log(`  User: ${definition.name} (${definition.email})`);
    client.auth.logout();
    clearInstanceVariablesCache();

    let hmac;
    try {
      hmac = await client.auth.requestHmac(definition.email, true);
    } catch {
      hmac = await client.auth.requestHmac(definition.email, false);
      console.log("    ℹ Existing registration");
    }

    await client.auth.deriveKeys(definition.challenges, definition.email, hmac);
    const privateKey = client.store.getItem("eddsaPrivateKey");
    const publicKey = client.store.getItem("eddsaPublicKey");
    if (!privateKey || !publicKey) throw new Error(`Key derivation failed for ${definition.email}`);

    try {
      await client.auth.registerUser({
        name: definition.name,
        user: definition.username,
        email: definition.email,
      });
      console.log("    ✓ Person created");
    } catch (error) {
      if (!/exist|taken|registered/i.test(error.message)) throw error;
      console.log("    ℹ Person already exists");
    }

    const profile = await client.auth.login({ email: definition.email });
    try {
      await client.auth.claimDid(profile.id);
    } catch {
      console.log("    ℹ DID already claimed");
    }

    console.log(`    ✓ Verified: ${profile.id}`);
    users.push({ ...definition, id: profile.id, privateKey, publicKey });
  }
  return users;
}

export async function main() {
  assertNodeRuntime();
  clearInstanceVariablesCache();

  console.log("═══ Interfacer demo-data injection (SDK) ═══");
  console.log(`  Environment: ${join("../interfacer-gui", envSource)}`);
  console.log(`  Zenflows:    ${client.config.zenflowsUrl}`);
  console.log(`  DPP:         ${client.config.dppUrl}`);
  console.log(`  Feedback:    ${client.config.feedbackUrl}`);
  console.log(`  SDK:         @dyne/interfacer-client ${packageMetadata.dependencies["@dyne/interfacer-client"]}`);
  console.log("");

  console.log("── Step 1: Validate instance specifications ──");
  const specs = await getInstanceVariables(client.graphql);
  console.log(`  Design:  ${specs.projectDesign?.id}`);
  console.log(`  Product: ${specs.projectProduct?.id}`);
  console.log(`  Service: ${specs.projectService?.id}`);
  console.log(`  Machine: ${specs.machine?.id || client.config.specs?.machine || "missing"}`);
  console.log(`  DPP:     ${specs.dpp?.id || client.config.specs?.dpp || "missing"}`);
  console.log("");

  console.log("── Step 2: Create users ──");
  const users = await createUsers();
  const [alice, bob, clara] = users;
  const results = {
    users: users.map(({ id, name, username, email, publicKey }) => ({ id, name, username, email, publicKey })),
    machines: [],
    designs: [],
    services: [],
    products: [],
    dpps: [],
    feedback: [],
  };
  console.log("");

  console.log("── Step 3: Create machines ──");
  authAs(bob);
  const machineDefinitions = [
    { name: "Prusa i3 MK3S+", type: "3D Printer", location: "FabLab Milano", note: "Reliable FDM printer for PLA, PETG, and TPU prototypes.", imageSeed: "prusa-3d-printer" },
    { name: "Shapeoko Pro XXL", type: "CNC Mill", location: "TechHub Berlin", note: "Desktop CNC mill for wood, acrylic, and aluminum parts.", imageSeed: "desktop-cnc-mill" },
    { name: "Epilog Fusion Pro", type: "Laser Cutter", location: "Makerspace Amsterdam", note: "CO₂ laser cutter for plywood, acrylic, and engraving.", imageSeed: "laser-cutter-workshop" },
    { name: "Bantam Tools PCB Mill", type: "PCB Mill", location: "OpenLab London", note: "Precision desktop milling machine for rapid PCB prototyping.", imageSeed: "pcb-milling-machine" },
  ];
  for (const definition of machineDefinitions) {
    console.log(`  Machine: ${definition.name}`);
    const image = await uploadImage(definition.imageSeed);
    const machine = await client.resources.createMachine({
      name: definition.name,
      type: definition.type,
      location: definition.location,
      note: definition.note,
      image: image || undefined,
      metadata: { remote: false },
    });
    console.log(`    ✓ ${machine.id}`);
    results.machines.push({ id: machine.id, name: machine.name, type: definition.type });
  }
  console.log("");

  console.log("── Step 4: Create designs ──");
  authAs(alice);
  const fallbackImage = await uploadImage("interfacer-placeholder");
  const designDefinitions = [
    { name: "Modular Gear System", description: "A parametric modular gear system for 3D printing, with customizable tooth profiles, sizes, and configurations.", repo: "https://github.com/example/modular-gear", license: "CC-BY-SA-4.0", tags: ["3d-printing", "mechanical", "parametric"], complexity: "Intermediate", machines: ["3D Printer"], materials: ["PLA", "PETG"], powerSources: ["230V AC"], powerRequirementW: 150, imageSeed: "modular-gears-3d-printing" },
    { name: "Ergonomic Handle Grip", description: "An ergonomic handle grip optimized for comfort and durability, with textured surfaces and shock absorption.", repo: "https://github.com/example/ergo-handle", license: "GPL-3.0", tags: ["ergonomics", "accessibility", "3d-printing"], complexity: "Beginner", machines: ["3D Printer"], materials: ["TPU", "PLA"], powerSources: ["230V AC"], powerRequirementW: 120, imageSeed: "ergonomic-handle-grip-design" },
    { name: "Solar Panel Mount Bracket", description: "A universal, weather-resistant solar-panel mounting bracket designed for easy installation with standard tools.", repo: "https://github.com/example/solar-bracket", license: "CC0-1.0", tags: ["solar", "renewable-energy", "mounting"], complexity: "Advanced", machines: ["CNC Mill", "Drill Press"], materials: ["Aluminum", "Steel"], powerSources: ["230V AC", "Solar Compatible"], powerRequirementW: 500, imageSeed: "solar-panel-mounting-bracket" },
    { name: "Bicycle Cargo Rack", description: "A lightweight, sturdy bicycle cargo rack compatible with most frame types and rated to carry 25 kg.", repo: "https://github.com/example/bike-rack", license: "CC-BY-4.0", tags: ["bicycle", "transportation", "cargo"], complexity: "Expert", machines: ["CNC Mill", "Band Saw"], materials: ["Aluminum", "Steel"], powerSources: ["230V AC"], powerRequirementW: 750, imageSeed: "bicycle-cargo-rack-metal" },
    { name: "Desktop Cable Organizer", description: "A modular cable-management system that prevents tangling and improves workspace organization.", repo: "https://github.com/example/cable-organizer", license: "MIT", tags: ["organization", "workspace", "modular"], complexity: "Easy", machines: ["3D Printer", "Laser Cutter"], materials: ["PLA", "Acrylic"], powerSources: ["230V AC"], powerRequirementW: 100, imageSeed: "cable-management-desk-organizer" },
  ];

  for (const definition of designDefinitions) {
    console.log(`  Design: ${definition.name}`);
    const machineTags = definition.machines.map(value => tagging.prefixedTag(TAG_PREFIX.MACHINE, value)).filter(Boolean);
    const materialTags = definition.materials.map(value => tagging.prefixedTag(TAG_PREFIX.MATERIAL, value)).filter(Boolean);
    const powerTags = definition.powerSources.map(value => tagging.prefixedTag(TAG_PREFIX.POWER_COMPAT, value)).filter(Boolean);
    const complexityTag = tagging.prefixedTag(TAG_PREFIX.COMPLEXITY, definition.complexity);
    const classifiedAs = tagsWithCommonFields(definition, [
      ...machineTags,
      ...materialTags,
      ...powerTags,
      ...(complexityTag ? [complexityTag] : []),
      MANUFACTURABLE_TRUE_TAG,
    ]);
    const created = await createProject(
      {
        ...definition,
        projectType: ProjectType.DESIGN,
        classifiedAs,
        remote: true,
        metadata: {
          models: [modelUrl],
          bom: `${definition.repo}/blob/main/BOM.csv`,
          complexity: definition.complexity,
          powerSources: definition.powerSources,
          powerRequirementW: definition.powerRequirementW,
        },
      },
      alice,
      fallbackImage
    );
    console.log(`    ✓ ${created.id}`);
    results.designs.push({ ...created, complexity: definition.complexity, modelUrl });
  }
  console.log("");

  console.log("── Step 5: Create services ──");
  const serviceDefinitions = [
    { name: "3D Printing Consultation", description: "Expert consultation for material selection, print optimization, and post-processing, available remotely or on site.", repo: "https://example.com/3d-consulting", license: "CC-BY-SA-4.0", licenseScope: "Documentation", tags: ["consulting", "3d-printing", "education"], serviceType: ["Fabrication", "Learning & Education"], availability: ["Booking Required", "Weekends Available"], location: ["Makerspace Amsterdam", "Amsterdam, Netherlands"], imageSeed: "3d-printer-filament-colors" },
    { name: "Custom PCB Design Service", description: "Professional PCB design and prototyping, from schematic capture through manufacturing files.", repo: "https://example.com/pcb-design", license: "GPL-3.0", licenseScope: "Documentation", tags: ["electronics", "pcb", "prototyping"], serviceType: ["Fabrication", "Space Access"], availability: ["Available Now", "Weekdays Only"], location: ["TechHub Berlin", "Berlin, Germany"], imageSeed: "printed-circuit-board-electronics" },
    { name: "Sustainable Packaging Consulting", description: "Lifecycle analysis, material selection, and design optimization for low-impact packaging.", repo: "https://example.com/eco-packaging", license: "CC0-1.0", licenseScope: "Documentation", tags: ["sustainability", "packaging", "consulting"], serviceType: ["Learning & Education"], availability: ["Available Now", "Weekends Available"], location: ["GreenLab Barcelona", "Barcelona, Spain"], imageSeed: "sustainable-eco-packaging-nature" },
  ];
  for (const definition of serviceDefinitions) {
    console.log(`  Service: ${definition.name}`);
    const classifiedAs = tagsWithCommonFields(
      definition,
      tagging.derivedServiceFilterTags({
        serviceType: definition.serviceType,
        availability: definition.availability,
      })
    );
    const created = await createProject(
      { ...definition, projectType: ProjectType.SERVICE, classifiedAs },
      bob,
      fallbackImage
    );
    console.log(`    ✓ ${created.id}`);
    results.services.push(created);
  }
  console.log("");

  console.log("── Step 6: Create products linked to designs ──");
  const productDefinitions = [
    { name: "Premium Gear Set", description: "High-precision modular gear set manufactured from recycled PLA, with five gear sizes and compatible axles.", repo: "https://github.com/example/premium-gears", license: "CC-BY-SA-4.0", tags: ["gears", "robotics", "mechanical"], designIndex: 0, price: "€49.00", availability: "In stock", machines: ["3D Printer"], materials: ["PLA"], location: ["FabLab Milano", "Milan, Italy"], imageSeed: "precision-gears-mechanical-metal", filters: { categories: ["Electronics", "Tools"], powerCompatibility: ["120V AC", "Battery Powered"], replicability: ["High"], recyclabilityPct: 80, repairability: true, powerRequirementW: 150, energyKwh: 50, co2Kg: 5 } },
    { name: "ErgoGrip Pro Handle", description: "Professional ergonomic handle with a soft-touch TPU overmold on a rigid PLA core.", repo: "https://github.com/example/ergogrip-pro", license: "CC-BY-SA-4.0", tags: ["ergonomics", "professional", "tools"], designIndex: 1, price: "€24.90", availability: "Ships in 2–3 days", machines: ["3D Printer"], materials: ["TPU", "PLA"], location: ["Hackerspace Paris", "Paris, France"], imageSeed: "ergonomic-tool-handle-professional", filters: { categories: ["Tools", "Wearables"], powerCompatibility: ["Battery Powered", "USB-C"], replicability: ["Medium"], recyclabilityPct: 65, repairability: true, powerRequirementW: 10, energyKwh: 20, co2Kg: 1.5 } },
    { name: "SunMount Universal Bracket", description: "Heavy-duty adjustable solar-panel bracket made from recycled aluminum and stainless hardware.", repo: "https://github.com/example/sunmount", license: "CC0-1.0", tags: ["solar", "renewable", "outdoor"], designIndex: 2, price: "€89.00", availability: "Made to order", machines: ["CNC Mill", "Drill Press"], materials: ["Aluminum", "Steel"], location: ["SolarLab Valencia", "Valencia, Spain"], imageSeed: "solar-panel-renewable-energy-sun", filters: { categories: ["Energy", "Sustainability"], powerCompatibility: ["220-240V AC", "24V DC"], replicability: ["Low", "Medium"], recyclabilityPct: 95, repairability: true, powerRequirementW: 500, energyKwh: 200, co2Kg: 10 } },
    { name: "Urban Cargo Rack XL", description: "Extra-large bicycle cargo rack with integrated pannier rails and powder-coated steel construction.", repo: "https://github.com/example/urban-rack-xl", license: "CC-BY-4.0", tags: ["bicycle", "urban", "transport"], designIndex: 3, price: "€129.00", availability: "In stock", machines: ["CNC Mill", "Band Saw"], materials: ["Steel", "Aluminum"], location: ["BikeKitchen Copenhagen", "Copenhagen, Denmark"], imageSeed: "bike-cargo-rack-urban-commute", filters: { categories: ["Furniture", "Sustainability"], powerCompatibility: ["USB-C", "12V DC"], replicability: ["Medium"], recyclabilityPct: 90, repairability: true, powerRequirementW: 0, energyKwh: 300, co2Kg: 15 } },
    { name: "DeskMate Cable System", description: "Complete cable-management kit with tray, clips, routing channels, adhesive mounts, and cable ties.", repo: "https://github.com/example/deskmate", license: "MIT", tags: ["desk", "organization", "office"], designIndex: 4, price: "€34.50", availability: "In stock", machines: ["3D Printer", "Laser Cutter"], materials: ["PLA", "Acrylic"], location: ["OpenLab London", "London, United Kingdom"], imageSeed: "cable-management-desk-workspace", filters: { categories: ["Education", "Medical", "Home renovation"], powerCompatibility: ["12V DC", "Battery Powered"], replicability: ["High"], recyclabilityPct: 70, repairability: true, powerRequirementW: 75, energyKwh: 100, co2Kg: 2.5 } },
  ];

  for (const definition of productDefinitions) {
    console.log(`  Product: ${definition.name}`);
    const design = results.designs[definition.designIndex];
    const machineTags = definition.machines.map(value => tagging.prefixedTag(TAG_PREFIX.MACHINE, value)).filter(Boolean);
    const materialTags = definition.materials.map(value => tagging.prefixedTag(TAG_PREFIX.MATERIAL, value)).filter(Boolean);
    const classifiedAs = tagsWithCommonFields(definition, [
      ...tagging.derivedProductFilterTags(definition.filters),
      ...machineTags,
      ...materialTags,
    ]);
    const created = await createProject(
      {
        ...definition,
        projectType: ProjectType.PRODUCT,
        classifiedAs,
        declarations: { repairable: "yes", recyclable: "yes", certifications: [] },
        metadata: {
          design: design.id,
          price: definition.price,
          availability: definition.availability,
        },
      },
      bob,
      fallbackImage
    );
    await client.resources.citeResource(design.id, created.processId);
    console.log(`    ✓ ${created.id} (cites design ${design.id})`);
    results.products.push({ ...created, designId: design.id });
  }
  console.log("");

  console.log("── Step 7: Create DPPs ──");
  authAs(bob);
  for (const product of results.products) {
    console.log(`  Product: ${product.name}`);
    for (let index = 0; index < 3; index += 1) {
      const number = index + 1;
      try {
        const dpp = await client.dpp.createDpp({
          productId: product.id,
          batchType: index === 0 ? "batch" : "unit",
          batchId: `BATCH-${product.id.slice(0, 8)}-${number}`,
          status: "active",
          productOverview: {
            productName: { type: "Text", value: product.name },
            productDescription: { type: "Text", value: `Digital Product Passport #${number} for ${product.name}` },
          },
          reparability: {
            repairabilityScore: { type: "Number", value: 8 - index, units: "/10" },
            availabilityOfSpareParts: { type: "Text", value: "Available for at least 5 years" },
          },
          environmentalImpact: {
            co2eEmissionsPerUnit: { type: "Number", value: 12.5 + index * 3, units: "kg CO2e" },
            energyConsumptionPerUnit: { type: "Number", value: 45 + index * 10, units: "kWh" },
          },
          recyclability: {
            materialComposition: { type: "Text", value: "Recycled material 70%, virgin material 30%" },
          },
          complianceAndStandards: {
            ceMarking: { type: "Text", value: "Yes" },
            rohsCompliance: { type: "Text", value: "Yes" },
          },
          energyUseAndEfficiency: {
            powerRating: { type: "Number", value: 150 + index * 25, units: "W" },
          },
          economicOperator: {
            companyName: { type: "Text", value: "Interfacer Demo Inc." },
            addressLine1: { type: "Text", value: "123 Innovation Street" },
          },
        });
        const name = `DPP #${number} for ${product.name}`;
        const resource = await client.resources.createDppResource({
          name,
          note: `Digital Product Passport for ${product.name} #${number}`,
          dppUlid: dpp.insertedID,
        });
        await client.resources.citeResource(resource.id, product.processId);
        console.log(`    ✓ ${dpp.insertedID} / ${resource.id}`);
        results.dpps.push({
          dppUlid: dpp.insertedID,
          resourceId: resource.id,
          productId: product.id,
          index,
        });
      } catch (error) {
        console.log(`    ⚠ DPP #${number} skipped: ${error.message}`);
      }
    }
  }
  console.log("");

  console.log("── Step 8: Create feedback ──");
  authAs(clara);
  for (const product of [results.products[0], results.products[2], results.products[4]]) {
    try {
      const review = await client.feedback.createReview(
        product.id,
        4,
        `Great product! ${product.name} is well designed and works perfectly.`
      );
      results.feedback.push({ type: "review", projectId: product.id, ...review });
      console.log(`  ✓ Review on ${product.name}`);
    } catch (error) {
      console.log(`  ⚠ Review on ${product.name}: ${error.message}`);
    }

    try {
      const comment = await client.feedback.createComment(
        product.id,
        `I've been using ${product.name} for weeks. The build quality and documentation are excellent.`
      );
      results.feedback.push({ type: "comment", projectId: product.id, ...comment });
      console.log(`  ✓ Comment on ${product.name}`);
    } catch (error) {
      console.log(`  ⚠ Comment on ${product.name}: ${error.message}`);
    }
  }

  try {
    const review = await client.feedback.createReview(
      results.designs[0].id,
      5,
      "Excellent parametric design: versatile, manufacturable, and well documented."
    );
    results.feedback.push({ type: "review", projectId: results.designs[0].id, ...review });
    console.log(`  ✓ Review on ${results.designs[0].name}`);
  } catch (error) {
    console.log(`  ⚠ Design review: ${error.message}`);
  }

  const outputPath = join(__dirname, "results-sdk.json");
  writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);

  console.log("");
  console.log("═══════════════════════════════════════");
  console.log("  DATA INJECTION COMPLETE");
  console.log("═══════════════════════════════════════");
  for (const key of ["users", "machines", "designs", "services", "products", "dpps", "feedback"]) {
    console.log(`  ${key.padEnd(9)} ${results[key].length}`);
  }
  console.log(`  Output:    ${outputPath}`);

  return results;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch(error => {
    console.error("\n✗ Data injection failed:", error);
    process.exitCode = 1;
  });
}
