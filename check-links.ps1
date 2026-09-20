$ErrorActionPreference = 'Continue'
$root = 'C:\My Web Sites\https___surveypesa.co.ke_'
$site = Join-Path $root 'surveypesa.co.ke'
$report = Join-Path $root 'link-report.txt'

$files = @(Get-ChildItem -LiteralPath $site -Recurse -Filter *.html -File)
$attrRx   = [regex]'(?i)\b(href|src|action|poster)\s*=\s*["'']([^"'']+)["'']'
$srcsetRx = [regex]'(?i)\bsrcset\s*=\s*["'']([^"'']+)["'']'
$absRx    = [regex]'(?i)\b(href|src|action)\s*=\s*["'']https?://surveypesa\.co\.ke([^"'']+)["'']'

$missing = @{}
$absSame = @{}
$stubFiles = @()
$totalRefs = 0

foreach ($f in $files) {
  $content = [System.IO.File]::ReadAllText($f.FullName)
  if ($content -match 'Click here' -and $f.Name -ne 'index.html') { $stubFiles += $f.Name }

  $refs = New-Object System.Collections.Generic.List[string]
  foreach ($m in $attrRx.Matches($content)) { $refs.Add($m.Groups[2].Value) }
  foreach ($m in $srcsetRx.Matches($content)) {
    foreach ($cand in ($m.Groups[1].Value -split ',')) {
      $tok = ($cand.Trim() -split '\s+')[0]
      if ($tok) { $refs.Add($tok) }
    }
  }
  foreach ($m in $absRx.Matches($content)) {
    $key = $m.Groups[2].Value
    if (-not $absSame.ContainsKey($key)) { $absSame[$key] = New-Object System.Collections.Generic.List[string] }
    $absSame[$key].Add($f.Name)
  }

  foreach ($u in $refs) {
    $totalRefs++
    $clean = $u.Replace('&amp;','&')
    $q = $clean.IndexOf('?');  if ($q -ge 0) { $clean = $clean.Substring(0,$q) }
    $h = $clean.IndexOf('#');  if ($h -ge 0) { $clean = $clean.Substring(0,$h) }
    if ($clean -eq '') { continue }
    if ($clean -match '^(?i)(https?:|//|mailto:|tel:|javascript:|data:|blob:)') { continue }
    $clean = [System.Uri]::UnescapeDataString($clean)
    if ($clean.EndsWith('/')) { $clean = $clean + 'index.html' }
    if ($clean.StartsWith('/')) { $full = Join-Path $site $clean.TrimStart('/') }
    else { $full = Join-Path $f.DirectoryName $clean }
    try { $full = [System.IO.Path]::GetFullPath($full) } catch { continue }
    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if (-not (Test-Path -LiteralPath $full)) {
      if (-not $missing.ContainsKey($full)) { $missing[$full] = New-Object System.Collections.Generic.List[string] }
      $missing[$full].Add($f.Name)
    }
  }
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("Files scanned: $($files.Count)   Link refs checked: $totalRefs")
$lines.Add("Auto-redirect stub pages: $($stubFiles.Count)")
$lines.Add("")
$lines.Add("=== MISSING LOCAL TARGETS ($($missing.Count)) ===")
foreach ($k in ($missing.Keys | Sort-Object)) {
  $srcs = ($missing[$k] | Select-Object -Unique) -join ', '
  if ($srcs.Length -gt 180) { $srcs = $srcs.Substring(0,180) + ' ...' }
  $lines.Add("MISSING: $k")
  $lines.Add("  referenced by: $srcs")
}
$lines.Add("")
$lines.Add("=== LEFTOVER ABSOLUTE LIVE-SITE URLS IN ATTRIBUTES ($($absSame.Count)) ===")
foreach ($k in ($absSame.Keys | Sort-Object)) {
  $srcs = ($absSame[$k] | Select-Object -Unique) -join ', '
  if ($srcs.Length -gt 180) { $srcs = $srcs.Substring(0,180) + ' ...' }
  $lines.Add("ABSOLUTE: https://surveypesa.co.ke$k  <-  $srcs")
}
$lines | Set-Content -LiteralPath $report -Encoding UTF8
Write-Output ("Files: {0}  Refs: {1}  Stubs: {2}  Missing: {3}  AbsoluteLive: {4}" -f $files.Count,$totalRefs,$stubFiles.Count,$missing.Count,$absSame.Count)
Write-Output "--- First 40 missing ---"
$i=0
foreach ($k in ($missing.Keys | Sort-Object)) { if ($i -ge 40) { break }; Write-Output ("{0}  <-  {1}" -f $k, (($missing[$k] | Select-Object -Unique | Select-Object -First 3) -join ', ')); $i++ }
Write-Output "--- First 40 absolute live-site attrs ---"
$j=0
foreach ($k in ($absSame.Keys | Sort-Object)) { if ($j -ge 40) { break }; Write-Output ("{0}  <-  {1}" -f $k, (($absSame[$k] | Select-Object -Unique | Select-Object -First 3) -join ', ')); $j++ }
Write-Output ("Full report: {0}" -f $report)