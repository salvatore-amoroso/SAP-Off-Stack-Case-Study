param(
    [string]$Kubeconfig = (Join-Path $PSScriptRoot '..\work\kind-kubeconfig.yaml')
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrEmpty($env:SAP_USERNAME) -or [string]::IsNullOrEmpty($env:SAP_PASSWORD)) {
    throw 'Set SAP_USERNAME and SAP_PASSWORD in the process environment before creating the runtime Secret.'
}
$kubectl = (Get-Command kubectl.exe -ErrorAction Stop).Source
$runtimeSecret = @{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = @{ name = 'sap-credentials'; namespace = 'sap-polling-lab' }
    type = 'Opaque'
    data = @{
        SAP_USERNAME = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($env:SAP_USERNAME))
        SAP_PASSWORD = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($env:SAP_PASSWORD))
    }
}
$runtimeSecret | ConvertTo-Json -Depth 4 -Compress |
    & $kubectl --kubeconfig $Kubeconfig --context kind-sap-polling-lab --namespace sap-polling-lab apply --server-side -f -
if ($LASTEXITCODE -ne 0) { throw 'The runtime SAP Secret could not be applied.' }
