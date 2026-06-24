#!/usr/bin/env node --experimental-vm-modules

/**
 * =============================================================================
 * INTERFACER INIT DATA - Test Data Injection Script
 * =============================================================================
 *
 * Injects test data into the Interfacer platform by interacting directly with:
 *   - Zenflows GraphQL API (user/project/resource creation)
 *   - interfacer-dpp REST API (DPP creation, file uploads)
 *   - interfacer-feedback REST API (reviews, comments)
 *
 * Data injected:
 *   - 3 users
 *   - 5 designs (with 3D model files)
 *   - 3 services
 *   - 5 products (each linked to a design, with 3 DPPs)
 *   - Feedback: reviews and comments on projects
 *
 * Prerequisites:
 *   - Zenflows, interfacer-dpp, interfacer-feedback services must be running
 *   - A valid .env file with API URLs (or set env vars directly)
 *   - Node.js 18+ with --experimental-vm-modules flag
 *
 * Usage:  node --experimental-vm-modules main.mjs
 *
 * =============================================================================
 */

import crossFetch from "cross-fetch";
import FormData from "form-data";
const { Headers, Request, Response } = crossFetch;
globalThis.fetch = crossFetch;
globalThis.Headers = Headers;
globalThis.Request = Request;
globalThis.Response = Response;
globalThis.FormData = FormData;
import { createRequire } from "module";
const require_ = createRequire(import.meta.url);
const { ApolloClient, InMemoryCache, HttpLink } = require_("@apollo/client/core");
import { zencode_exec } from "zenroom";
import base64url from "base64url";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

// ────────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present
const envPath = path.join(__dirname, "..", "interfacer-gui", ".env.local");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    let key = trimmed.substring(0, eqIdx).trim();
    let value = trimmed.substring(eqIdx + 1).trim();
    if (!process.env[key]) {
      // Resolve $BASE_URL and other variable references
      value = value.replace(/\$BASE_URL/g, process.env.BASE_URL || "");
      // Also set BASE_URL if we encounter it
      if (key === "BASE_URL") process.env.BASE_URL = value;
      process.env[key] = value;
    }
  }
}

const BASE_URL = process.env.BASE_URL || "https://proxy.dpp-dev.ddns.dyne.org";
const ZENFLOWS_URL = process.env.NEXT_PUBLIC_ZENFLOWS_URL || `${BASE_URL}/zenflows/api`;
const DPP_URL = process.env.NEXT_PUBLIC_DPP_URL || `${BASE_URL}/interfacer-dpp`;
const FEEDBACK_URL = process.env.NEXT_PUBLIC_FEEDBACK_URL || "https://feedback.dpp-dev.ddns.dyne.org";
const ZENFLOWS_ADMIN = process.env.NEXT_PUBLIC_ZENFLOWS_ADMIN || "4503e566f33808a6057a05b2cb1b10bef14cb3fe73f5e3ca101fb8c16a5250ec59283d80e23797bd4e5d2874a5056773300e9c2f12b57992b4964b286f9b6ba4";
const LOSH_ID = process.env.NEXT_PUBLIC_LOSH_ID || "06EG20F8TN5159QS8VXVAEJ1WR";

// Spec IDs (from .env.local or will be fetched)
const SPEC_MACHINE = process.env.NEXT_PUBLIC_SPEC_MACHINE || "";
const SPEC_DPP = process.env.NEXT_PUBLIC_SPEC_DPP || "";

// Nominatim endpoints (matching interfacer-gui config)
const NOMINATIM_SEARCH = process.env.NEXT_PUBLIC_LOCATION_AUTOCOMPLETE || "https://nominatim.openstreetmap.org/search";
const NOMINATIM_LOOKUP = process.env.NEXT_PUBLIC_LOCATION_LOOKUP || "https://nominatim.openstreetmap.org/lookup";

// Paths for test files
const STL_FILE_PATH = "/Users/alcibiade/Desktop/incastro_mobile.stl";

console.log("═══ Interfacer Init Data ═══");
console.log(`  Zenflows:  ${ZENFLOWS_URL}`);
console.log(`  DPP API:   ${DPP_URL}`);
console.log(`  Feedback:  ${FEEDBACK_URL}`);
console.log(`  Admin key: ${ZENFLOWS_ADMIN ? "✓" : "✗"}`);
console.log("");

// ────────────────────────────────────────────────────────────────────────────────
// HELPER: Sign GraphQL request (zenflows)
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Sign a GraphQL query/mutation body using EdDSA via zenroom.
 * Returns headers: { "zenflows-sign", "zenflows-user", "zenflows-hash" }
 */
async function signGraphQL(body, eddsaPrivateKey, username) {
  const signScript = `
Scenario eddsa: sign a graph query
Given I have a 'base64' named 'gql'
Given I have the 'keyring'

When I remove spaces in 'gql'
and I compact ascii strings in 'gql'

When I create the eddsa signature of 'gql'
And I create the hash of 'gql'

Then print 'eddsa signature' as 'base64'
Then print 'hash' as 'hex'
`;
  const gqlB64 = Buffer.from(body, "utf8").toString("base64");
  const zenData = JSON.stringify({ gql: gqlB64 });
  const zenKeys = JSON.stringify({ keyring: { eddsa: eddsaPrivateKey } });
  const { result } = await zencode_exec(signScript, { data: zenData, keys: zenKeys });
  const parsed = JSON.parse(result);
  return {
    "zenflows-sign": parsed.eddsa_signature,
    "zenflows-user": username,
    "zenflows-hash": parsed.hash,
  };
}

/**
 * Make an authenticated GraphQL request to Zenflows.
 */
async function zenflowsRequest(query, variables, auth = null) {
  const body = JSON.stringify({ query, variables: variables || {} });
  const headers = { "Content-Type": "application/json" };

  if (auth) {
    const sigHeaders = await signGraphQL(body, auth.privateKey, auth.username);
    Object.assign(headers, sigHeaders);
  } else {
    // Admin header only for unauthenticated admin operations (e.g., createPerson, keypairoomServer)
    if (ZENFLOWS_ADMIN) {
      headers["zenflows-admin"] = ZENFLOWS_ADMIN;
    }
  }

  const res = await fetch(ZENFLOWS_URL, { method: "POST", headers, body });
  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`  Raw response (${res.status}):`, text.substring(0, 500));
    throw new Error(`GraphQL endpoint returned non-JSON response (HTTP ${res.status})`);
  }

  if (json.errors) {
    console.error("  GraphQL errors:", JSON.stringify(json.errors, null, 2));
    throw new Error(`GraphQL error: ${json.errors[0]?.message || "unknown"}`);
  }

  return json.data;
}

/**
 * Shortcut for authenticated mutations
 */
function zenflowsMutate(auth) {
  return (query, variables) => zenflowsRequest(query, variables, auth);
}

/**
 * Shortcut for public queries (no auth)
 */
function zenflowsQuery(query, variables) {
  return zenflowsRequest(query, variables, null);
}

// ────────────────────────────────────────────────────────────────────────────────
// HELPER: Sign REST request (DPP / Feedback)
// ────────────────────────────────────────────────────────────────────────────────

async function signRequestBody(body, privateKey, publicKey) {
  const signScript = `
Scenario eddsa: sign a graph query
Given I have a 'base64' named 'gql'
Given I have the 'keyring'

When I remove spaces in 'gql'
and I compact ascii strings in 'gql'

When I create the eddsa signature of 'gql'
Then print 'eddsa signature' as 'base64'
`;
  const payload = body != null ? body : "";
  const gqlB64 = Buffer.from(payload, "utf8").toString("base64");
  const zenData = JSON.stringify({ gql: gqlB64 });
  const zenKeys = JSON.stringify({ keyring: { eddsa: privateKey } });
  const { result } = await zencode_exec(signScript, { data: zenData, keys: zenKeys });
  const parsed = JSON.parse(result);
  return {
    "did-sign": parsed.eddsa_signature,
    "did-pk": publicKey,
  };
}

/**
 * Make an authenticated REST request (DPP or Feedback API).
 */
async function dppRequest(method, urlPath, body, privateKey, publicKey, extraHeaders = {}) {
  const fullUrl = `${DPP_URL}${urlPath}`;
  const headers = { ...extraHeaders };

  if (privateKey && publicKey) {
    const jsonBody = body != null ? JSON.stringify(body) : undefined;
    const sigHeaders = await signRequestBody(jsonBody || "", privateKey, publicKey);
    Object.assign(headers, sigHeaders);
    if (jsonBody) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(fullUrl, { method, headers, body: jsonBody });
  }
  // Unauthenticated request
  if (body != null) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(fullUrl, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
}

// ────────────────────────────────────────────────────────────────────────────────
// HELPER: Sign file upload (DPP)
// ────────────────────────────────────────────────────────────────────────────────

async function dppUploadFile(filePath, privateKey, publicKey) {
  const fileBuffer = fs.readFileSync(filePath);
  const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  const signScript = `
Scenario eddsa: sign a graph query
Given I have a 'base64' named 'gql'
Given I have the 'keyring'

When I remove spaces in 'gql'
and I compact ascii strings in 'gql'

When I create the eddsa signature of 'gql'
Then print 'eddsa signature' as 'base64'
`;
  const zenData = JSON.stringify({ gql: hash });
  const zenKeys = JSON.stringify({ keyring: { eddsa: privateKey } });
  const { result } = await zencode_exec(signScript, { data: zenData, keys: zenKeys });
  const signature = JSON.parse(result).eddsa_signature;

  const form = new FormData();
  form.append("file", fileBuffer, { filename: path.basename(filePath) });

  const res = await fetch(`${DPP_URL}/upload`, {
    method: "POST",
    headers: {
      "did-pk": publicKey,
      "did-sign": signature,
    },
    body: form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`DPP upload failed: ${err.error || res.statusText}`);
  }
  return res.json();
}

// ────────────────────────────────────────────────────────────────────────────────
// HELPER: Upload file to zenflows
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Download + upload a picsum image to DPP. Returns the metadata image URL.
 */
async function createPicsumImage(seed, privateKey, publicKey, signScript) {
  const url = `https://picsum.photos/seed/${encodeURIComponent(seed)}/400/300`;
  try {
    const imgRes = await fetch(url);
    if (!imgRes.ok) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());

    // Sign the sha256 hex
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const zenData = JSON.stringify({ gql: sha256 });
    const zenKeys = JSON.stringify({ keyring: { eddsa: privateKey } });
    const { result } = await zencode_exec(signScript, { data: zenData, keys: zenKeys });
    const signature = JSON.parse(result).eddsa_signature;

    // Upload to DPP
    const form = new FormData();
    form.append("file", buf, { filename: `${seed}.jpg`, contentType: "image/jpeg" });
    const dppRes = await fetch(`${DPP_URL}/upload`, {
      method: "POST",
      headers: { "did-pk": publicKey, "did-sign": signature },
      body: form,
    });
    if (!dppRes.ok) {
      console.log(`    ⚠  DPP image upload failed: ${dppRes.status}`);
      return null;
    }
    const att = await dppRes.json();
    // Use proxy URL (the raw DPP URL may not resolve from outside the cluster)
    return `${DPP_URL}/file/${encodeURIComponent(att.id)}`;
  } catch (e) {
    console.log(`    ⚠  Image download/upload failed: ${e.message}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// ZENROOM KEYPAIROOM: Client-side key generation
// ────────────────────────────────────────────────────────────────────────────────

const keypairoomClientScript = fs.readFileSync(
  path.join(__dirname, "zenflows-crypto", "src", "keypairoomClient-8-9-10-11-12.zen"),
  "utf8"
);

/**
 * Generate cryptographic keys from challenges + HMAC server-side shard.
 * Returns: { eddsa_private, eddsa_public, ethereum_address, reflow_public,
 *            bitcoin_public, ecdh_public, seed }
 */
async function generateKeys(email, challenges, hmac) {
  const zenData = JSON.stringify({
    userChallenges: {
      whereParentsMet: challenges.q1,
      nameFirstPet: challenges.q2,
      nameFirstTeacher: challenges.q3,
      whereHomeTown: challenges.q4,
      nameMotherMaid: challenges.q5,
    },
    username: email,
    "seedServerSideShard.HMAC": hmac,
  });

  const { result } = await zencode_exec(keypairoomClientScript, { data: zenData });
  const parsed = JSON.parse(result);

  return {
    eddsaPrivateKey: parsed.keyring.eddsa,
    eddsaPublicKey: parsed.eddsa_public_key,
    ethereumAddress: parsed.ethereum_address,
    reflowPublicKey: parsed.reflow_public_key,
    bitcoinPublicKey: parsed.bitcoin_public_key,
    ecdhPublicKey: parsed.ecdh_public_key,
    seed: parsed.seed,
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// LOCATION: Nominatim lookup + zenflows SpatialThing creation
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Look up a location by search query via Nominatim.
 * Returns { address, lat, lng } or null if not found.
 */
async function lookupLocation(query) {
  if (!query) return null;
  try {
    const params = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", limit: "1" });
    const res = await fetch(`${NOMINATIM_SEARCH}?${params}`, {
      headers: { "User-Agent": "interfacer-init-data/1.0" },
    });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const item = data[0];
    return {
      address: item.display_name || query,
      lat: parseFloat(item.lat || 0),
      lng: parseFloat(item.lon || 0),
    };
  } catch {
    return null;
  }
}

/**
 * Create a SpatialThing in zenflows and return the ID.
 */
async function createSpatialThing(mutateFn, name, address, lat, lng) {
  const { createSpatialThing: cst } = await mutateFn(CREATE_LOCATION, {
    name,
    addr: address,
    lat,
    lng,
  });
  return cst?.spatialThing?.id;
}

// ────────────────────────────────────────────────────────────────────────────────
// ZENFLOWS MUTATIONS (continued)
// ────────────────────────────────────────────────────────────────────────────────

const REGISTER_USER = `
  mutation RegisterUser($firstRegistration: Boolean!, $userData: JSONObject!) {
    keypairoomServer(firstRegistration: $firstRegistration, userData: $userData)
  }
`;

const SIGN_UP = `
  mutation SignUp(
    $name: String!
    $user: String!
    $email: String!
    $eddsaPublicKey: String!
    $reflowPublicKey: String!
    $ethereumAddress: String!
    $ecdhPublicKey: String!
    $bitcoinPublicKey: String!
  ) {
    createPerson(
      person: {
        name: $name
        user: $user
        email: $email
        eddsaPublicKey: $eddsaPublicKey
        reflowPublicKey: $reflowPublicKey
        ethereumAddress: $ethereumAddress
        ecdhPublicKey: $ecdhPublicKey
        bitcoinPublicKey: $bitcoinPublicKey
      }
    ) {
      agent {
        id
        name
        user
        email
        eddsaPublicKey
      }
    }
  }
`;

const FETCH_SELF = `
  query FetchSelf($email: String!, $pubkey: String!) {
    personCheck(email: $email, eddsaPublicKey: $pubkey) {
      name
      user
      email
      id
      isVerified
      primaryLocation {
        id
        name
        mappableAddress
        lat
        long
      }
    }
  }
`;

const CLAIM_DID = `
  mutation claimDID($id: ID!) {
    claimPerson(id: $id)
  }
`;

const QUERY_PROJECT_TYPES = `
  query GetProjectTypes {
    instanceVariables {
      specs {
        specProjectDesign { id name }
        specProjectProduct { id name }
        specProjectService { id name }
        specDpp { id name }
        specMachine { id name }
        specMaterial { id name }
      }
      units {
        unitOne { id }
      }
    }
  }
`;

const CREATE_PROCESS = `
  mutation CreateProcess($name: String!) {
    createProcess(process: { name: $name }) {
      process { id }
    }
  }
`;

const CREATE_LOCATION = `
  mutation CreateLocation($name: String!, $addr: String!, $lat: Decimal!, $lng: Decimal!) {
    createSpatialThing(spatialThing: { name: $name, mappableAddress: $addr, lat: $lat, long: $lng }) {
      spatialThing { id lat long }
    }
  }
`;

const CREATE_PROJECT = `
  mutation CreateProject(
    $name: String!
    $note: String!
    $metadata: JSONObject
    $agent: ID!
    $creationTime: DateTime!
    $location: ID
    $tags: [URI!]
    $resourceSpec: ID!
    $oneUnit: ID!
    $images: [IFile!]
    $repo: String
    $process: ID!
    $license: String!
  ) {
    createEconomicEvent(
      event: {
        action: "produce"
        provider: $agent
        receiver: $agent
        outputOf: $process
        hasPointInTime: $creationTime
        resourceClassifiedAs: $tags
        resourceConformsTo: $resourceSpec
        resourceQuantity: { hasNumericalValue: 1, hasUnit: $oneUnit }
        toLocation: $location
        resourceMetadata: $metadata
      }
      newInventoriedResource: { name: $name, note: $note, images: $images, repo: $repo, license: $license }
    ) {
      economicEvent {
        id
        resourceInventoriedAs {
          id
          name
        }
      }
    }
  }
`;

const CITE_PROJECT = `
  mutation citeProject(
    $agent: ID!
    $creationTime: DateTime!
    $resource: ID!
    $process: ID!
    $unitOne: ID!
  ) {
    createEconomicEvent(
      event: {
        action: "cite"
        inputOf: $process
        provider: $agent
        receiver: $agent
        hasPointInTime: $creationTime
        resourceInventoriedAs: $resource
        resourceQuantity: { hasNumericalValue: 1, hasUnit: $unitOne }
      }
    ) {
      economicEvent { id }
    }
  }
`;

const CONTRIBUTE_TO_PROJECT = `
  mutation contributeToProject(
    $agent: ID!
    $creationTime: DateTime!
    $process: ID!
    $unitOne: ID!
    $conformsTo: ID!
  ) {
    createEconomicEvent(
      event: {
        action: "work"
        inputOf: $process
        provider: $agent
        receiver: $agent
        resourceConformsTo: $conformsTo
        hasPointInTime: $creationTime
        effortQuantity: { hasNumericalValue: 1, hasUnit: $unitOne }
      }
    ) {
      economicEvent { id }
    }
  }
`;

const CONSUME_RESOURCE = `
  mutation consumeResource(
    $agent: ID!
    $creationTime: DateTime!
    $resource: ID!
    $process: ID!
    $unitOne: ID!
  ) {
    createEconomicEvent(
      event: {
        action: "consume"
        inputOf: $process
        provider: $agent
        receiver: $agent
        hasPointInTime: $creationTime
        resourceInventoriedAs: $resource
        resourceQuantity: { hasNumericalValue: 1, hasUnit: $unitOne }
      }
    ) {
      economicEvent { id }
    }
  }
`;

const CREATE_DPP_RESOURCE = `
  mutation createDppResource(
    $agent: ID!
    $creationTime: DateTime!
    $process: ID!
    $resourceSpec: ID!
    $unitOne: ID!
    $dppUlid: String!
    $name: String!
    $note: String
  ) {
    createEconomicEvent(
      event: {
        action: "produce"
        outputOf: $process
        provider: $agent
        receiver: $agent
        hasPointInTime: $creationTime
        resourceConformsTo: $resourceSpec
        resourceQuantity: { hasNumericalValue: 1, hasUnit: $unitOne }
        resourceMetadata: $dppUlid
      }
      newInventoriedResource: { name: $name, note: $note }
    ) {
      economicEvent {
        id
        resourceInventoriedAs { id name metadata }
      }
    }
  }
`;

// ────────────────────────────────────────────────────────────────────────────────
// MAIN DATA INJECTION LOGIC
// ────────────────────────────────────────────────────────────────────────────────

async function main() {
  const results = {
    users: [],
    designs: [],
    services: [],
    products: [],
    dpps: [],
    feedback: [],
  };

  // ── STEP 1: Fetch specs ──────────────────────────────────────────────────────
  console.log("── Step 1: Fetching resource specifications ──");
  const specs = await zenflowsQuery(QUERY_PROJECT_TYPES);
  const projectSpecs = {
    design: specs?.instanceVariables?.specs?.specProjectDesign,
    product: specs?.instanceVariables?.specs?.specProjectProduct,
    service: specs?.instanceVariables?.specs?.specProjectService,
    dpp: specs?.instanceVariables?.specs?.specDpp || { id: SPEC_DPP },
    machine: specs?.instanceVariables?.specs?.specMachine || { id: SPEC_MACHINE },
  };
  const unitOne = specs?.instanceVariables?.units?.unitOne;
  console.log(`  Design spec ID:  ${projectSpecs.design?.id}`);
  console.log(`  Product spec ID: ${projectSpecs.product?.id}`);
  console.log(`  Service spec ID: ${projectSpecs.service?.id}`);
  console.log(`  DPP spec ID:     ${projectSpecs.dpp?.id}`);
  console.log(`  Unit One:        ${unitOne?.id}`);
  console.log("");

  // ── STEP 2: Create users ─────────────────────────────────────────────────────
  console.log("── Step 2: Creating 3 users ──");

  const userDefs = [
    {
      name: "Alice Designer",
      username: "alice_designer",
      email: "alice.designer@example.com",
      challenges: {
        q1: "Paris",
        q2: "Rex",
        q3: "Smith",
        q4: "Berlin",
        q5: "Maria",
      },
    },
    {
      name: "Bob Maker",
      username: "bob_maker",
      email: "bob.maker@example.com",
      challenges: {
        q1: "London",
        q2: "Max",
        q3: "Johnson",
        q4: "Tokyo",
        q5: "Anna",
      },
    },
    {
      name: "Clara Reviewer",
      username: "clara_reviewer",
      email: "clara.reviewer@example.com",
      challenges: {
        q1: "Rome",
        q2: "Luna",
        q3: "Brown",
        q4: "Madrid",
        q5: "Sophia",
      },
    },
  ];

  for (let i = 0; i < userDefs.length; i++) {
    const def = userDefs[i];
    console.log(`  [${i + 1}/3] Creating user: ${def.name} (${def.email})`);

    // Step 2a: Register email to get HMAC (handle existing users)
    let hmac;
    try {
      const regResult = await zenflowsRequest(REGISTER_USER, {
        firstRegistration: true,
        userData: JSON.stringify({ email: def.email }),
      });
      hmac = regResult?.keypairoomServer;
      if (!hmac) throw new Error(`Failed to register user ${def.email}`);
      console.log("    ✓ Got HMAC from server");
    } catch (e) {
      if (e.message && e.message.includes("email exists")) {
        console.log("    ⚠ Email already registered, fetching HMAC...");
        const regResult = await zenflowsRequest(REGISTER_USER, {
          firstRegistration: false,
          userData: JSON.stringify({ email: def.email }),
        });
        hmac = regResult?.keypairoomServer;
        if (!hmac) throw new Error(`Failed to get HMAC for existing user ${def.email}`);
        console.log("    ✓ Got HMAC from server");
      } else {
        throw e;
      }
    }

    // Step 2b: Generate keys
    const keys = await generateKeys(def.email, def.challenges, hmac);
    console.log("    ✓ Generated keys");

    // Step 2c: Create person (skip if already exists)
    let agent;
    try {
      const signUpResult = await zenflowsRequest(SIGN_UP, {
        name: def.name,
        user: def.username,
        email: def.email,
        eddsaPublicKey: keys.eddsaPublicKey,
        reflowPublicKey: keys.reflowPublicKey,
        ethereumAddress: keys.ethereumAddress,
        ecdhPublicKey: keys.ecdhPublicKey,
        bitcoinPublicKey: keys.bitcoinPublicKey,
      });
      agent = signUpResult?.createPerson?.agent;
      if (!agent) throw new Error(`Failed to create person ${def.email}`);
      console.log(`    ✓ Person created: ${agent.id}`);
    } catch (e) {
      if (e.message && (e.message.includes("already been taken") || e.message.includes("exists"))) {
        console.log("    ⚠ Person already exists, looking up...");
        // Fall through to personCheck below
      } else {
        throw e;
      }
    }

    // Step 2d: Verify user exists via personCheck
    const checkResult = await zenflowsRequest(FETCH_SELF, {
      email: def.email,
      pubkey: keys.eddsaPublicKey,
    });
    const person = checkResult?.personCheck;
    console.log(`    ✓ Verified: ${person?.name} (${person?.id})`);

    // Register DID via user auth (needed for DPP and Feedback auth)
    try {
      const userAuth = { username: def.username, privateKey: keys.eddsaPrivateKey, publicKey: keys.eddsaPublicKey };
      await zenflowsRequest(CLAIM_DID, { id: person?.id || agent?.id }, userAuth);
      console.log(`    ✓ DID claimed`);
    } catch (e) {
      console.log(`    ⚠ DID claim failed (may already exist): ${e.message}`);
    }

    const userId = agent?.id || person?.id;
    if (!userId) throw new Error(`Could not determine user ID for ${def.email}`);

    results.users.push({
      id: userId,
      name: def.name,
      username: def.username,
      email: def.email,
      privateKey: keys.eddsaPrivateKey,
      publicKey: keys.eddsaPublicKey,
    });
  }
  console.log("");

  // Auth helper for one of the users (Alice will create designs)
  const aliceAuth = {
    username: results.users[0].username,
    privateKey: results.users[0].privateKey,
    publicKey: results.users[0].publicKey,
    id: results.users[0].id,
  };

  // Bob creates products
  const bobAuth = {
    username: results.users[1].username,
    privateKey: results.users[1].privateKey,
    publicKey: results.users[1].publicKey,
    id: results.users[1].id,
  };

  // Clara for feedback
  const claraAuth = {
    username: results.users[2].username,
    privateKey: results.users[2].privateKey,
    publicKey: results.users[2].publicKey,
    id: results.users[2].id,
  };

  const mutateAlice = zenflowsMutate(aliceAuth);
  const mutateBob = zenflowsMutate(bobAuth);

  // Upload a fallback image for when downloads fail
  const dppSignScript = fs.readFileSync(path.join(__dirname, "zenflows-crypto", "src", "sign_graphql.zen"), "utf8");
  const fallbackImage = await createPicsumImage("placeholder", aliceAuth.privateKey, aliceAuth.publicKey, dppSignScript);
  console.log("");

  // Check 3D model file
  console.log("── Checking 3D model file ──");
  if (!fs.existsSync(STL_FILE_PATH)) {
    console.log(`  ⚠  STL file not found at ${STL_FILE_PATH}`);
    console.log("  Will skip model uploads for designs");
    var hasStlModel = false;
  } else {
    console.log(`  ✓ STL file found: ${path.basename(STL_FILE_PATH)} (${fs.statSync(STL_FILE_PATH).size} bytes)`);
    var hasStlModel = true;
  }
  console.log("");

  // ── STEP 3: Create 5 designs ─────────────────────────────────────────────────
  console.log("── Step 3: Creating 5 designs ──");

  const designDefs = [
    {
      name: "Modular Gear System",
      description: "A parametric modular gear system for 3D printing. Features customizable tooth profiles, sizes, and configurations. Designed for maximum compatibility and easy assembly.",
      link: "https://github.com/example/modular-gear",
      license: "CC-BY-SA-4.0",
      tags: ["3d-printing", "mechanical", "parametric"],
      location: { name: "FabLab Torino", query: "Turin, Italy" },
      imageSeed: "modular-gears-3d-printing",
    },
    {
      name: "Ergonomic Handle Grip",
      description: "An ergonomic handle grip design optimized for comfort and durability. Features textured surfaces for better grip and shock absorption properties.",
      link: "https://github.com/example/ergo-handle",
      license: "GPL-3.0",
      tags: ["ergonomics", "accessibility", "3d-printing"],
      location: { name: "DesignLab Vienna", query: "Vienna, Austria" },
      imageSeed: "ergonomic-handle-grip-design",
    },
    {
      name: "Solar Panel Mount Bracket",
      description: "Universal solar panel mounting bracket designed for various panel sizes. Made for easy installation with standard tools. Weather-resistant and durable.",
      link: "https://github.com/example/solar-bracket",
      license: "CC0-1.0",
      tags: ["solar", "renewable-energy", "mounting"],
      location: { name: "GreenFab Lisbon", query: "Lisbon, Portugal" },
      imageSeed: "solar-panel-mounting-bracket",
    },
    {
      name: "Bicycle Cargo Rack",
      description: "Lightweight yet sturdy bicycle cargo rack compatible with most frame types. Designed to carry up to 25kg with optimal weight distribution.",
      link: "https://github.com/example/bike-rack",
      license: "CC-BY-4.0",
      tags: ["bicycle", "transportation", "cargo"],
      imageSeed: "bicycle-cargo-rack-metal",
    },
    {
      name: "Desktop Cable Organizer",
      description: "Modular cable management system for desks and workstations. Keeps cables organized, prevents tangling, and improves workspace aesthetics.",
      link: "https://github.com/example/cable-organizer",
      license: "MIT",
      tags: ["organization", "workspace", "modular"],
      imageSeed: "cable-management-desk-organizer",
    },
  ];

  for (let i = 0; i < designDefs.length; i++) {
    const def = designDefs[i];
    console.log(`  [${i + 1}/5] Creating design: ${def.name}`);

    // Download relevant image
    console.log(`    Downloading image...`);
    const image = (await createPicsumImage(def.imageSeed, aliceAuth.privateKey, aliceAuth.publicKey, dppSignScript)) || fallbackImage;

    // Create process
    const { createProcess: cp } = await mutateAlice(CREATE_PROCESS, { name: `creation of ${def.name} by ${aliceAuth.username}` });
    const processId = cp?.process?.id;

    // Upload model file to DPP
    let models = [];
    if (hasStlModel) {
      try {
        const attachment = await dppUploadFile(STL_FILE_PATH, aliceAuth.privateKey, aliceAuth.publicKey);
        const modelMeta = {
          contentType: attachment.contentType,
          downloadUrl: `${DPP_URL}/file/${encodeURIComponent(attachment.id)}`,
          extension: path.extname(STL_FILE_PATH).slice(1),
          fileName: attachment.fileName,
          id: attachment.id,
          mimeType: attachment.contentType,
          name: attachment.fileName,
          size: attachment.size,
          storage: "dpp",
          uploadedAt: attachment.uploadedAt,
          url: `${DPP_URL}/file/${encodeURIComponent(attachment.id)}`,
          checksum: attachment.checksum,
        };
        models = [modelMeta];
        console.log(`    ✓ Model uploaded: ${attachment.fileName}`);
      } catch (e) {
        console.log(`    ⚠  Model upload failed: ${e.message}`);
      }
    }

    // Lookup and create location
    let designLocationId = null;
    if (def.location) {
      const loc = await lookupLocation(def.location.query);
      if (loc) {
        designLocationId = await createSpatialThing(mutateAlice, def.location.name, loc.address, loc.lat, loc.lng);
        if (designLocationId) {
          console.log(`    ✓ Location: ${def.location.name} (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`);
        }
      }
      if (!designLocationId) console.log(`    ⚠ Location lookup failed`);
    }

    // Prepare metadata (with DPP image URL)
    const metadata = JSON.stringify({
      contributors: [],
      relations: [],
      remote: !designLocationId,
      models,
      image: image,  // DPP file URL
    });

    const designTags = def.tags.map(t => `tag-${slugify(t)}`);
    const licenseTag = `license-${slugify(def.license)}`;
    const tags = [...designTags, licenseTag];

    // Create design project
    const { createEconomicEvent: cee } = await mutateAlice(CREATE_PROJECT, {
      name: def.name,
      note: def.description,
      metadata,
      agent: aliceAuth.id,
      creationTime: new Date().toISOString(),
      resourceSpec: projectSpecs.design.id,
      oneUnit: unitOne.id,
      images: [],
      repo: def.link,
      process: processId,
      license: def.license,
      tags,
      location: designLocationId,
    });

    const designId = cee?.economicEvent?.resourceInventoriedAs?.id;
    console.log(`    ✓ Design created: ${designId}`);

    results.designs.push({ id: designId, name: def.name, processId, models });
  }
  console.log("");

  // ── STEP 4: Create 3 services ─────────────────────────────────────────────────
  console.log("── Step 4: Creating 3 services ──");

  const serviceDefs = [
    {
      name: "3D Printing Consultation",
      description: "Expert consultation service for 3D printing projects. Includes material selection advice, print optimization, and post-processing guidance. Available remotely or on-site.",
      link: "https://example.com/3d-consulting",
      license: "CC-BY-SA-4.0",
      tags: ["consulting", "3d-printing", "education"],
      serviceType: ["Fabrication", "Learning & Education"],
      availability: ["Booking Required", "Weekends Available"],
      location: { name: "Makerspace Amsterdam", query: "Amsterdam, Netherlands" },
      imageSeed: "3d-printer-filament-colors",
    },
    {
      name: "Custom PCB Design Service",
      description: "Professional PCB design and prototyping service. From schematic capture to layout and manufacturing files. Supports multi-layer boards and high-speed design.",
      link: "https://example.com/pcb-design",
      license: "GPL-3.0",
      tags: ["electronics", "pcb", "prototyping"],
      serviceType: ["Fabrication", "Space Access"],
      availability: ["Available Now", "Weekdays Only"],
      location: { name: "TechHub Berlin", query: "Berlin, Germany" },
      imageSeed: "printed-circuit-board-electronics",
    },
    {
      name: "Sustainable Packaging Consulting",
      description: "Consulting service for eco-friendly packaging solutions. Lifecycle analysis, material selection, and design optimization for minimal environmental impact.",
      link: "https://example.com/eco-packaging",
      license: "CC0-1.0",
      tags: ["sustainability", "packaging", "consulting"],
      serviceType: ["Learning & Education"],
      availability: ["Available Now", "Weekends Available"],
      location: { name: "GreenLab Barcelona", query: "Barcelona, Spain" },
      imageSeed: "sustainable-eco-packaging-nature",
    },
  ];

  // Bob creates services
  for (let i = 0; i < serviceDefs.length; i++) {
    const def = serviceDefs[i];
    console.log(`  [${i + 1}/3] Creating service: ${def.name}`);

    const image = (await createPicsumImage(def.imageSeed, aliceAuth.privateKey, aliceAuth.publicKey, dppSignScript)) || fallbackImage;

    const { createProcess: cp } = await mutateBob(CREATE_PROCESS, { name: `creation of ${def.name} by ${bobAuth.username}` });
    const processId = cp?.process?.id;

    // Lookup and create location
    let locationId = null;
    let isRemote = true;
    if (def.location) {
      const loc = await lookupLocation(def.location.query);
      if (loc) {
        locationId = await createSpatialThing(mutateBob, def.location.name, loc.address, loc.lat, loc.lng);
        if (locationId) {
          isRemote = false;
          console.log(`    ✓ Location: ${def.location.name} (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`);
        }
      }
      if (!locationId) console.log(`    ⚠ Location lookup failed, marking as remote`);
    }

    const metadata = JSON.stringify({
      contributors: [],
      relations: [],
      remote: isRemote,
      serviceFilters: {
        serviceType: def.serviceType || [],
        availability: def.availability || [],
      },
      image: image,
    });

    const baseTags = def.tags.map(t => `tag-${slugify(t)}`);
    const serviceTypeTags = (def.serviceType || []).map(s => `servicetype-${slugify(s)}`);
    const availabilityTags = (def.availability || []).map(a => `availability-${slugify(a)}`);
    const allTags = [...new Set([...baseTags, ...serviceTypeTags, ...availabilityTags])];

    const { createEconomicEvent: cee } = await mutateBob(CREATE_PROJECT, {
      name: def.name,
      note: def.description,
      metadata,
      agent: bobAuth.id,
      creationTime: new Date().toISOString(),
      resourceSpec: projectSpecs.service.id,
      oneUnit: unitOne.id,
      images: [],
      repo: def.link,
      process: processId,
      license: def.license,
      tags: allTags,
      location: locationId,
    });

    const serviceId = cee?.economicEvent?.resourceInventoriedAs?.id;
    console.log(`    ✓ Service created: ${serviceId}`);
    results.services.push({ id: serviceId, name: def.name, processId });
  }
  console.log("");

  // ── STEP 5: Create 5 products (each linked to a design) ───────────────────────
  console.log("── Step 5: Creating 5 products (linked to designs) ──");

  // Helper: generate monotonic range tags for numeric filters (matching lib/tagging.ts)
  function monotonicRangeTags(prefix, value, thresholds) {
    if (!Number.isFinite(value)) return [];
    const sorted = [...new Set(thresholds.filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
    const formatVal = v => Number.isInteger(v) ? String(v) : String(v).replace(/\./g, "p");
    const ge = sorted.filter(t => t <= value).map(t => `${prefix}-ge-${formatVal(t)}`);
    const le = sorted.filter(t => t >= value).map(t => `${prefix}-le-${formatVal(t)}`);
    return [...new Set([...ge, ...le])];
  }

  function slugify(str) {
    return str.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  }

  const RECYCLABILITY_THRESHOLDS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const POWER_THRESHOLDS_W = [0, 10, 25, 50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000];
  const ENERGY_THRESHOLDS_KWH = [0, 10, 20, 30, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000];
  const CO2_THRESHOLDS_KG = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 5, 7.5, 10, 15, 20];

  const productDefs = [
    {
      name: "Premium Gear Set",
      description: "High-precision modular gear set manufactured from recycled PLA. Includes 5 gear sizes and compatible axles. Perfect for robotics and mechanical projects.",
      link: "https://github.com/example/premium-gears",
      license: "CC-BY-SA-4.0",
      tags: ["gears", "robotics", "mechanical"],
      designIndex: 0,
      productFilters: {
        categories: ["Electronics", "Tools"],
        powerCompatibility: ["120V AC", "Battery Powered"],
        replicability: ["High"],
        recyclabilityPct: 80,
        repairability: true,
        powerRequirementW: 150,
        energyKwh: 50,
        co2Kg: 5,
      },
      location: { name: "FabLab Milano", query: "Milan, Italy" },
      imageSeed: "precision-gears-mechanical-metal",
    },
    {
      name: "ErgoGrip Pro Handle",
      description: "Professional-grade ergonomic handle with dual-material construction. Features soft-touch TPU overmold on a rigid PLA core. Available in multiple sizes.",
      link: "https://github.com/example/ergogrip-pro",
      license: "CC-BY-SA-4.0",
      tags: ["ergonomics", "professional", "tools"],
      designIndex: 1,
      productFilters: {
        categories: ["Tools", "Wearables"],
        powerCompatibility: ["Battery Powered", "USB-C"],
        replicability: ["Medium"],
        recyclabilityPct: 65,
        repairability: true,
        powerRequirementW: 10,
        energyKwh: 20,
        co2Kg: 1.5,
      },
      location: { name: "Hackerspace Paris", query: "Paris, France" },
      imageSeed: "ergonomic-tool-handle-professional",
    },
    {
      name: "SunMount Universal Bracket",
      description: "Heavy-duty solar panel mounting bracket with adjustable angle (15°-45°). Made from recycled aluminum with stainless steel hardware. Rated for 100+ mph winds.",
      link: "https://github.com/example/sunmount",
      license: "CC0-1.0",
      tags: ["solar", "renewable", "outdoor"],
      designIndex: 2,
      productFilters: {
        categories: ["Energy", "Sustainability"],
        powerCompatibility: ["220-240V AC", "24V DC"],
        replicability: ["Low", "Medium"],
        recyclabilityPct: 95,
        repairability: true,
        powerRequirementW: 500,
        energyKwh: 200,
        co2Kg: 10,
      },
      location: { name: "SolarLab Valencia", query: "Valencia, Spain" },
      imageSeed: "solar-panel-renewable-energy-sun",
    },
    {
      name: "Urban Cargo Rack XL",
      description: "Extra-large bicycle cargo rack with integrated pannier rails. Powder-coated steel construction. Compatible with disc brake and rim brake bikes.",
      link: "https://github.com/example/urban-rack-xl",
      license: "CC-BY-4.0",
      tags: ["bicycle", "urban", "transport"],
      designIndex: 3,
      productFilters: {
        categories: ["Furniture", "Sustainability"],
        powerCompatibility: ["USB-C", "12V DC"],
        replicability: ["Medium"],
        recyclabilityPct: 90,
        repairability: true,
        powerRequirementW: 0,
        energyKwh: 300,
        co2Kg: 15,
      },
      location: { name: "BikeKitchen Copenhagen", query: "Copenhagen, Denmark" },
      imageSeed: "bike-cargo-rack-urban-commute",
    },
    {
      name: "DeskMate Cable System",
      description: "Complete cable management kit with under-desk tray, cable clips, and routing channels. Includes adhesive mounts and cable ties. Fits desks up to 2m wide.",
      link: "https://github.com/example/deskmate",
      license: "MIT",
      tags: ["desk", "organization", "office"],
      designIndex: 4,
      productFilters: {
        categories: ["Education", "Medical", "Home renovation"],
        powerCompatibility: ["12V DC", "Battery Powered"],
        replicability: ["High"],
        recyclabilityPct: 70,
        repairability: true,
        powerRequirementW: 75,
        energyKwh: 100,
        co2Kg: 2.5,
      },
      location: { name: "OpenLab London", query: "London, United Kingdom" },
      imageSeed: "cable-management-desk-workspace",
    },
  ];

  for (let i = 0; i < productDefs.length; i++) {
    const def = productDefs[i];
    console.log(`  [${i + 1}/5] Creating product: ${def.name}`);

    const image = (await createPicsumImage(def.imageSeed, aliceAuth.privateKey, aliceAuth.publicKey, dppSignScript)) || fallbackImage;

    const { createProcess: cp } = await mutateBob(CREATE_PROCESS, { name: `creation of ${def.name} by ${bobAuth.username}` });
    const processId = cp?.process?.id;

    // Lookup and create location
    let productLocationId = null;
    if (def.location) {
      const loc = await lookupLocation(def.location.query);
      if (loc) {
        productLocationId = await createSpatialThing(mutateBob, def.location.name, loc.address, loc.lat, loc.lng);
        if (productLocationId) {
          console.log(`    ✓ Location: ${def.location.name} (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`);
        }
      }
      if (!productLocationId) console.log(`    ⚠ Location lookup failed`);
    }

    // Build tags using the same prefixes as lib/tagging.ts
    const pf = def.productFilters || {};
    const baseTags = def.tags.map(t => `tag-${slugify(t)}`);

    const categoryTags = (pf.categories || []).map(c => `category-${slugify(c)}`);
    const powerCompatTags = (pf.powerCompatibility || []).map(p => `powercompat-${slugify(p)}`);
    const replicabilityTags = (pf.replicability || []).map(r => `replicability-${slugify(r)}`);

    const recyclabilityTags = Number.isFinite(pf.recyclabilityPct)
      ? monotonicRangeTags("recyclability", pf.recyclabilityPct, RECYCLABILITY_THRESHOLDS)
      : [];
    const repairabilityTags = pf.repairability ? ["repairability-available"] : [];

    const powerReqTags = Number.isFinite(pf.powerRequirementW)
      ? monotonicRangeTags("powerreq", pf.powerRequirementW, POWER_THRESHOLDS_W)
      : [];
    const energyTags = Number.isFinite(pf.energyKwh)
      ? monotonicRangeTags("env-energy", pf.energyKwh, ENERGY_THRESHOLDS_KWH)
      : [];
    const co2Tags = Number.isFinite(pf.co2Kg)
      ? monotonicRangeTags("env-co2", pf.co2Kg, CO2_THRESHOLDS_KG)
      : [];

    // Merge all tags (deduplicated)
    const licenseTag = `license-${slugify(def.license)}`;
    const allTags = [...new Set([
      ...baseTags,
      ...categoryTags,
      ...powerCompatTags,
      ...replicabilityTags,
      ...recyclabilityTags,
      ...repairabilityTags,
      ...powerReqTags,
      ...energyTags,
      ...co2Tags,
      licenseTag,
    ])];

    const designId = results.designs[def.designIndex].id;

    const metadata = JSON.stringify({
      contributors: [],
      relations: [],
      remote: !productLocationId,
      design: designId,
      models: results.designs[def.designIndex].models,
      productFilters: def.productFilters,
      image: image,
    });

    // Create product
    const { createEconomicEvent: cee } = await mutateBob(CREATE_PROJECT, {
      name: def.name,
      note: def.description,
      metadata,
      agent: bobAuth.id,
      creationTime: new Date().toISOString(),
      resourceSpec: projectSpecs.product.id,
      oneUnit: unitOne.id,
      images: [],
      repo: def.link,
      process: processId,
      license: def.license,
      tags: allTags,
      location: productLocationId,
    });

    const productId = cee?.economicEvent?.resourceInventoriedAs?.id;
    console.log(`    ✓ Product created: ${productId}`);

    // Cite the design (link product to design)
    try {
      await mutateBob(CITE_PROJECT, {
        agent: bobAuth.id,
        creationTime: new Date().toISOString(),
        resource: designId,
        process: processId,
        unitOne: unitOne.id,
      });
      console.log(`    ✓ Design ${designId} cited from product`);
    } catch (e) {
      console.log(`    ⚠  Could not cite design: ${e.message}`);
    }

    results.products.push({ id: productId, name: def.name, processId, designId });
  }
  console.log("");

  // ── STEP 6: Create DPPs (3 per product = 15) ──────────────────────────────────
  console.log("── Step 6: Creating DPPs (3 per product) ──");

  for (let pi = 0; pi < results.products.length; pi++) {
    const product = results.products[pi];
    console.log(`  Product: ${product.name} (${product.id})`);

    for (let di = 0; di < 3; di++) {
      const dppName = `DPP #${di + 1} for ${product.name}`;
      console.log(`    [${di + 1}/3] ${dppName}`);

      // Step 6a: Create DPP document in interfacer-dpp
      let dppUlid;
      try {
        const dppBody = {
          productId: product.id,
          batchType: di === 0 ? "batch" : "unit",
          batchId: `BATCH-${product.id.substring(0, 8)}-${di + 1}`,
          // Minimal product overview section
          productOverview: {
            productName: { type: "Text", value: product.name },
            productDescription: { type: "Text", value: `Digital Product Passport #${di + 1} for ${product.name}` },
          },
          environmentalImpact: {
            co2eEmissionsPerUnit: { type: "Number", value: 12.5 + di * 3, units: "kg CO2e" },
            energyConsumptionPerUnit: { type: "Number", value: 45 + di * 10, units: "kWh" },
          },
          recyclability: {
            materialComposition: { type: "Text", value: "Recycled PLA 70%, Virgin PLA 30%" },
          },
          complianceAndStandards: {
            ceMarking: { type: "Text", value: "Yes" },
            rohsCompliance: { type: "Text", value: "Yes" },
          },
          energyUseAndEfficiency: {
            powerRating: { type: "Number", value: 150 + di * 25, units: "W" },
          },
          economicOperator: {
            companyName: { type: "Text", value: "Interfacer Demo Inc." },
            addressLine1: { type: "Text", value: "123 Innovation Street" },
          },
        };

        const dppResponse = await (await dppRequest(
          "POST",
          "/dpp",
          dppBody,
          bobAuth.privateKey,
          bobAuth.publicKey,
          { "x-user-id": bobAuth.id }
        )).json();
        dppUlid = dppResponse.insertedID;
        console.log(`      ✓ DPP document created: ${dppUlid}`);
      } catch (e) {
        console.log(`      ⚠  DPP creation failed: ${e.message}`);
        continue;
      }

      // Step 6b: Create DPP economic resource in zenflows
      try {
        const dppProcess = await mutateBob(CREATE_PROCESS, { name: `creation of ${dppName} by ${bobAuth.username}` });
        const dppProcessId = dppProcess?.createProcess?.process?.id;

        const { createEconomicEvent: dppCee } = await mutateBob(CREATE_DPP_RESOURCE, {
          agent: bobAuth.id,
          creationTime: new Date().toISOString(),
          process: dppProcessId,
          resourceSpec: projectSpecs.dpp.id,
          unitOne: unitOne.id,
          dppUlid: JSON.stringify({ dppServiceUlid: dppUlid }),
          name: dppName,
          note: `Digital Product Passport for ${product.name} #${di + 1}`,
        });
        const dppResourceId = dppCee?.economicEvent?.resourceInventoriedAs?.id;
        console.log(`      ✓ DPP resource created: ${dppResourceId}`);

        // Cite DPP from product
        await mutateBob(CITE_PROJECT, {
          agent: bobAuth.id,
          creationTime: new Date().toISOString(),
          resource: dppResourceId,
          process: product.processId,
          unitOne: unitOne.id,
        });
        console.log(`      ✓ DPP cited from product`);

        results.dpps.push({ id: dppResourceId, dppUlid, productId: product.id, productName: product.name, index: di });
      } catch (e) {
        console.log(`      ⚠  DPP resource creation failed: ${e.message}`);
      }
    }
  }
  console.log("");

  // ── STEP 7: Inject feedback ───────────────────────────────────────────────────
  console.log("── Step 7: Injecting feedback (reviews + comments) ──");

  // Clara will write reviews and comments
  const claraHeaders = {
    "x-user-id": claraAuth.id,
  };

  async function feedbackRequest(method, urlPath, body = null) {
    const fullUrl = `${FEEDBACK_URL}${urlPath}`;
    const jsonBody = body != null ? JSON.stringify(body) : "";
    const sigHeaders = await signRequestBody(jsonBody, claraAuth.privateKey, claraAuth.publicKey);
    const headers = { ...claraHeaders, ...sigHeaders };
    if (body != null) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(fullUrl, { method, headers, body: body != null ? jsonBody : undefined });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`${res.status}: ${errBody}`);
    }
    return res.json().catch(() => ({}));
  }

  // Review and comment on 3 products
  const reviewTargets = [results.products[0], results.products[2], results.products[4]];
  for (const product of reviewTargets) {
    console.log(`  Product: ${product.name}`);

    // Create review
    try {
      const review = await feedbackRequest("POST", `/api/v1/projects/${product.id}/reviews`, {
        rating: 4,
        content: `Great product! The ${product.name} is well-designed and works perfectly. Highly recommended for anyone interested in open hardware.`,
      });
      console.log(`    ✓ Review created: ${JSON.stringify(review)}`);
      results.feedback.push({ type: "review", productId: product.id, ...review });
    } catch (e) {
      console.log(`    ⚠  Review failed: ${e.message}`);
    }

    // Create comment
    try {
      const comment = await feedbackRequest("POST", `/api/v1/projects/${product.id}/comments`, {
        content: `I've been using the ${product.name} for a few weeks now and it's been great. The build quality is excellent and the documentation was very helpful for assembly.`,
        parent_id: null,
        attachments: null,
      });
      console.log(`    ✓ Comment created: ${JSON.stringify(comment)}`);
      results.feedback.push({ type: "comment", productId: product.id, ...comment });
    } catch (e) {
      console.log(`    ⚠  Comment failed: ${e.message}`);
    }
  }

  // Also review one design
  if (results.designs.length > 0) {
    const design = results.designs[0];
    console.log(`  Design: ${design.name}`);
    try {
      const review = await feedbackRequest("POST", `/api/v1/projects/${design.id}/reviews`, {
        rating: 5,
        content: "Excellent parametric design! The modular gear system is incredibly versatile and well-documented.",
      });
      console.log(`    ✓ Review created: ${JSON.stringify(review)}`);
      results.feedback.push({ type: "review", productId: design.id, ...review });
    } catch (e) {
      console.log(`    ⚠  Review failed: ${e.message}`);
    }
  }
  console.log("");

  // ── SUMMARY ───────────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════");
  console.log("  DATA INJECTION COMPLETE");
  console.log("═══════════════════════════════════════════");
  console.log(`  Users:    ${results.users.length} created`);
  console.log(`  Designs:  ${results.designs.length} created`);
  console.log(`  Services: ${results.services.length} created`);
  console.log(`  Products: ${results.products.length} created`);
  console.log(`  DPPs:     ${results.dpps.length} created`);
  console.log(`  Feedback: ${results.feedback.length} items`);
  console.log("");

  // Write results to JSON for reference
  const resultsPath = path.join(__dirname, "results.json");
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`  Results saved to: ${resultsPath}`);

  return results;
}

// ────────────────────────────────────────────────────────────────────────────────
// RUN
// ────────────────────────────────────────────────────────────────────────────────

main()
  .then(() => {
    console.log("\n✓ Script completed successfully!");
    process.exit(0);
  })
  .catch(err => {
    console.error("\n✗ Script failed:", err);
    process.exit(1);
  });
