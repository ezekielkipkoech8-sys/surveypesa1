$ErrorActionPreference = 'Stop'
$site = 'C:\My Web Sites\https___surveypesa.co.ke_\surveypesa.co.ke'
$enc = New-Object System.Text.UTF8Encoding($false)

# build asset map: clean name -> local relative path (handles HTTrack 4-hex hash suffix)
$map = @{}
$assets = Get-ChildItem -LiteralPath $site -Recurse -File | Where-Object { $_.Extension -match '^\.(js|css|png|jpe?g|webp|gif|svg|woff2?|ttf|mp4)$' }
foreach ($a in $assets) {
  $rel = $a.FullName.Substring($site.Length + 1).Replace('\','/')
  $name = $a.Name
  if ($name -match '^(?<base>.+?)(?<hash>[0-9a-f]{4})(?<ext>\.(js|css|png|jpe?g|webp|gif|svg|woff2?|ttf|mp4))$' -and $name -notmatch '^[0-9a-f]{8}-') {
    $clean = $Matches['base'] + $Matches['ext']
  } else { $clean = $name }
  $key = ($rel.Substring(0, $rel.Length - $name.Length) + $clean).ToLower()
  if (-not $map.ContainsKey($key)) { $map[$key] = $rel }
}

function Resolve-Local([string]$url) {
  # returns site-root-relative path or $null if it cannot be served locally
  if ($url -notmatch '(?i)^https?://surveypesa\.co\.ke(/.*)$') { return $url }
  $p = $Matches[1]
  $q = ''
  $qi = $p.IndexOf('?'); if ($qi -ge 0) { $q = $p.Substring($qi); $p = $p.Substring(0, $qi) }
  $cleanKey = $p.TrimStart('/').ToLower()
  if ($map.ContainsKey($cleanKey)) { return $map[$cleanKey] + $q }
  return $null
}

$files = Get-ChildItem -LiteralPath $site -Recurse -Filter *.html -File
$srcsetRx = [regex]'(?i)srcset\s*=\s*"([^"]+)"'
$contentRx = [regex]'(?i)content\s*=\s*"https?://surveypesa\.co\.ke/([^"]+)"'
$fixedFiles = 0
foreach ($f in $files) {
  $c = [System.IO.File]::ReadAllText($f.FullName)
  $orig = $c
  $relDir = $f.DirectoryName.Substring($site.Length).TrimStart('\','/')
  $depth = 0
  if ($relDir -ne '') { $depth = ($relDir -split '[\\/]').Count }
  $prefix = '../' * $depth

  $c = $srcsetRx.Replace($c, {
    param($m)
    $parts = $m.Groups[1].Value -split ','
    $kept = @()
    foreach ($part in $parts) {
      $t = $part.Trim()
      if ($t -eq '') { continue }
      $sp = $t.IndexOf(' ')
      if ($sp -lt 0) { $u = $t; $desc = '' } else { $u = $t.Substring(0, $sp); $desc = $t.Substring($sp) }
      if ($u -match '(?i)^https?://surveypesa\.co\.ke/') {
        $loc = Resolve-Local $u
        if ($loc -ne $null -and $loc -ne '') { $kept += ($prefix + $loc + $desc) }
      } else {
        # already relative: keep if it resolves from this page's folder
        if (Test-Path -LiteralPath (Join-Path $f.DirectoryName ($u -replace '/', '\'))) {
          $kept += ($u + $desc)
        } else {
          $bare = $u -replace '^(\.\./)+', ''
          $cleanKey = $bare.ToLower()
          if ($map.ContainsKey($cleanKey)) { $kept += ($prefix + $map[$cleanKey] + $desc) }
        }
      }
    }
    return 'srcset="' + ($kept -join ', ') + '"'
  })

  $c = $contentRx.Replace($c, {
    param($m)
    $cleanKey = $m.Groups[1].Value.ToLower()
    if ($map.ContainsKey($cleanKey)) { return 'content="' + $prefix + $map[$cleanKey] + '"' }
    return $m.Value
  })

  if ($c -ne $orig) {
    [System.IO.File]::WriteAllText($f.FullName, $c, $enc)
    $fixedFiles++
  }
}
Write-Output "files updated: $fixedFiles"
Write-Output 'Done.'