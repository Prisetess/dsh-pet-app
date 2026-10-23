# Put the local self-signed code-signing certificate into the MACHINE stores.
#
# Why: UAC and Defender read LocalMachine\Root + LocalMachine\TrustedPublisher, not the per-user
# stores. With the cert only under CurrentUser, the elevation prompt says "未知发布者 / Unknown
# publisher" even though the signature verifies -- which looks like the installer was blocked.
#
# Run it once (it will ask for UAC). ASCII-only (Windows PowerShell 5.1 reads .ps1 in the OEM codepage).

param(
  [string]$Thumbprint = '3F623DC427376D0A2ADEB6908ACC826787C9D932',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host '[cert] not elevated - asking for UAC...'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Thumbprint', $Thumbprint)
  if ($Remove) { $arguments += '-Remove' }
  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait
    exit 0
  } catch {
    Write-Host '[cert] elevation cancelled - nothing changed.'
    exit 1
  }
}

$stores = @('Cert:\LocalMachine\Root', 'Cert:\LocalMachine\TrustedPublisher')

if ($Remove) {
  foreach ($store in $stores) {
    Get-ChildItem $store | Where-Object { $_.Thumbprint -eq $Thumbprint } | ForEach-Object {
      Remove-Item -LiteralPath $_.PSPath -Force
      Write-Host "[cert] removed from $store"
    }
  }
  exit 0
}

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
if (-not $cert) {
  Write-Host "[cert] certificate $Thumbprint not found in CurrentUser\My - build/sign the installer first."
  exit 1
}

$temp = Join-Path $env:TEMP ("dsh-pet-signer-" + [Guid]::NewGuid().ToString('N') + '.cer')
[System.IO.File]::WriteAllBytes($temp, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
try {
  foreach ($store in $stores) {
    Import-Certificate -FilePath $temp -CertStoreLocation $store | Out-Null
    Write-Host "[cert] imported into $store"
  }
} finally {
  Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Now the UAC prompt should show the publisher as "DSH Pet" instead of unknown.'
Write-Host 'SmartScreen still uses cloud reputation, so a freshly built unsigned-by-a-CA binary'
Write-Host 'can still warn on other machines until it has an EV certificate.'
