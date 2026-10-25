# System design, governance and maintainability

## Question and scope

The case study asks: **what performance benefit does each complete data-access
path deliver, and what governance and maintenance obligations accompany it?**
The two axes are:

- **Performance:** latency, useful throughput, trial-to-trial variation and
  observed failures for the same frozen read workload. Resource measurements
  are supplementary and must retain their documented coverage and boundaries.
- **Governance / maintainability:** identity and authorization, contract
  stability, dependency provisioning, change impact and ownership. These are
  evidence-based design assessments, not numerical maintenance benchmarks.

The comparison unit is the **complete data-access path**: runtime, placement,
service/query, driver and conversion. Correctness and reproducibility make
the comparison interpretable. Production deployment, production SLOs and
organizational adoption are outside this study's acceptance criteria.

The [architecture diagram in the README](../README.md) is the canonical graph.
It retains the **HTTP access** and **SQL access** groups, one ABAP runtime,
an ADBC adapter, external ODBC clients, and one HANA database containing
`ZBL_ORD_HDR` and `ZBL_ORD_POS`. All nine applications read that same database;
there is no PostgreSQL copy, ETL replica or independent language-specific dataset.

## Data model and common backend work

| Table | Primary key | Main contents |
| --- | --- | --- |
| `ZBL_ORD_HDR` | `CLIENT`, `ORDER_ID` | Customer, order date/status, currency, header net amount and timestamps. |
| `ZBL_ORD_POS` | `CLIENT`, `ORDER_ID`, `POSITION_NUMBER` | Material, quantity/unit, position net amount/currency and last-change timestamp. |

The CDS header exposes a `0..*` position association; the position entity exposes
its header association and projects the header's customer and date. The fixture
has exactly five positions per header. The native HANA view joins the same two
tables with an explicit client filter. Internal CDS relies on ABAP's client
handling; its selection is restricted to the configured SAP client.

Every timed scan selects the same nine fields: order ID, position number,
customer ID, order date, material ID, quantity, unit, net amount and currency.
Status, timestamps and the header total are outside the timed payload. Each
language validates field domains and strict ascending composite-key order,
normalizes quantity to three decimal places and amount to two using exact
strings, and incrementally hashes the same versioned UTF-8 TSV bytes. Rows
are streamed in bounded batches rather than collected and sorted locally.

This design makes the data work testable through shared fixtures and a golden
digest. Retrieval and native-to-text conversion remain path-specific costs;
common validation does not imply identical database queries, driver calls,
wire traffic or authorization semantics.

## Why ABAP, Node.js and Rust

| Language | Role in this experiment | Engineering tradeoffs |
| --- | --- | --- |
| ABAP | SAP-native reference: it shows the cost of running inside the SAP application server, through HTTP, internal CDS or ADBC. “Reference” here means this lab's baseline, not an SAP-certified benchmark. | Close to the data and SAP authorization/transport tooling. Execution consumes shared SAP resources, and this classic-ABAP implementation is not automatically an ABAP Cloud-compatible extension. |
| Node.js | Reference implementation for the SAP BTP side-by-side ecosystem. SAP provides a Cloud Foundry Node.js buildpack, and CAP offers Node.js and Java runtimes. This lab uses plain Node.js, not a CAP-generated application. | Accessible service-development ecosystem and SAP integration libraries; V8, allocation/GC, native addon crossings and dependency maintenance can affect CPU-bound work and driver behavior. |
| Rust | A compiled, performance-oriented contrast, with explicit ownership and no mandatory garbage collector. It lets us test whether the implemented path changes the cost of this workload. | A compiled build and SAP/native-library integration require ownership. Any learning or staffing penalty depends on the team's skills and is not measured here. The ODBC-driver obligation is shared with Node.js CDS. Rust is not universally “the fastest compiled language”; workload, implementation, compiler, libraries and access path determine the measured result. |

The platform rationale is supported by [SAP's Node.js environment guide](https://help.sap.com/docs/btp/sap-business-technology-platform/developing-node-js-in-cloud-foundry-environment?locale=en-US)
and [CAP runtime documentation](https://help.sap.com/docs/btp/btp-developers-guide/cloud-application-programming-model).
The Rust rationale follows its [performance and ownership design](https://rust-lang.org/index.html).
The measured rankings belong to [this experiment](nine-comparison.md).

## Nine implementations, three access approaches

| Approach | ABAP | Node.js | Rust |
| --- | --- | --- | --- |
| HTTP access | `IF_HTTP_CLIENT` through authenticated sockets | HTTP client | HTTP client |
| CDS access | ABAP SQL / Open SQL on `ZI_BL_OrderPosition` | unixODBC + SAP ABAP ODBC driver → ABAP SQL service → CDS | `odbc-api` + unixODBC + the same SAP driver → ABAP SQL service → CDS |
| Native HANA | ADBC using SAP's primary database session | SAP HANA client | `hdbconnect` |

The table separates **APIs from transports**. ADBC is an ABAP database API;
ODBC is a client database interface. Grouping them under SQL access does not
make them the same wire protocol. External ABAP ODBC uses HTTPS/WebSocket to
the ABAP SQL service, rather than connecting directly to HANA. Native HANA
clients use the database protocol on a private TCP endpoint.

### HTTP / OData service

`ZUI_BL_ORDERS_O4` exposes the CDS-backed `Orders` and `OrderPositions` entities
as a read-only OData V4 Web API. HTTP is a standard application protocol, and
OData defines interoperable data-service conventions. Clients consume a service
contract rather than SAP's physical table layout. Authentication, pagination,
metadata and serialization belong to this access path.
See [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110) and the
[OData protocol](https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part1-protocol.html).

For a compatible CDS model, a developer can create a **service definition and
OData service binding in ADT**, then activate and publish it. This avoids
hand-writing a separate JSON server for a simple read projection. The classic
**SAP Gateway Service Builder, transaction SEGW**, is another development route,
particularly for established Gateway/OData V2 services and custom provider logic.
It is distinct from the modern CDS/service-binding route used here; availability
and extensibility rules depend on the target system.
[SAP service bindings](https://help.sap.com/docs/abap-cloud/abap-rap/service-binding),
[Gateway Service Builder](https://help.sap.com/saphelp_snc700_ehp04/helpdata/en/cd/dd22512c312314e10000000a44176d/content.htm).

“Easy to expose” does not complete API governance. The SAP owner still needs to
approve fields, authorization, query limits, versioning, lifecycle and support.
An arbitrary custom OData service is not automatically an SAP-released API.

### CDS through internal ABAP or the ABAP SQL service

Internal ABAP selects the CDS entity directly; no HTTP data request is made.
External Node.js/Rust instead consume an explicitly exposed SQL binding,
`ZUI_BL_ORDERS_SQL`. The driver converts ODBC calls into ABAP SQL-service
requests. The service exposes an approved logical model while allowing SQL
projection/filtering; it does not expose an unrestricted HANA login.
SAP documents the [SQL-service exposure model](https://help.sap.com/docs/abap-cloud/abap-integration-connectivity/developing-and-exposing-sql-service-in-abap-system?version=sap_cross_product_abap).

**Rust + CDS preserves SAP-side access control.** The request remains inside
SAP's exposed service/identity boundary; Rust is the consumer language, not a
replacement for that boundary. Node.js through the same SQL binding has the
same architecture. Which CDS row controls apply is an authorization-mode
choice, as described below.

This is useful when a controlled data-integration consumer needs a tabular
contract and SQL capabilities. Governance must cover which CDS entities and
operations are exposed, how expensive queries are bounded, identity, quotas,
driver/certificate maintenance and schema evolution. Consumers must not treat
every internal CDS entity as a supported public contract.

### Direct HANA

All three native clients query `ZBL_BENCH_SQL.ORDER_POSITIONS_001`, a read-only
text projection over the custom lab header/position tables. It fixes client
`001` and formats dates/decimals without floating-point conversion. External
clients use a restricted HANA account; ABAP ADBC uses its primary SAP database
identity. Therefore their authentication and placement are not identical.

This removes the ABAP service layer from the external data path, but also
removes that layer as an authorization and semantic boundary. Database grants
and an explicitly client-filtered view are essential. Direct SQL does not
execute SAP application-level authorization or business behavior merely because
the underlying data originated in SAP. The lab's restricted custom view is not
permission or a recommendation to query standard SAP application tables directly.

## Authorization is part of the design

SAP-side access control and CDS row-level authorization are distinct layers:

| SQL-service mode | Authorization behavior |
| --- | --- |
| Business-user access | Service exposure and applicable CDS access controls are evaluated for the SAP business identity. |
| Privileged access | Service/entity authorization remains; CDS DCL conditions are bypassed. |

[SAP SQL-service access scenarios](https://help.sap.com/docs/ABAP_PLATFORM_NEW/d28ccbeac239408eb37cd06d3de41ef6/3b914502fc3a42038addbd138821fb2f.html).

The recorded Node.js/Rust lab uses **privileged access**, a SELECT-only binding
and the `S_START` / `S_SQL_VIEW` checks recorded in [CDS setup](cds-odbc.md).
The synthetic CDS entities have no row-level business authorization policy.
Consequently this benchmark does not demonstrate business-user row filtering,
nor a performance difference attributable to evaluating such a policy.

For the comparison, record the identity, exposed entities/operations and policy
of each path. HANA grants, SQL-service privileges and HTTP permissions are
different policies. A matching data digest is not an authorization test.
An external API using one SAP identity would be authorized as that identity;
end-user propagation would need its own explicitly evaluated design.

## Governance comparison

The following are design judgments for a governed landscape, not conclusions
inferred solely from timing measurements.

| Architecture | Contract and change ownership | Operational / authorization responsibility | Sensible use |
| --- | --- | --- | --- |
| SAP HTTP API over CDS | SAP service owner controls a versioned business/data contract; consumers avoid physical schema coupling. | Service authentication, row/operation policy, gateway limits and monitoring; external team owns client/app security. Network and JSON costs remain. | Broad integration and side-by-side services, especially where a suitable released API already exists. |
| Internal ABAP CDS | SAP team owns the local CDS contract, package/transport dependencies and upgrade checks. | SAP work-process capacity and appropriate CDS authorization. Local code can still create unsupported dependencies. | Logic requiring close SAP integration or local data processing within the applicable extension model. |
| CDS SQL service / ODBC | SAP owner approves exposed entities/operations; Rust/Node.js consumers retain a SAP-governed SQL contract rather than a direct HANA login. | SAP identity and service/entity authorization, the chosen CDS row-policy mode, query governance, TLS, driver packaging/patching and connection limits. | Controlled tabular integration where SQL is an intentional interface; performance benefits can coexist with SAP-side governance. |
| Direct native HANA | Database/view owners and application owners share a tighter database-level contract. Physical and generated SAP schema details create upgrade exposure. | Restricted database identities, client filtering, database auditing, schema migration and application-owned business authorization. | An approved custom-data/analytics boundary when deployment, access rights and support policy permit it; a useful lab control. |

Clean core depends on **released contracts and the applicable extensibility
model**, not on the language name or whether a process is off-stack. Both
on-stack and side-by-side extensions can use governed released interfaces.
Moving logic to Rust or Node.js while binding it to unreleased tables does not
establish clean-core compliance.
[SAP clean-core extensibility guidance](https://learning.sap.com/courses/practicing-clean-core-extensibility-for-sap-s-4hana-cloud/explaining-extensibility-model-best-practices_e290f382-800e-40ef-a203-85a13115f487).

## Maintainability evidence

Maintenance is assessed from concrete dependencies and change boundaries.
No developer-hour, staffing, build-time or long-term maintenance ranking was
measured. A team already proficient in Rust can reach a different maintenance
judgment from a team whose experience is concentrated in ABAP or Node.js.

| Concern | Observed boundary | Interpretation / evidence limit |
| --- | --- | --- |
| Interface changes | HTTP consumers use the OData contract; CDS SQL consumers use exposed entity/column contracts; native clients use the custom HANA view. | Versioning and compatibility depend on the owned contract. HTTP is not automatically stable, and a deliberate custom SQL view can provide a maintained boundary. |
| SAP model changes | Tables, CDS and service bindings use SAP activation/lifecycle steps; client queries and validators live outside SAP. | A field added to the canonical result can affect model exposure, queries, validation and shared fixtures. This is a dependency assessment, not a timed change exercise. |
| Driver provisioning | Both Node.js and Rust CDS load unixODBC and the same separately supplied SAP driver/TLS libraries. | Driver acquisition, compatibility and patching are shared obligations; they are not a Rust-specific loss of governance. |
| Runtime dependencies | Rust has a compiled, pinned build; Node.js has locked packages and a native ODBC binding; ABAP code depends on the target SAP release. | Different update paths need maintainers. Team learning effort and comparative development speed remain unmeasured. |
| Diagnosis and reproduction | Shared fixtures, offline/live checks, source attribution and mounted-driver/query verification are available. | These help reproduce a failure and identify inputs. They do not establish long-term support effort or successful installation on an independent SAP system. |

An optional change-impact walkthrough can trace adding a canonical business
field or updating a driver through the affected artifacts and owners. It is
not a completed experiment and is not required to turn this lab into a service.

Database saturation is **not an established bottleneck** in this study. Scan
time can include SAP service work, serialization/pagination, transport, driver
fetching/conversion and client validation/hashing. The measurements compare
their combined effect; attributing a difference to a specific layer needs
profiling. Resource usage is supporting evidence, not an assumed explanation
or an automatic drawback of Rust.

## Should Node.js or Rust expose a REST API backed by CDS?

This section is an architectural extrapolation, not an implemented path or an
acceptance criterion for the performance/governance study.

**Sometimes, when that extra service has a clear product responsibility.**
It can compose several systems, provide a task-specific API, hide an approved
SQL model behind a stable external contract, apply caching/rate limits, or
place non-SAP processing in an independently deployed service. Node.js/CAP is
a natural option when the BTP team already uses SAP's service ecosystem.
Rust is a reasonable option when measured CPU/memory requirements and team
skills justify its integration and maintenance costs.

Possible paths are:

```text
Consumer → Node.js / Rust API → SAP OData API → CDS
Consumer → Node.js / Rust API → ABAP SQL service through ODBC → CDS
```

The first reuses SAP's HTTP contract. The second intentionally adopts the
SQL-service contract and its driver/authorization obligations. Neither façade
is implemented or benchmarked by this project; the applications are **polling
consumers**, not API servers. Do not present their scan timings as façade
request latencies.

ABAP CDS and CAP's CDS modeling language also have different runtime contexts.
Using CAP in Node.js does not automatically make an ABAP CDS entity a local
CAP database model. An explicit remote-service or ODBC integration is still
needed, with a deliberately owned contract.

If the requirement is simply “expose these CDS rows as an API,” the existing
SAP OData binding already provides that boundary with fewer deployed components.
A second server then adds a network hop, serialization, credentials, deployment,
monitoring and an additional owner. A faster SQL polling result does not prove
that an ODBC-backed public API will be faster or cheaper end to end.

Before adopting a façade, define its supported query surface and versioned
response model, bind SQL parameters rather than forwarding arbitrary SQL,
bound pools/timeouts and result sizes, implement authorization/tenant policy,
propagate correlation IDs, and test failure/cancellation behavior. Give writes
a separate business API/transaction design; this read-only full-scan study
does not justify bypassing business validations through database writes.

## Placement, operations and testability

The deployment examples use local kind Jobs, but the performance experiment
uses sequential Docker containers with one CPU and 256 MiB each. ABAP remains
inside the shared SAP/HANA container; it cannot receive an equivalent isolated
per-application cap. SQL clients keep a connection across scans; HTTP benchmarks
create a fresh client per scan and reuse its connection within that scan.
Data conversion, drivers, identities and placement therefore remain part of
the measured access path.

All three measured HTTP clients use the same literal local
`http://host.docker.internal/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/`
route. This benchmark route is plain HTTP on the local lab network; it differs
from the host HTTPS setup/control URL. ODBC verifies TLS on its HTTPS/WebSocket
route, while native HANA uses the private database TCP route. Encryption costs
are therefore not held equal across the three approaches. Production should
use appropriately verified secure transport and be measured in that topology.

A local container is not proof of SAP BTP deployment. BTP Cloud Foundry/Kyma
adds platform identity, connectivity, secret rotation, health checks, quotas,
observability and operational ownership. Kyma can deploy containerized
applications, but customers remain responsible for their workload images and
dependencies, including native libraries.
[SAP Kyma deployment model](https://developers.sap.com/tutorials/deploy-to-kyma),
[BTP operating responsibilities](https://help.sap.com/docs/btp/sap-business-technology-platform/operating-model?locale=en-us&source=redirect).

Before choosing a BTP topology, confirm that the target SAP product supports
the intended SQL service, client driver and connectivity route, and that the
applicable usage terms permit the deployment. The local trial demonstrates
these interfaces on this target; it establishes no general entitlement or
support statement for another SAP landscape.

Shared fixtures and live hashes test functional equivalence. They do not test
production business authorization, general currency/unit conversion, concurrent
writes or transactional consistency across a long paginated scan. The frozen
CHF/EA fixture intentionally keeps those concerns outside this experiment.
The [contract](implementation-contract.md) and [protocol](nine-benchmark-protocol.md)
state the precise boundary. The [conclusions](conclusions.md) combine the
measured results with the governance considerations above.
