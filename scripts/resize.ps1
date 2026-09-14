param(
  [Parameter(Mandatory)] [string]$Source,
  [Parameter(Mandatory)] [string]$Destination,
  [Parameter(Mandatory)] [int]$Width,
  [Parameter(Mandatory)] [int]$Height
)
# Center-crop Source to the Width:Height ratio, resize to exactly Width x Height, save as PNG.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile($Source)
try {
  $targetRatio = $Width / $Height
  $srcRatio = $src.Width / $src.Height
  if ($srcRatio -gt $targetRatio) {
    $cropH = $src.Height
    $cropW = [int][Math]::Round($src.Height * $targetRatio)
  } else {
    $cropW = $src.Width
    $cropH = [int][Math]::Round($src.Width / $targetRatio)
  }
  $cropX = [int][Math]::Floor(($src.Width - $cropW) / 2)
  $cropY = [int][Math]::Floor(($src.Height - $cropH) / 2)

  $bmp = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $attrs = New-Object System.Drawing.Imaging.ImageAttributes
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    # Prevents a faint dark fringe along the edges when downscaling.
    $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $destRect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
    $g.DrawImage($src, $destRect, $cropX, $cropY, $cropW, $cropH, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    $bmp.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $attrs.Dispose(); $g.Dispose(); $bmp.Dispose()
  }
  Write-Output "source=$($src.Width)x$($src.Height) crop=${cropW}x${cropH}+${cropX}+${cropY} output=${Width}x${Height}"
} finally {
  $src.Dispose()
}
