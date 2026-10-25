# Local Kubernetes deployment

The SAP trial remains in its existing Docker installation. Kubernetes runs the Node.js and Rust polling clients in a dedicated `sap-polling-lab` kind cluster and namespace. ABAP runs inside SAP and consumes the same HTTP service.

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

This implementation verified SHA-256 `4b22adaa135368c5a465d56bbd8e520cbea87272a06ca00b6078e7b81515c9fc`. The installed cluster's release and checksum are recorded in `work/kind-setup.json`. The Kubernetes node image is pinned by digest in `kind.yaml`. Use a kubectl client within one minor version of Kubernetes 1.37; the existing Docker Desktop client is 1.36.1.

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

```powershell
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab patch job poller-node --type merge -p '{"spec":{"suspend":false}}'
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab wait --for=condition=complete job/poller-node --timeout=180s
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab logs job/poller-node
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab patch job poller-rust --type merge -p '{"spec":{"suspend":false}}'
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab wait --for=condition=complete job/poller-rust --timeout=180s
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab logs job/poller-rust
```

Each result must match `contracts/seed-manifest.json`: 5000 positions and digest `df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7`. Compare functional fields with the ABAP result using the shared parity scripts. One successful scan establishes deployment correctness; benchmark conclusions require the longer controlled runs described in the design.

For another run, explicitly delete only these completed lab Jobs and reapply the local overlay. Rebuild and reload the images after code changes.

```powershell
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab delete job poller-node poller-rust
kubectl --kubeconfig work\kind-kubeconfig.yaml --context kind-sap-polling-lab --namespace sap-polling-lab apply -k deploy\local
```

If a Job fails, inspect its pod logs and `describe job` in the same explicit context/namespace. An unreachable host address requires checking the existing trial port forwarding and local network route; the cluster setup does not recreate or reconfigure SAP.

To remove this lab cluster after collecting logs, use `kind delete cluster --name sap-polling-lab --kubeconfig work\kind-kubeconfig.yaml`. This removes only the named kind cluster.

Sources: [kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/), [kind v0.33.0 release and pinned node image](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0), [kubectl version compatibility and Windows setup](https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/).
