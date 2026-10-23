# Build a multi-resolution .ico from a source PNG (shortcuts, setup exe, tray, taskbar).
#
# Why hand-rolled DIBs: GDI+'s Icon.Save / GetHicon round-trip mangles colours (it writes the AND
# mask over the colour data and can premultiply alpha), which shows up as a grey/dithered icon in
# the tray. So each entry here is a plain 32bpp BITMAPINFOHEADER + bottom-up BGRA + zeroed AND
# mask, written with explicit [byte[]] casts (BinaryWriter.Write(object) silently corrupts them).
#
# ASCII-only file (Windows PowerShell 5.1 reads .ps1 with the OEM codepage).

param(
  [string]$Source = (Join-Path $PSScriptRoot '..\ui\guide.png'),
  [string]$Out = (Join-Path $PSScriptRoot '..\build\app.ico'),
  [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourcePath = [System.IO.Path]::GetFullPath($Source)
$outPath = [System.IO.Path]::GetFullPath($Out)
if (-not (Test-Path -LiteralPath $sourcePath)) { Write-Error "source image not found: $sourcePath"; exit 1 }
New-Item -ItemType Directory -Force -Path (Split-Path $outPath) | Out-Null

function Get-DibPayload([System.Drawing.Image]$image, [int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawImage($image, 0, 0, $size, $size)
  $graphics.Dispose()

  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $locked = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $locked.Stride
  $pixels = New-Object byte[] ($stride * $size)
  [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pixels, 0, $pixels.Length)
  $bitmap.UnlockBits($locked)
  $bitmap.Dispose()

  $rowBytes = $size * 4
  $maskRow = [int]([Math]::Floor(($size + 31) / 32) * 4)
  $maskBytes = $maskRow * $size
  $payload = New-Object byte[] (40 + $rowBytes * $size + $maskBytes)

  # BITMAPINFOHEADER
  [Array]::Copy([BitConverter]::GetBytes([int]40), 0, $payload, 0, 4)                 # biSize
  [Array]::Copy([BitConverter]::GetBytes([int]$size), 0, $payload, 4, 4)              # biWidth
  [Array]::Copy([BitConverter]::GetBytes([int]($size * 2)), 0, $payload, 8, 4)        # biHeight (image + mask)
  [Array]::Copy([BitConverter]::GetBytes([int16]1), 0, $payload, 12, 2)               # biPlanes
  [Array]::Copy([BitConverter]::GetBytes([int16]32), 0, $payload, 14, 2)              # biBitCount
  [Array]::Copy([BitConverter]::GetBytes([int]($rowBytes * $size)), 0, $payload, 20, 4) # biSizeImage

  # Rows are bottom-up; AND mask (all zero = opaque) is already allocated as zeros.
  $destination = 40
  for ($y = $size - 1; $y -ge 0; $y--) {
    [Array]::Copy($pixels, ($y * $stride), $payload, $destination, $rowBytes)
    $destination += $rowBytes
  }
  return ,$payload
}

$chunks = @()
$srcImage = [System.Drawing.Image]::FromFile($sourcePath)
try {
  foreach ($size in $Sizes) {
    $chunks += ,@([int]$size, (Get-DibPayload $srcImage $size))
  }
} finally {
  $srcImage.Dispose()
}

$stream = [System.IO.File]::Create($outPath)
$writer = New-Object System.IO.BinaryWriter($stream)
try {
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$chunks.Count)

  $offset = 6 + (16 * $chunks.Count)
  foreach ($chunk in $chunks) {
    $size = [int]$chunk[0]
    $payload = [byte[]]$chunk[1]
    $dim = if ($size -ge 256) { [byte]0 } else { [byte]$size }
    $writer.Write([byte]$dim)
    $writer.Write([byte]$dim)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$payload.Length)
    $writer.Write([UInt32]$offset)
    $offset += $payload.Length
  }
  foreach ($chunk in $chunks) {
    $writer.Write([byte[]]$chunk[1])
  }
} finally {
  $writer.Close()
}

# Verification: decode at 64 and make sure a known pixel keeps its colour.
$check = New-Object System.Drawing.Icon($outPath, 64, 64)
$probe = $check.ToBitmap()
$pixel = $probe.GetPixel(32, 19)
$alpha = $probe.GetPixel(0, 0).A
$probe.Dispose()
$check.Dispose()

$info = Get-Item -LiteralPath $outPath
Write-Host ("[icon] {0} entries -> {1} ({2:N0} bytes)  pixel(32,19)={3}  alpha(0,0)={4}" -f $chunks.Count, $outPath, $info.Length, $pixel, $alpha)
if ($pixel.R -eq 128 -and $pixel.G -eq 128 -and $pixel.B -eq 128) {
  Write-Error "icon colours look wrong (grey pixel) -- not shipping this file"
  exit 1
}
