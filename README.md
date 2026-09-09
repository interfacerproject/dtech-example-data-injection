# Interfacer demo-data injection

Demo-data generator aligned with the current `../interfacer-gui` data model. All supported entry points delegate to `init-data-sdk.mjs` and use `@dyne/interfacer-client`; there is no duplicate raw GraphQL/REST implementation.

## Generated data

| Entity | Count | Details |
|---|---:|---|
| Users | 3 | Designer, maker, reviewer |
| Machines | 4 | Typed and searchable machine resources |
| Designs | 5 | CAD URL, complexity, BOM, machines, materials, power requirements |
| Services | 3 | Service-type and availability filter tags |
| Products | 5 | Linked design, location, price, availability, catalog filter tags |
| DPPs | 15 | Three active passports per product |
| Feedback | 7 | Reviews and comments created through the SDK feedback client |

The generated metadata and classification tags follow the current GUI creation flow:

- user tags use `tag-*`;
- product and service filters are generated with `client.tagging`;
- complexity, machine, material, license, power, and manufacturability use the SDK tag prefixes;
- image URLs, CAD URLs, licenses, declarations, price, availability, and linked designs use the shapes read by the current GUI;
- design and DPP citations share the product creation process, preserving ValueFlows traceability;
- locations are created once and passed to `createProject` via `locationId`.

## Requirements

- Node.js 24 (the same version as `../interfacer-gui/.mise.toml`)
- pnpm 9.13.1
- reachable Zenflows, DPP, feedback, location, and Picsum services
- `../interfacer-gui/.env.local` or `../interfacer-gui/.env`

The script loads `.env`, then applies `.env.local` overrides. Variables already present in the shell have the highest precedence. In particular it consumes the GUI's `BASE_URL`, `NEXT_PUBLIC_ZENFLOWS_URL`, `NEXT_PUBLIC_DPP_URL`, `NEXT_PUBLIC_FEEDBACK_URL`, location endpoint, admin token, and optional specification IDs.

An optional `MODEL_URL` can override the public STL URL used for designs.

## Install and run

```bash
corepack enable
pnpm install
pnpm start
```

`main.mjs` is retained as a compatibility shim, so this also works:

```bash
node main.mjs
```

For Jupyter, install an ijavascript kernel and run `interfacer_init_data.ipynb`; the notebook imports the same SDK script rather than maintaining a separate injector.

## InMachines catalog injector

`init-data-inmachines.mjs` creates a dedicated InMachines account and imports the catalog scraped from:

- <https://www.inmachines.net/open-lab-starter-kit>
- <https://www.inmachines.net/services8f05a8a7>
- the four service detail pages linked from the services page;
- the eight linked repositories in the `Open-Lab-Starter-Kit` GitHub organization.

The normalized, reviewable snapshot is stored in `data/inmachines.json`. It contains source URLs, repository and license information, descriptions, original images, BOM links, and available STEP model links.

The injector creates:

- one InMachines account, if it does not already exist;
- eight OLSK designs;
- eight InMachines-built products, each linked to its design through the same creation process;
- three DPPs per product (24 total), also cited by the product creation process;
- four services;
- one shared InMachines location in Schwarzenbek.

Validate the dataset without accessing the backend:

```bash
pnpm dry-run:inmachines
```

Run the complete import:

```bash
pnpm start:inmachines
```

To backfill only the DPPs for products already listed in `results-inmachines.json`, without duplicating designs, products, services, or locations:

```bash
pnpm start:inmachines:dpps
```

The DPP backfill checkpoints `results-inmachines.json` after every successful passport and skips already recorded product/index pairs when resumed.

The default identity is `InMachines <info@inmachines.net>`. It can be overridden with `INMACHINES_NAME`, `INMACHINES_USERNAME`, and `INMACHINES_EMAIL`. The deterministic demo credentials can be overridden with `INMACHINES_CHALLENGE_1` through `INMACHINES_CHALLENGE_5`. If the email already belongs to an account created with different credentials, the script stops rather than impersonating or overwriting it.

The run writes public IDs to `results-inmachines.json`; private keys are never persisted there.

## Output

A successful run writes `results-sdk.json` with created IDs and public user data. Private keys are used only in memory and are not written to the output.

The injector is additive. Re-running it reuses deterministic demo identities but creates additional resources, DPPs, and feedback where accepted by the services.
