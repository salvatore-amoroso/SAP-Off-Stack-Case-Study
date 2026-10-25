# Local Kubernetes deployment

The SAP trial remains in its existing Docker installation. Kubernetes runs the Node.js and Rust polling clients in a dedicated `sap-polling-lab` kind cluster and namespace. ABAP runs inside SAP and consumes the same HTTP service. Start with the [installation guide](../docs/requirements-install-run.md) to build the four supported images and create the runtime image aliases used below. The [SQL deployment](sql/README.md) adds the CDS and native HANA Jobs.

`base/` defines two suspended, finite Jobs. Both use one scan, one worker, zero retries, identical settings, a 1 CPU limit and 256 MiB memory limit. Run them sequentially so they consume the same frozen SAP dataset without competing for the service. JSON results are written to pod logs. Poller metrics measure elapsed client work; Kubernetes CPU/memory limits do not make the internal ABAP runtime's resource allocation equivalent.

`local/` selects the existing trial at `https://host.docker.internal/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/` and explicitly permits its self-signed certificate in each poller's own HTTP client. `base/` verifies TLS and uses a placeholder service host. Credentials are referenced from a runtime Secret and excluded from Kustomize.

## Prepare the isolated cluster

From the project root in PowerShell, use the official checksum-verified kind executable in `work/bin`. On a fresh checkout, download and verify it first:

```powershell
New-Item -ItemType Directory -Path work\bin -Force | Out-Null
Invoke-WebRequest https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-windows-amd64 -OutFile work\bin\kind.exe
Invoke-WebRequest https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-windows-amd64.sha256sum -OutFile work\bin\kind.exe.sha256sum
$kindExpected = ((Get-Content work\bin\kind.exe.sha256sum -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash work\bin\kind.exe -Algorithm SHA256).Hash -ine $kindExpected) { throw 'kind checksum mismatch' }
```

The recorded kind executable SHA-256 is `4b22adaa135368c5a465d56bbd8e520cbea87272a06ca00b6078e7b81515c9fc`. The Kubernetes node image is pinned by digest in `kind.yaml`. Use a kubectl client within one minor version of the pinned Kubernetes 1.37 node.

```powershell
.\work\bin\kind.exe create cluster --name sap-polling-lab --config deploy\kind.yaml --kubeconfig work\kind-kubeconfig.yaml --wait 120s
docker update --memory 2g --memory-swap 2g --cpus 2 sap-polling-lab-control-plane
.\work\bin\kind.exe load docker-image sap-polling-node:local sap-polling-rust:local --name sap-polling-lab
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab apply -k deploy\local
```

Use a separate kubeconfig to preserve the user's current context. All commands below explicitly select the lab context and namespace. The local client binaries and kubeconfig remain under ignored `work/`; no PATH or Docker Desktop setting changes are needed.

Load `SAP_USERNAME` and `SAP_PASSWORD` into this process's environment from the existing local SAP configuration, then apply the Secret through stdin:

```powershell
.\deploy\Set-SapSecret.ps1
```

The helper does not write a credential file or put credential values into command-line arguments. `secret.example.yaml` contains placeholders and is excluded from deployment.

## Run and collect results

The shared patch file avoids native argument quoting differences between Windows
PowerShell 5.1 and PowerShell 7. Run these commands from the repository root.

```powershell
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab patch job poller-node --type=merge --patch-file=deploy/unsuspend-job.json
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab wait --for=condition=complete job/poller-node --timeout=180s
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab logs job/poller-node
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab patch job poller-rust --type=merge --patch-file=deploy/unsuspend-job.json
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab wait --for=condition=complete job/poller-rust --timeout=180s
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab logs job/poller-rust
```

Each result must match the [seed manifest](../contracts/seed-manifest.json): 5000 positions and digest `df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7`. For cross-language parity, run the nine-path smoke in the [run guide](../docs/requirements-install-run.md#7-run-the-full-nine-application-benchmark). A successful Job checks this deployment; the [performance study](../docs/nine-comparison.md) uses sequential Docker clients under its separate controlled protocol.

For another run, explicitly delete only these completed lab Jobs and reapply the local overlay. Rebuild and reload the images after code changes.

```powershell
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab delete job poller-node poller-rust
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab apply -k deploy\local
```

If a Job fails, inspect its pod logs and `describe job` in the same explicit context/namespace. An unreachable host address requires checking the existing trial port forwarding and local network route; the cluster setup does not recreate or reconfigure SAP.

To remove this lab cluster after collecting logs, use `kind delete cluster --name sap-polling-lab --kubeconfig work\kind-kubeconfig.yaml`. This removes only the named kind cluster.

Sources: [kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/), [kind v0.33.0 release and pinned node image](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0), [kubectl version compatibility and Windows setup](https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/).
