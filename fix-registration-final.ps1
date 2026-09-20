$ErrorActionPreference = 'Stop'
$site = 'C:\My Web Sites\https___surveypesa.co.ke_\surveypesa.co.ke'
$reg = Join-Path $site 'registration.html'
$bak = $reg + '.bak'
$enc = New-Object System.Text.UTF8Encoding($false)

function Convert-AbsUrl([string]$v) {
  if ($v -eq '') { return 'index.html' }
  if ($v[0] -eq '?') { return 'index.html' + $v }
  $q = ''
  $qi = $v.IndexOf('?'); if ($qi -ge 0) { $q = $v.Substring($qi); $v = $v.Substring(0, $qi) }
  if ($v.StartsWith('/')) { $v = $v.TrimStart('/') }
  if ($v -eq '') { return 'index.html' + $q }
  if ($v -eq 'xmlrpc.php') { return 'xmlrpc0db0.html' + $q }
  if ($v.EndsWith('/')) { return $v + 'index.html' + $q }
  if ($v -match '\.[A-Za-z0-9]{1,5}$') { return $v + $q }
  return $v + '.html' + $q
}

# restore registration.html from backup (state before all fixes), then re-apply cleanly
Copy-Item -LiteralPath $bak -Destination $reg -Force
$c = [System.IO.File]::ReadAllText($reg)

$rxD = [regex]'(?i)\b(href|src|action|poster)\s*=\s*"https?://surveypesa\.co\.ke([^"]*)"'
$c = $rxD.Replace($c, { param($m) $m.Groups[1].Value + '="' + (Convert-AbsUrl $m.Groups[2].Value) + '"' })

$patS = "(?i)\b(href|src|action|poster)\s*=\s*'(https?://surveypesa\.co\.ke)([^']*)'"
$rxS = [regex]$patS
$c = $rxS.Replace($c, { param($m) $m.Groups[1].Value + "='" + (Convert-AbsUrl $m.Groups[2].Value) + "'" })

# RSS feed targets saved without extension
$c = $c.Replace('href="feed.html"', 'href="feed"').Replace("href='feed.html'", "href='feed'")
$c = $c.Replace('href="comments/feed.html"', 'href="comments/feed"').Replace("href='comments/feed.html'", "href='comments/feed'")

# jkit ajax endpoint capture + escaped elementor configs
$c = $c.Replace('"https://surveypesa.co.ke/?jkit-ajax-request=jkit_elements"', '"indexe2f2.html?jkit-ajax-request=jkit_elements"')
$c = $c.Replace('https:\/\/surveypesa.co.ke\/', '').Replace('http:\/\/surveypesa.co.ke\/', '')

[System.IO.File]::WriteAllText($reg, $c, $enc)
$left = ([regex]::Matches($c, '(?i)(href|src|action)=["'']https?://surveypesa\.co\.ke')).Count
Write-Output "registration.html rebuilt: absolute attrs remaining = $left"

# cosmetic: replace UTF-8 ellipsis with ASCII dots in all generated stub files
$stubFiles = @(
 (Join-Path 'C:\My Web Sites\https___surveypesa.co.ke_' 'index.html'),
 (Join-Path $site 'ABOUT_LINK.html'), (Join-Path $site 'TERMS_LINK.html'),
 (Join-Path $site 'SUPPORT_LINK.html'), (Join-Path $site 'PRIVACY_LINK.html'),
 (Join-Path $site 'LOGOUT_LINK.html'), (Join-Path $site 'FAVICON.html'),
 (Join-Path $site 'wp-content\cache\wpo-minify\1786367125\assets\wpo-minify-header-elementor-post-17091788953347.min.html')
)
foreach ($f in $stubFiles) {
  if (-not (Test-Path -LiteralPath $f)) { continue }
  $t = [System.IO.File]::ReadAllText($f)
  $t = $t.Replace([string][char]0x2026, '...')
  [System.IO.File]::WriteAllText($f, $t, $enc)
}
Write-Output 'stub ellipsis cleanup done'
Write-Output 'Done.'