# Contributor instructions

- Read [the behavior contract](docs/implementation-contract.md) before changing a poller. All nine paths must preserve its row validation, ordering, canonicalization and hashing. Coordinate shared changes through `contracts/fixtures.json` and the SAP fixture generator.
- Follow [the installation and run guide](docs/requirements-install-run.md). Keep machine-specific paths and runtime settings outside Git. Do not stop, recreate or reconfigure an existing SAP instance without explicit authorization; check SAP object names for collisions before import.
- Keep credentials, SAP driver binaries and private runtime configuration out of source, images, logs and committed evidence.
- Preserve the published, privacy-redacted final cohort under `docs/benchmark-data/` byte-for-byte. Store fresh runs and checks under ignored `results/` and `work/`; later fixes do not update historical timings.
- Run `npm run verify:offline` and `npm run verify:docs` for relevant changes. SAP changes also require activation and live parity checks. Report skipped checks and distinguish current verification from the recorded performance cohort.
