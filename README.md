# Interfacer Init Data

Test data injection scripts for the Interfacer platform.

## Overview

This project generates test data by directly interacting with the backend services:

| Service | Purpose | Interface |
|---------|---------|-----------|
| **Zenflows** | Users, projects, resources | GraphQL |
| **interfacer-dpp** | Digital Product Passports | REST |
| **interfacer-feedback** | Reviews and comments | REST |

## What Gets Created

| Entity | Count | Details |
|--------|-------|---------|
| Users | 3 | Alice (designer), Bob (maker), Clara (reviewer) |
| Designs | 5 | With 3D model files (.stl) |
| Services | 3 | Remote/digital services |
| Products | 5 | Each linked to a design |
| DPPs | 15 | 3 per product |
| Feedback | 7 | Reviews + comments |

## Data Flow per Entity

### User Creation
1. `keypairoomServer` mutation → get HMAC
2. Zenroom `keypairoomClient` → generate EdDSA, Ethereum, Reflow, Bitcoin, ECDH keys
3. `createPerson` mutation → create agent in zenflows
4. `personCheck` query → verify user exists

### Project Creation (Design / Service / Product)
1. `createProcess` mutation → create process
2. Upload images to zenflows file endpoint (sha512 hash)
3. Upload 3D models to DPP upload endpoint (sha256 + eddsa sign)
4. `createEconomicEvent` (action: "produce") → create resource
5. For products: `createEconomicEvent` (action: "cite") → link design
6. Add contributors, relations as needed

### DPP Creation
1. POST `/dpp` to DPP REST API (signed with eddsa)
2. `createEconomicEvent` (action: "produce", conformsTo: specDpp) → DPP resource
3. `createEconomicEvent` (action: "cite") → link DPP to product

### Feedback Creation
1. POST `/api/v1/projects/:id/reviews` → create review (1-5 stars)
2. POST `/api/v1/projects/:id/comments` → create comment
3. All feedback endpoints require eddsa-signed requests

## Prerequisites

- Node.js 18+
- Running services:
  - Zenflows (GraphQL at `NEXT_PUBLIC_ZENFLOWS_URL`)
  - interfacer-dpp (REST at `NEXT_PUBLIC_DPP_URL`)
  - interfacer-feedback (REST at `NEXT_PUBLIC_FEEDBACK_URL`)
- Environment: copy `.env.local` from `../interfacer-gui/`
- 3D model: `/Users/alcibiade/Desktop/incastro_mobile.stl`

## Usage

### As a standalone Node.js script:
```bash
node --experimental-vm-modules main.mjs
```

### As a Jupyter notebook (requires ijavascript):
```bash
npm install -g ijavascript
ijsinstall
jupyter notebook interfacer_init_data.ipynb
```

## Auth / Signing

All mutations are cryptographically signed using EdDSA keys generated via Zenroom.

### Zenflows GraphQL:
- Sign the entire request body (base64-encoded)
- Headers: `zenflows-sign`, `zenflows-user`, `zenflows-hash`
- Admin header: `zenflows-admin` (for privileged operations like `createPerson`)

### DPP / Feedback REST:
- Sign the request body (or empty string for GET/DELETE)
- Headers: `did-sign`, `did-pk`, `x-user-id`

## Output

After successful execution, a `results.json` file is created containing all created entity IDs, which can be used for cleanup or reference.
