$ErrorActionPreference = 'Stop'
$targets = @(
 'C:\My Web Sites\https___surveypesa.co.ke_\surveypesa.co.ke\registration.html',
 'C:\My Web Sites\https___surveypesa.co.ke_\surveypesa.co.ke\wp-content\cache\wpo-minify\1786367125\assets\wpo-minify-header-elementor-post-17091788953347.min.html'
)
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

foreach ($p in $targets) {
  if (-not (Test-Path -LiteralPath $p)) { Write-Output "SKIP (not found): $p"; continue }
  $c = [System.IO.File]::ReadAllText($p)
  Copy-Item -LiteralPath $p -Destination ($p + '.bak') -Force

  $attrAbs = [regex]'(?i)\b(href|src|action|poster)\s*=\s*"https?://surveypesa\.co\.ke([^"]*)"'
  $c = $attrAbs.Replace($c, { param($m) $m.Groups[1].Value + '="' + (Convert-AbsUrl $m.Groups[2].Value) + '"' })

  # plain JS config (jkit ajax endpoint captured as indexe2f2.html)
  $c = $c.Replace('"https://surveypesa.co.ke/?jkit-ajax-request=jkit_elements"', '"indexe2f2.html?jkit-ajax-request=jkit_elements"')

  # escaped JSON config forms (elementor configs) -> relative
  $c = $c.Replace('https:\/\/surveypesa.co.ke\/', '')
  $c = $c.Replace('http:\/\/surveypesa.co.ke\/', '')

  [System.IO.File]::WriteAllText($p, $c, $enc)
  $left = ([regex]::Matches($c, 'https?://surveypesa\.co\.ke')).Count
  Write-Output ("fixed: {0}  (remaining domain refs = schema/metadata only: {1})" -f (Split-Path -Leaf $p), $left)
}
Write-Output 'Done.'