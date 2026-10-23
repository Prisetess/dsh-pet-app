# Sign the portable exe with a locally-trusted self-signed code signing certificate.
#
# Why: SmartScreen blocks unsigned exes from an "unknown publisher". This creates a
# self-signed code-signing cert, imports it into CurrentUser\Root + TrustedPublisher,
# and signs the exe so the publisher shows up as a real name instead of "unknown".
#
# Offline: no CA, no timestamp server, no network.
# Scope: local machine / current user only. Other machines will still warn --
# public distribution needs an EV code signing certificate.
#
# Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\sign-portable.ps1 [-Exe <path>]

param(
  [string]$Exe = (Join-Path $PSScriptRoot '..\dist\DSH Pet\DSH Pet.exe'),
  [string]$Subject = 'CN=DSH Pet (local build), O=DSH Pet, C=CN'
)

$ErrorActionPreference = 'Stop'
Import-Module PKI -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $Exe)) {
  Write-Error "exe not found: $Exe (run 'npm run package' first)"
  exit 1
}

Write-Host "[sign] target: $Exe"

# Reuse an existing cert so repeated packaging runs do not pile up certificates.
$cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $cert) {
  Write-Host '[sign] creating self-signed code signing certificate...'
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyUsage DigitalSignature `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(5) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
} else {
  Write-Host "[sign] reusing certificate: $($cert.Thumbprint)"
}

# The cert must be in Root AND TrustedPublisher, otherwise chain building fails
# and SmartScreen still refuses to trust the signature.
$cerPath = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-pet-codesign-$($cert.Thumbprint).cer"
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null

foreach ($store in @('Cert:\CurrentUser\Root', 'Cert:\CurrentUser\TrustedPublisher')) {
  $exists = Get-ChildItem $store | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
  if (-not $exists) {
    Import-Certificate -FilePath $cerPath -CertStoreLocation $store | Out-Null
    Write-Host "[sign] imported into $store"
  }
}

Write-Host '[sign] signing (a 215 MB exe takes a while)...'
$sig = Set-AuthenticodeSignature -FilePath $Exe -Certificate $cert -HashAlgorithm SHA256
if ($sig.Status -ne 'Valid') {
  Write-Error "sign failed: $($sig.Status) / $($sig.StatusMessage)"
  exit 1
}

$verify = Get-AuthenticodeSignature -LiteralPath $Exe
Write-Host ''
Write-Host '[sign] done'
Write-Host "  status  $($verify.Status)"
Write-Host "  subject $($verify.SignerCertificate.Subject)"
Write-Host "  sha1    $($verify.SignerCertificate.Thumbprint)"
Write-Host ''
Write-Host 'If SmartScreen still blocks: click "More info" -> "Run anyway",'
Write-Host 'or use "启动-备用.bat" in the same folder (launches the original electron.exe).'
