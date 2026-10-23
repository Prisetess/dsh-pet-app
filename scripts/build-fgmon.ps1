# Build the foreground-window monitor used by the "hide when fullscreen" feature.
# Output: build\fgmon.exe (ASCII-only script, Windows PowerShell 5.1 safe)

param(
  [string]$Out = (Join-Path $PSScriptRoot '..\build\fgmon.exe')
)

$ErrorActionPreference = 'Stop'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot 'fgmon\ForegroundMonitor.cs'
$outFile = [System.IO.Path]::GetFullPath($Out)

if (-not (Test-Path -LiteralPath $csc)) { Write-Error "csc.exe not found: $csc"; exit 1 }
New-Item -ItemType Directory -Force -Path (Split-Path $outFile) | Out-Null

& $csc /nologo /target:winexe /platform:anycpu /optimize+ "/out:$outFile" $source
if ($LASTEXITCODE -ne 0) { Write-Error "fgmon compile failed: $LASTEXITCODE"; exit 1 }

Write-Host ("[fgmon] built: {0:N0} bytes -> {1}" -f (Get-Item -LiteralPath $outFile).Length, $outFile)
