# Long-running capture helper. Reads one JSON request per line on stdin and
# writes one JSON response per line on stdout.
#   capture: grab a process window with PrintWindow (works when occluded),
#            optionally locate a solid-color region, crop, scale and save.
#   sheet:   compose saved images into a labeled contact sheet.
#   annotate: draw polylines, dots and text over a saved image.

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MoonCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    // Bounding box of pixels matching a color in a 32bpp BGRA buffer, or null.
    public static int[] FindColorBounds(IntPtr scan0, int stride, int width, int height, int r, int g, int b, int tolerance) {
        byte[] px = new byte[stride * height];
        Marshal.Copy(scan0, px, 0, px.Length);
        int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
        for (int y = 0; y < height; y++) {
            int row = y * stride;
            for (int x = 0; x < width; x++) {
                int i = row + x * 4;
                if (Math.Abs(px[i] - b) <= tolerance && Math.Abs(px[i + 1] - g) <= tolerance && Math.Abs(px[i + 2] - r) <= tolerance) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        return new int[] { minX, minY, maxX - minX + 1, maxY - minY + 1 };
    }

    // True when every pixel has the same color, i.e. the window content was not rendered.
    public static bool IsFlat(IntPtr scan0, int stride, int width, int height) {
        byte[] px = new byte[stride * height];
        Marshal.Copy(scan0, px, 0, px.Length);
        for (int y = 0; y < height; y++) {
            int row = y * stride;
            for (int x = 0; x < width; x++) {
                int i = row + x * 4;
                if (px[i] != px[0] || px[i + 1] != px[1] || px[i + 2] != px[2]) return false;
            }
        }
        return true;
    }
}
"@

[void][MoonCapture]::SetProcessDPIAware()

function New-Failure([string]$kind, [string]$message, $extra = @{}) {
    return @{ ok = $false; kind = $kind; error = $message } + $extra
}

function Save-Image($image, [string]$path, [int]$quality) {
    $full = [System.IO.Path]::GetFullPath($path)
    if ($full -match '\.jpe?g$') {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
        $params = New-Object System.Drawing.Imaging.EncoderParameters 1
        $params.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
        $image.Save($full, $codec, $params)
    } else {
        $image.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    return $full
}

function Invoke-Capture($req) {
    $processName = if ($req.process) { $req.process } else { "RobloxStudioBeta" }
    $quality = if ($req.jpegQuality) { [int]$req.jpegQuality } else { 88 }

    $process = Get-Process -Name $processName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
    if (-not $process) { return New-Failure "no_window" "no window found for process '$processName'" }
    $hwnd = $process.MainWindowHandle

    $restored = $false
    if ([MoonCapture]::IsIconic($hwnd)) {
        if (-not $req.restoreIfMinimized) { return New-Failure "minimized" "window is minimized; restore it before capturing" }
        # 4 = SW_SHOWNOACTIVATE: bring the window back without taking keyboard focus.
        [void][MoonCapture]::ShowWindow($hwnd, 4)
        $deadline = [DateTime]::UtcNow.AddSeconds(3)
        while ([MoonCapture]::IsIconic($hwnd) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
        if ([MoonCapture]::IsIconic($hwnd)) { return New-Failure "minimized" "window is minimized and could not be restored" }
        # Give the 3D viewport time to redraw at its restored size.
        Start-Sleep -Milliseconds 700
        $restored = $true
    }

    $rect = New-Object MoonCapture+RECT
    [void][MoonCapture]::GetWindowRect($hwnd, [ref]$rect)
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { return New-Failure "no_area" "window has no visible area" }

    $window = @{ windowWidth = $width; windowHeight = $height }
    if ($req.expectWindow -and $req.expectWindow -ne "${width}x${height}") {
        return New-Failure "window_changed" "window size is ${width}x${height}, expected $($req.expectWindow)" $window
    }

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $hdc = $graphics.GetHdc()
        # 2 = PW_RENDERFULLCONTENT, required for GPU-composited windows.
        $printed = [MoonCapture]::PrintWindow($hwnd, $hdc, 2)
        $graphics.ReleaseHdc($hdc)
        $graphics.Dispose()
        if (-not $printed) { return New-Failure "print_failed" "PrintWindow failed" $window }

        $full = New-Object System.Drawing.Rectangle 0, 0, $width, $height
        $data = $bitmap.LockBits($full, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $isBlank = [MoonCapture]::IsFlat($data.Scan0, $data.Stride, $width, $height)
            $bounds = $null
            if ($req.findColor) {
                $bounds = [MoonCapture]::FindColorBounds($data.Scan0, $data.Stride, $width, $height, [int]$req.findColor[0], [int]$req.findColor[1], [int]$req.findColor[2], 12)
            }
        } finally {
            $bitmap.UnlockBits($data)
        }

        if ($isBlank) { return New-Failure "blank" "capture is a single flat color; window content was not rendered" $window }

        $result = @{ ok = $true; title = $process.MainWindowTitle; restored = $restored } + $window
        if ($req.findColor) {
            if ($null -eq $bounds) { return New-Failure "color_not_found" "no pixels matching the marker color" $window }
            $result.bounds = @{ x = $bounds[0]; y = $bounds[1]; width = $bounds[2]; height = $bounds[3] }
        }

        if ($req.outFile) {
            $image = $bitmap
            if ($req.crop) {
                $c = $req.crop
                if ($c.x -lt 0 -or $c.y -lt 0 -or $c.width -le 0 -or $c.height -le 0 -or ($c.x + $c.width) -gt $width -or ($c.y + $c.height) -gt $height) {
                    return New-Failure "bad_crop" "crop is outside the ${width}x${height} window" $window
                }
                $cropRect = New-Object System.Drawing.Rectangle ([int]$c.x), ([int]$c.y), ([int]$c.width), ([int]$c.height)
                $image = $bitmap.Clone($cropRect, $bitmap.PixelFormat)
            }
            if ($req.maxWidth -and $image.Width -gt $req.maxWidth) {
                $newWidth = [int]$req.maxWidth
                $newHeight = [int][Math]::Round($image.Height * $newWidth / $image.Width)
                $scaled = New-Object System.Drawing.Bitmap $newWidth, $newHeight
                $g = [System.Drawing.Graphics]::FromImage($scaled)
                $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g.DrawImage($image, 0, 0, $newWidth, $newHeight)
                $g.Dispose()
                if ($image -ne $bitmap) { $image.Dispose() }
                $image = $scaled
            }
            $result.file = Save-Image $image $req.outFile $quality
            $result.width = $image.Width
            $result.height = $image.Height
            if ($image -ne $bitmap) { $image.Dispose() }
        }
        return $result
    } finally {
        $bitmap.Dispose()
    }
}

function Invoke-Sheet($req) {
    $columns = [Math]::Max(1, [int]$req.columns)
    $padding = 6
    $labelHeight = 22
    $images = @()
    try {
        foreach ($cell in $req.cells) { $images += [System.Drawing.Image]::FromFile($cell.file) }
        $cellWidth = [int]($images | Measure-Object -Property Width -Maximum).Maximum
        $cellHeight = [int]($images | Measure-Object -Property Height -Maximum).Maximum
        $rows = [int][Math]::Ceiling($images.Count / $columns)
        $sheetWidth = $columns * $cellWidth + ($columns + 1) * $padding
        $sheetHeight = $rows * ($cellHeight + $labelHeight) + ($rows + 1) * $padding

        $sheet = New-Object System.Drawing.Bitmap $sheetWidth, $sheetHeight
        $g = [System.Drawing.Graphics]::FromImage($sheet)
        $g.Clear([System.Drawing.Color]::FromArgb(24, 24, 28))
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
        $font = New-Object System.Drawing.Font "Segoe UI", 10
        $brush = [System.Drawing.Brushes]::White
        $format = New-Object System.Drawing.StringFormat
        $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
        $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
        for ($i = 0; $i -lt $images.Count; $i++) {
            $x = $padding + ($i % $columns) * ($cellWidth + $padding)
            $y = $padding + [int][Math]::Floor($i / $columns) * ($cellHeight + $labelHeight + $padding)
            $g.DrawImage($images[$i], $x, $y + $labelHeight, $images[$i].Width, $images[$i].Height)
            $labelRect = New-Object System.Drawing.RectangleF $x, ($y + 2), $cellWidth, $labelHeight
            $g.DrawString([string]$req.cells[$i].label, $font, $brush, $labelRect, $format)
        }
        $font.Dispose()
        $g.Dispose()
        $quality = if ($req.jpegQuality) { [int]$req.jpegQuality } else { 88 }
        $file = Save-Image $sheet $req.outFile $quality
        $sheet.Dispose()
        return @{ ok = $true; file = $file; width = $sheetWidth; height = $sheetHeight; columns = $columns; rows = $rows }
    } finally {
        foreach ($image in $images) { $image.Dispose() }
    }
}

function Invoke-Annotate($req) {
    # Load through a copy so the source file is not locked while saving over it.
    $loaded = [System.Drawing.Image]::FromFile($req.file)
    $image = New-Object System.Drawing.Bitmap $loaded
    $loaded.Dispose()
    try {
        $g = [System.Drawing.Graphics]::FromImage($image)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
        $font = New-Object System.Drawing.Font "Segoe UI", 9, ([System.Drawing.FontStyle]::Bold)
        $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 0, 0, 0))
        foreach ($shape in $req.shapes) {
            $color = [System.Drawing.Color]::FromArgb(255, [int]$shape.color[0], [int]$shape.color[1], [int]$shape.color[2])
            if ($shape.type -eq "polyline") {
                if ($shape.points.Count -ge 2) {
                    $pen = New-Object System.Drawing.Pen $color, ([single]$shape.width)
                    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
                    $points = foreach ($p in $shape.points) { New-Object System.Drawing.PointF ([single]$p[0]), ([single]$p[1]) }
                    $g.DrawLines($pen, [System.Drawing.PointF[]]$points)
                    $pen.Dispose()
                }
            } elseif ($shape.type -eq "dot") {
                $r = [single]$shape.radius
                $brush = New-Object System.Drawing.SolidBrush $color
                $g.FillEllipse($shadow, ([single]$shape.x - $r - 1), ([single]$shape.y - $r - 1), (2 * $r + 2), (2 * $r + 2))
                $g.FillEllipse($brush, ([single]$shape.x - $r), ([single]$shape.y - $r), (2 * $r), (2 * $r))
                $brush.Dispose()
            } elseif ($shape.type -eq "text") {
                $brush = New-Object System.Drawing.SolidBrush $color
                $g.DrawString([string]$shape.text, $font, $shadow, ([single]$shape.x + 1), ([single]$shape.y + 1))
                $g.DrawString([string]$shape.text, $font, $brush, [single]$shape.x, [single]$shape.y)
                $brush.Dispose()
            }
        }
        $shadow.Dispose()
        $font.Dispose()
        $g.Dispose()
        $quality = if ($req.jpegQuality) { [int]$req.jpegQuality } else { 90 }
        $file = Save-Image $image $req.file $quality
        return @{ ok = $true; file = $file; width = $image.Width; height = $image.Height }
    } finally {
        $image.Dispose()
    }
}

[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $response = switch ($req.cmd) {
            "capture" { Invoke-Capture $req }
            "sheet" { Invoke-Sheet $req }
            "annotate" { Invoke-Annotate $req }
            default { New-Failure "bad_request" "unknown command '$($req.cmd)'" }
        }
    } catch {
        $response = New-Failure "exception" $_.Exception.Message
    }
    $response.id = $id
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
}
