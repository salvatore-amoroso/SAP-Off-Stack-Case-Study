# Supported lab commands

Run commands from the repository root. The [install and run guide](../docs/requirements-install-run.md)
documents prerequisites, credentials, driver staging, arguments and execution order.

| Purpose | Entry points |
| --- | --- |
| Check prerequisites and build clients | `npm run doctor`, `npm run build:clients` |
| Verify without SAP or proprietary drivers | `npm run verify:offline`, `npm run verify:docs` |
| Provision the restricted native HANA view/user | [setup-native-hana.mjs](setup-native-hana.mjs) |
| Verify live services and SQL parity | [check-sap-service.mjs](check-sap-service.mjs), [run-cds-odbc-clients.mjs](run-cds-odbc-clients.mjs), [run-native-abap.mjs](run-native-abap.mjs), [run-native-clients.mjs](run-native-clients.mjs) |
| Capture and validate benchmark prerequisites | [capture-sap-readiness.mjs](capture-sap-readiness.mjs), [prepare-nine-readiness.mjs](prepare-nine-readiness.mjs) |
| Run all nine applications | [run-nine-comparison.mjs](run-nine-comparison.mjs), using `--smoke` for a quick check |
| Resume an interrupted run | [continue-nine-comparison.mjs](continue-nine-comparison.mjs), preserving failed attempts |
| Publish and verify a new evidence archive | [archive-nine-run.mjs](archive-nine-run.mjs), [check-nine-postrun.mjs](check-nine-postrun.mjs) |
| Recompute results, figures and independent checks | [analyze-nine-comparison.mjs](analyze-nine-comparison.mjs), [plot-nine-comparison.py](plot-nine-comparison.py), [audit-nine-run.mjs](audit-nine-run.mjs) |
| Verify SQL recovery and Kubernetes driver staging | [check-hana-recovery.mjs](check-hana-recovery.mjs), [check-cds-odbc-kubernetes.mjs](check-cds-odbc-kubernetes.mjs) |

Other modules support these commands, fixture generation and HTTP conformance;
`*.test.mjs` files are exercised by offline verification. Deployment-specific
commands live in [deploy](../deploy/README.md) and [deploy/sql](../deploy/sql/README.md).

Scripts under `docs/benchmark-data/` are frozen measurement snapshots. Use the
current entry points above for the supported setup.
