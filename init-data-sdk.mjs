#!/usr/bin/env node --experimental-vm-modules

/**
 * Interfacer Init Data — using @interfacer/client SDK.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Polyfill fetch for form-data compatibility (same as original notebook)
import crossFetch from "cross-fetch";
import FormDataLib from "form-data";
globalThis.fetch = crossFetch;
globalThis.Headers = crossFetch.Headers;
globalThis.Request = crossFetch.Request;
globalThis.Response = crossFetch.Response;
globalThis.FormData = FormDataLib;

import { clearInstanceVariablesCache, InterfacerClient, createConfig } from "@interfacer/client";
clearInstanceVariablesCache();

// ── Load env from interfacer-gui ────────────────────────────────────
const guiEnvPath = join(__dirname, "..", "interfacer-gui", ".env.local");
if (!existsSync(guiEnvPath)) { console.error("Missing: interfacer-gui/.env.local"); process.exit(1); }
const envContent = readFileSync(guiEnvPath, "utf8");
let BASE_URL = "";
for (const line of envContent.split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq === -1) continue;
  const k = t.substring(0, eq).trim();
  let v = t.substring(eq + 1).trim();
  v = v.replace(/\$BASE_URL/g, BASE_URL);
  if (k === "BASE_URL") BASE_URL = v;
  if (!process.env[k]) process.env[k] = v;
}

const DPP_URL = process.env.NEXT_PUBLIC_DPP_URL || `${BASE_URL}/interfacer-dpp`;
const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL || "https://feedback.dpp-dev.ddns.dyne.org";
const STL_FILE_PATH = process.env.STL_FILE_PATH || join(__dirname, "..", "Desktop", "incastro_mobile.stl");
const DPP_SIGN_SCRIPT = readFileSync(join(__dirname, "zenflows-crypto", "src", "sign_graphql.zen"), "utf8");
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

console.log("═══ Interfacer Init Data (SDK) ═══");
console.log(`  Zenflows:  ${process.env.NEXT_PUBLIC_ZENFLOWS_URL}`);
console.log(`  DPP:       ${DPP_URL}`);
console.log(`  Feedback:  ${FEEDBACK_URL}`);
console.log("");

const client = new InterfacerClient(createConfig({
  zenflowsUrl: process.env.NEXT_PUBLIC_ZENFLOWS_URL,
  zenflowsFileUrl: process.env.NEXT_PUBLIC_ZENFLOWS_FILE_URL,
  dppUrl: DPP_URL,
  inbox: { send: process.env.NEXT_PUBLIC_INBOX_SEND, read: process.env.NEXT_PUBLIC_INBOX_READ, countUnread: process.env.NEXT_PUBLIC_INBOX_COUNT_UNREAD, setRead: process.env.NEXT_PUBLIC_INBOX_SET_READ },
  walletUrl: process.env.NEXT_PUBLIC_WALLET,
  social: { personBase: process.env.NEXT_PUBLIC_SOCIAL_PERSON, economicResourceBase: process.env.NEXT_PUBLIC_SOCIAL_ECONOMIC_RESOURCE },
  oshUrl: process.env.NEXT_PUBLIC_OSH,
  loshId: process.env.NEXT_PUBLIC_LOSH_ID,
  zenflowsAdmin: process.env.NEXT_PUBLIC_ZENFLOWS_ADMIN,
  specs: { machine: process.env.NEXT_PUBLIC_SPEC_MACHINE, dpp: process.env.NEXT_PUBLIC_SPEC_DPP },
}));

const results = { users: [], designs: [], services: [], products: [], dpps: [], feedback: [] };
const tagging = client.tagging;

// ── Helpers ─────────────────────────────────────────────────────────

async function signZen(didBody, privateKey) {
  const { zencode_exec } = await import("zenroom");
  // DPP verify_graphql.zen expects raw hex, not base64
  const { result } = await zencode_exec(DPP_SIGN_SCRIPT, { data: JSON.stringify({ gql: didBody }), keys: JSON.stringify({ keyring: { eddsa: privateKey } }) });
  return JSON.parse(result).eddsa_signature;
}

async function dppUpload(buffer, filename, contentType, privateKey, publicKey) {
  const hash = createHash("sha256").update(buffer).digest("hex");
  const sig = await signZen(hash, privateKey);
  const form = new FormData();
  form.append("file", buffer, { filename, contentType });
  const headers = { ...form.getHeaders(), "did-pk": publicKey, "did-sign": sig };
  const res = await fetch(`${DPP_URL}/upload`, { method: "POST", headers, body: form });
  const data = await res.json();
  if (!res.ok || data.error) { throw new Error(data.error || res.statusText); }
  return { id: data.id, fileName: filename, contentType, url: `${DPP_URL}/file/${data.id}`, size: buffer.length, checksum: hash, uploadedAt: new Date().toISOString() };
}

async function uploadPicsumImage(seed, privateKey, publicKey) {
  try {
    const imgRes = await fetch(`https://picsum.photos/seed/${encodeURIComponent(seed)}/400/300`);
    if (!imgRes.ok) { console.log(`    ⚠ Image HTTP ${imgRes.status}`); return null; }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const att = await dppUpload(buf, `${seed}.jpg`, "image/jpeg", privateKey, publicKey);
    console.log(`    ✓ Image: ${att.fileName} (${att.size}B)`);
    return `${DPP_URL}/file/${encodeURIComponent(att.id)}`;
  } catch(e) { console.log(`    ⚠ Image error: ${e.message}`); return null; }
}

async function uploadStlModel(filePath, privateKey, publicKey) {
  if (!existsSync(filePath)) { console.log(`    ⚠ STL not found: ${filePath}`); return null; }
  try {
    const buf = readFileSync(filePath);
    const att = await dppUpload(buf, basename(filePath), "application/sla", privateKey, publicKey);
    console.log(`    ✓ STL: ${att.fileName} (${att.size}B)`);
    return { contentType: att.contentType, downloadUrl: att.url, extension: extname(filePath).slice(1), fileName: att.fileName, id: att.id, mimeType: att.contentType, name: att.fileName, size: att.size, storage: "dpp", uploadedAt: att.uploadedAt, url: att.url, checksum: att.checksum };
  } catch(e) { console.log(`    ⚠ STL error: ${e.message}`); return null; }
}

async function lookupLocation(query) {
  if (!query) return null;
  try {
    const params = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", limit: "1" });
    const res = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { "User-Agent": "interfacer-client-init/1.0" } });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return { address: data[0].display_name || query, lat: parseFloat(data[0].lat || 0), lng: parseFloat(data[0].lon || 0) };
  } catch { return null; }
}

async function createSpatialThing(name, query) {
  const loc = await lookupLocation(query);
  if (!loc) return { id: null, isRemote: true, address: null, lat: null, lng: null };
  try {
    const res = await client.resources.createLocation({ name, address: loc.address, lat: loc.lat, lng: loc.lng });
    console.log(`    ✓ Location: ${name} (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`);
    return { id: res.id, isRemote: false, address: loc.address, lat: loc.lat, lng: loc.lng };
  } catch (e) { console.log(`    ⚠ Location failed: ${e.message}`); return { id: null, isRemote: true, address: null, lat: null, lng: null }; }
}

function authAs(user) {
  client.store.setItem("eddsaPrivateKey", user.privateKey);
  client.store.setItem("eddsaPublicKey", user.publicKey);
  client.store.setItem("authId", user.id);
  client.store.setItem("authUsername", user.username);
  client.store.setItem("authEmail", user.email);
  client.graphql.setSigningEnabled(true);
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  // Step 1: Fetch specs
  console.log("── Step 1: Fetching specs ──");
  const res = await client.graphql.request(`query { instanceVariables { specs { specProjectDesign { id name } specProjectProduct { id name } specProjectService { id name } } units { unitOne { id } } } }`);
  const specs = res.data?.instanceVariables;
  const unitOne = specs?.units?.unitOne?.id;
  console.log(`  Design:  ${specs?.specs?.specProjectDesign?.id}`);
  console.log(`  Product: ${specs?.specs?.specProjectProduct?.id}`);
  console.log(`  Service: ${specs?.specs?.specProjectService?.id}`);
  console.log(`  UnitOne: ${unitOne}`);
  console.log("");

  // Step 2: Create users
  console.log("── Step 2: Creating 3 users ──");
  const userDefs = [
    { name: "Alice Designer", username: "alice_designer", email: "alice.designer@example.com", challenges: { whereParentsMet:"Paris", nameFirstPet:"Rex", nameFirstTeacher:"Smith", whereHomeTown:"Berlin", nameMotherMaid:"Maria" } },
    { name: "Bob Maker", username: "bob_maker", email: "bob.maker@example.com", challenges: { whereParentsMet:"London", nameFirstPet:"Max", nameFirstTeacher:"Johnson", whereHomeTown:"Tokyo", nameMotherMaid:"Anna" } },
    { name: "Clara Reviewer", username: "clara_reviewer", email: "clara.reviewer@example.com", challenges: { whereParentsMet:"Rome", nameFirstPet:"Luna", nameFirstTeacher:"Brown", whereHomeTown:"Madrid", nameMotherMaid:"Sophia" } },
  ];

  for (const def of userDefs) {
    console.log(`  Creating: ${def.name} (${def.email})`);
    client.auth.logout(); clearInstanceVariablesCache();
    let hmac;
    try { hmac = await client.auth.requestHmac(def.email, true); console.log("    ✓ HMAC"); }
    catch (e) { hmac = await client.auth.requestHmac(def.email, false); console.log("    ✓ HMAC (existing)"); }
    await client.auth.deriveKeys(def.challenges, def.email, hmac);
    const privateKey = client.store.getItem("eddsaPrivateKey");
    const publicKey = client.store.getItem("eddsaPublicKey");
    console.log("    ✓ Keys derived");
    try { await client.auth.registerUser({ name: def.name, user: def.username, email: def.email }); console.log("    ✓ Person created"); }
    catch (e) { console.log("    ⚠ Person exists"); }
    const profile = await client.auth.login({ email: def.email });
    console.log(`    ✓ Verified: ${profile.name} (${profile.id})`);
    try { await client.auth.claimDid(profile.id); console.log("    ✓ DID"); } catch { console.log("    ⚠ DID skipped"); }
    results.users.push({ id: profile.id, name: def.name, username: def.username, email: def.email, privateKey, publicKey });
  }
  console.log("");

  const [alice, bob, clara] = results.users;

  // Step 3: Create 5 designs (Alice)
  console.log("── Step 3: Creating 5 designs ──");
  authAs(alice);
  const fallbackImage = await uploadPicsumImage("placeholder", alice.privateKey, alice.publicKey);

  const stlModel = await uploadStlModel(STL_FILE_PATH, alice.privateKey, alice.publicKey);
  if (stlModel) console.log(`  ✓ STL model uploaded`);

  const designDefs = [
    { name: "Modular Gear System", desc: "A parametric modular gear system for 3D printing. Features customizable tooth profiles, sizes, and configurations. Designed for maximum compatibility and easy assembly.", link: "https://github.com/example/modular-gear", license: "CC-BY-SA-4.0", tags: ["3d-printing","mechanical","parametric"], loc: ["FabLab Torino","Turin, Italy"], img: "modular-gears-3d-printing" },
    { name: "Ergonomic Handle Grip", desc: "An ergonomic handle grip design optimized for comfort and durability. Features textured surfaces for better grip and shock absorption properties.", link: "https://github.com/example/ergo-handle", license: "GPL-3.0", tags: ["ergonomics","accessibility","3d-printing"], loc: ["DesignLab Vienna","Vienna, Austria"], img: "ergonomic-handle-grip-design" },
    { name: "Solar Panel Mount Bracket", desc: "Universal solar panel mounting bracket designed for various panel sizes. Made for easy installation with standard tools. Weather-resistant and durable.", link: "https://github.com/example/solar-bracket", license: "CC0-1.0", tags: ["solar","renewable-energy","mounting"], loc: ["GreenFab Lisbon","Lisbon, Portugal"], img: "solar-panel-mounting-bracket" },
    { name: "Bicycle Cargo Rack", desc: "Lightweight yet sturdy bicycle cargo rack compatible with most frame types. Designed to carry up to 25kg with optimal weight distribution.", link: "https://github.com/example/bike-rack", license: "CC-BY-4.0", tags: ["bicycle","transportation","cargo"], img: "bicycle-cargo-rack-metal" },
    { name: "Desktop Cable Organizer", desc: "Modular cable management system for desks and workstations. Keeps cables organized, prevents tangling, and improves workspace aesthetics.", link: "https://github.com/example/cable-organizer", license: "MIT", tags: ["organization","workspace","modular"], img: "cable-management-desk-organizer" },
  ];

  for (const def of designDefs) {
    console.log(`  Design: ${def.name}`);
    const img = await uploadPicsumImage(def.img, alice.privateKey, alice.publicKey) || fallbackImage;
    const { id: locId, isRemote } = def.loc ? await createSpatialThing(def.loc[0], def.loc[1]) : { id: null, isRemote: true };
    const tags = tagging.normalizeUserTags(def.tags);
    const licenseTag = tagging.prefixedTag("license", def.license);
    if (licenseTag) tags.push(licenseTag);
    const models = stlModel ? [stlModel] : [];
    const metadata = JSON.stringify({ contributors:[], relations:[], remote:isRemote, models, image:img });

    const proj = await client.resources.createProject({ projectType:"DESIGN", name:def.name, note:def.desc, tags, repo:def.link, license:def.license, metadata: JSON.parse(metadata), location: locId ? { name: def.loc[0], address: undefined, lat: undefined, lng: undefined } : undefined });
    console.log(`    ✓ ${proj.id}`);
    results.designs.push({ id: proj.id, name: def.name, models });
  }
  console.log("");

  // Step 4: Create 3 services (Bob)
  console.log("── Step 4: Creating 3 services ──");
  authAs(bob);
  const serviceDefs = [
    { name:"3D Printing Consultation", desc:"Expert consultation service for 3D printing. Material selection, print optimization, post-processing guidance. Remote or on-site.", link:"https://example.com/3d-consulting", license:"CC-BY-SA-4.0", tags:["consulting","3d-printing","education"], serviceType:["Fabrication","Learning & Education"], availability:["Booking Required","Weekends Available"], loc:["Makerspace Amsterdam","Amsterdam, Netherlands"], img:"3d-printer-filament-colors" },
    { name:"Custom PCB Design Service", desc:"Professional PCB design and prototyping. Schematic capture to layout to manufacturing files. Multi-layer and high-speed.", link:"https://example.com/pcb-design", license:"GPL-3.0", tags:["electronics","pcb","prototyping"], serviceType:["Fabrication","Space Access"], availability:["Available Now","Weekdays Only"], loc:["TechHub Berlin","Berlin, Germany"], img:"printed-circuit-board-electronics" },
    { name:"Sustainable Packaging Consulting", desc:"Eco-friendly packaging consulting. Lifecycle analysis, material selection, design optimization for minimal environmental impact.", link:"https://example.com/eco-packaging", license:"CC0-1.0", tags:["sustainability","packaging","consulting"], serviceType:["Learning & Education"], availability:["Available Now","Weekends Available"], loc:["GreenLab Barcelona","Barcelona, Spain"], img:"sustainable-eco-packaging-nature" },
  ];
  for (const def of serviceDefs) {
    console.log(`  Service: ${def.name}`);
    const img = await uploadPicsumImage(def.img, bob.privateKey, bob.publicKey) || fallbackImage;
    const { id: locId, isRemote } = await createSpatialThing(def.loc[0], def.loc[1]);
    const tags = [
      ...tagging.normalizeUserTags(def.tags),
      ...tagging.derivedServiceFilterTags({ serviceType: def.serviceType, availability: def.availability }),
    ];
    const metadata = JSON.stringify({ contributors:[], relations:[], remote:isRemote, serviceFilters:{ serviceType:def.serviceType, availability:def.availability }, image:img });
    const proj = await client.resources.createProject({ projectType:"SERVICE", name:def.name, note:def.desc, tags, repo:def.link, license:def.license, metadata:JSON.parse(metadata), location: locId ? { name: def.loc[0], address: undefined, lat: undefined, lng: undefined } : undefined });
    console.log(`    ✓ ${proj.id}`);
    results.services.push({ id: proj.id, name: def.name });
  }
  console.log("");

  // Step 5: Create 5 products (Bob, linked to designs)
  console.log("── Step 5: Creating 5 products ──");
  authAs(bob);
  const productDefs = [
    { name:"Premium Gear Set", desc:"High-precision modular gear set from recycled PLA. 5 gear sizes + compatible axles. Robotics and mechanical projects.", link:"https://github.com/example/premium-gears", license:"CC-BY-SA-4.0", tags:["gears","robotics","mechanical"], di:0, img:"precision-gears-mechanical-metal", loc:["FabLab Milano","Milan, Italy"], pf:{ categories:["Electronics","Tools"], powerCompatibility:["120V AC","Battery Powered"], replicability:["High"], recyclabilityPct:80, repairability:true, powerRequirementW:150, energyKwh:50, co2Kg:5 } },
    { name:"ErgoGrip Pro Handle", desc:"Professional-grade ergonomic handle with dual-material. Soft-touch TPU overmold on rigid PLA core. Multiple sizes.", link:"https://github.com/example/ergogrip-pro", license:"CC-BY-SA-4.0", tags:["ergonomics","professional","tools"], di:1, img:"ergonomic-tool-handle-professional", loc:["Hackerspace Paris","Paris, France"], pf:{ categories:["Tools","Wearables"], powerCompatibility:["Battery Powered","USB-C"], replicability:["Medium"], recyclabilityPct:65, repairability:true, powerRequirementW:10, energyKwh:20, co2Kg:1.5 } },
    { name:"SunMount Universal Bracket", desc:"Heavy-duty solar panel bracket with adjustable angle (15°-45°). Recycled aluminum, stainless hardware. 100+ mph wind rating.", link:"https://github.com/example/sunmount", license:"CC0-1.0", tags:["solar","renewable","outdoor"], di:2, img:"solar-panel-renewable-energy-sun", loc:["SolarLab Valencia","Valencia, Spain"], pf:{ categories:["Energy","Sustainability"], powerCompatibility:["220-240V AC","24V DC"], replicability:["Low","Medium"], recyclabilityPct:95, repairability:true, powerRequirementW:500, energyKwh:200, co2Kg:10 } },
    { name:"Urban Cargo Rack XL", desc:"Extra-large bicycle cargo rack with integrated pannier rails. Powder-coated steel. Disc and rim brake compatible.", link:"https://github.com/example/urban-rack-xl", license:"CC-BY-4.0", tags:["bicycle","urban","transport"], di:3, img:"bike-cargo-rack-urban-commute", loc:["BikeKitchen Copenhagen","Copenhagen, Denmark"], pf:{ categories:["Furniture","Sustainability"], powerCompatibility:["USB-C","12V DC"], replicability:["Medium"], recyclabilityPct:90, repairability:true, powerRequirementW:0, energyKwh:300, co2Kg:15 } },
    { name:"DeskMate Cable System", desc:"Complete cable management kit with under-desk tray, cable clips, and routing channels. Adhesive mounts + ties. Fits desks up to 2m.", link:"https://github.com/example/deskmate", license:"MIT", tags:["desk","organization","office"], di:4, img:"cable-management-desk-workspace", loc:["OpenLab London","London, United Kingdom"], pf:{ categories:["Education","Medical","Home renovation"], powerCompatibility:["12V DC","Battery Powered"], replicability:["High"], recyclabilityPct:70, repairability:true, powerRequirementW:75, energyKwh:100, co2Kg:2.5 } },
  ];
  for (const def of productDefs) {
    console.log(`  Product: ${def.name}`);
    const img = await uploadPicsumImage(def.img, bob.privateKey, bob.publicKey) || fallbackImage;
    const { id: locId, isRemote } = await createSpatialThing(def.loc[0], def.loc[1]);
    const designId = results.designs[def.di].id;
    const designModels = results.designs[def.di].models;
    const tags = [
      ...tagging.normalizeUserTags(def.tags),
      ...tagging.derivedProductFilterTags(def.pf),
      tagging.prefixedTag("license", def.license),
    ].filter(Boolean);
    const metadata = JSON.stringify({ contributors:[], relations:[], remote:isRemote, design:designId, models:designModels, productFilters:def.pf, image:img });
    const proj = await client.resources.createProject({ projectType:"PRODUCT", name:def.name, note:def.desc, tags, repo:def.link, license:def.license, metadata:JSON.parse(metadata), location: locId ? { name: def.loc[0], address: undefined, lat: undefined, lng: undefined } : undefined });
    console.log(`    ✓ ${proj.id}`);
    // Cite design
    try { const proc = await client.resources.createProcess(`link ${proj.id} to ${designId}`); await client.resources.citeResource(designId, proc); console.log("    ✓ Design cited"); } catch(e) { console.log(`    ⚠ cite: ${e.message}`); }
    results.products.push({ id: proj.id, name: def.name, designId });
  }
  console.log("");

  // Step 6: Create DPPs (3 per product = 15, Bob)
  console.log("── Step 6: Creating DPPs (3 per product) ──");
  authAs(bob);
  for (const product of results.products) {
    console.log(`  Product: ${product.name}`);
    for (let di = 0; di < 3; di++) {
      const dppName = `DPP #${di+1} for ${product.name}`;
      try {
        const dpp = await client.dpp.createDpp({
          productId: product.id,
          batchType: di === 0 ? "batch" : "unit",
          batchId: `BATCH-${product.id.substring(0,8)}-${di+1}`,
          productOverview: { productName:{type:"Text",value:product.name}, productDescription:{type:"Text",value:`Digital Product Passport #${di+1} for ${product.name}`} },
          environmentalImpact: { co2eEmissionsPerUnit:{type:"Number",value:12.5+di*3,units:"kg CO2e"}, energyConsumptionPerUnit:{type:"Number",value:45+di*10,units:"kWh"} },
          recyclability: { materialComposition:{type:"Text",value:"Recycled PLA 70%, Virgin PLA 30%"} },
          complianceAndStandards: { ceMarking:{type:"Text",value:"Yes"}, rohsCompliance:{type:"Text",value:"Yes"} },
          energyUseAndEfficiency: { powerRating:{type:"Number",value:150+di*25,units:"W"} },
          economicOperator: { companyName:{type:"Text",value:"Interfacer Demo Inc."}, addressLine1:{type:"Text",value:"123 Innovation Street"} },
        });
        console.log(`    [${di+1}/3] DPP: ${dpp.insertedID}`);
        const dppRes = await client.resources.createDppResource({ name:dppName, note:`DPP for ${product.name} #${di+1}`, dppUlid: dpp.insertedID });
        console.log(`      ✓ DPP resource: ${dppRes.id}`);
        const proc = await client.resources.createProcess(`cite dpp ${dppName}`);
        await client.resources.citeResource(dppRes.id, proc);
        console.log(`      ✓ Cited from product`);
        results.dpps.push({ dppUlid: dpp.insertedID, resourceId: dppRes.id, productId: product.id, index: di });
      } catch(e) { console.log(`    ⚠ DPP failed: ${e.message}`); }
    }
  }
  console.log("");

  // Step 7: Feedback (Clara)
  console.log("── Step 7: Injecting feedback ──");
  authAs(clara);
  async function feedbackRequest(method, urlPath, body) {
    const fullUrl = `${FEEDBACK_URL}${urlPath}`;
    const jsonBody = body ? JSON.stringify(body) : "";
    const sig = await signZen(jsonBody, clara.privateKey);
    const headers = { "x-user-id": clara.id, "did-pk": clara.publicKey, "did-sign": sig };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(fullUrl, { method, headers, body: body ? jsonBody : undefined });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(()=>"")}`);
    return res.json().catch(()=>({}));
  }

  const reviewTargets = [results.products[0], results.products[2], results.products[4]];
  for (const p of reviewTargets) {
    console.log(`  Product: ${p.name}`);
    try {
      const r = await feedbackRequest("POST", `/api/v1/projects/${p.id}/reviews`, { rating:4, content:`Great product! The ${p.name} is well-designed and works perfectly. Highly recommended for anyone interested in open hardware.` });
      console.log(`    ✓ Review: ${JSON.stringify(r)}`);
      results.feedback.push({ type:"review", productId:p.id, ...r });
    } catch(e) { console.log(`    ⚠ Review: ${e.message}`); }
    try {
      const c = await feedbackRequest("POST", `/api/v1/projects/${p.id}/comments`, { content:`I've been using the ${p.name} for weeks. Excellent build quality and documentation.`, parent_id:null, attachments:null });
      console.log(`    ✓ Comment: ${JSON.stringify(c)}`);
      results.feedback.push({ type:"comment", productId:p.id, ...c });
    } catch(e) { console.log(`    ⚠ Comment: ${e.message}`); }
  }
  // Also review first design
  if (results.designs[0]) {
    try {
      const r = await feedbackRequest("POST", `/api/v1/projects/${results.designs[0].id}/reviews`, { rating:5, content:"Excellent parametric design! The modular gear system is incredibly versatile and well-documented." });
      console.log(`    ✓ Design review: ${JSON.stringify(r)}`);
      results.feedback.push({ type:"review", productId:results.designs[0].id, ...r });
    } catch(e) { console.log(`    ⚠ Design review: ${e.message}`); }
  }
  console.log("");

  // Summary
  console.log("═══════════════════════════════════════");
  console.log("  DATA INJECTION COMPLETE");
  console.log("═══════════════════════════════════════");
  console.log(`  Users:    ${results.users.length}`);
  console.log(`  Designs:  ${results.designs.length}`);
  console.log(`  Services: ${results.services.length}`);
  console.log(`  Products: ${results.products.length}`);
  console.log(`  DPPs:     ${results.dpps.length}`);
  console.log(`  Feedback: ${results.feedback.length}`);
  console.log("");
  writeFileSync(join(__dirname, "results-sdk.json"), JSON.stringify(results, null, 2));
  return results;
}

main().then(() => { console.log("✓ Done!"); process.exit(0); }).catch(e => { console.error("✗ Failed:", e); process.exit(1); });
