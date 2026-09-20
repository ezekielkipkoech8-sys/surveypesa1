$ErrorActionPreference = 'Stop'
$site = 'C:\My Web Sites\https___surveypesa.co.ke_\surveypesa.co.ke'
$reg = Join-Path $site 'registration.html'
$twin = Join-Path $site 'wp-content\cache\wpo-minify\1786367125\assets\wpo-minify-header-elementor-post-17091788953347.min.html'
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

# --- registration.html: single-quoted attribute URLs ---
$c = [System.IO.File]::ReadAllText($reg)
$attrAbsS = "(?i)\b(href|src|action|poster)\s*=\s*'(https?://surveypesa\.co\.ke)([^']*)'"
$c = $attrAbsS.Replace($c, { param($m) $m.Groups[1].Value + "='" + (Convert-AbsUrl $m.Groups[2].Value) + "'" })
# correct RSS feed targets (saved by HTTrack without extension)
$c = $c.Replace('href="feed.html"', 'href="feed"')
$c = $c.Replace("href='feed.html'", "href='feed'")
$c = $c.Replace('href="comments/feed.html"', 'href="comments/feed"')
$c = $c.Replace("href='comments/feed.html'", "href='comments/feed'")
[System.IO.File]::WriteAllText($reg, $c, $enc)
$left = ([regex]::Matches($c, '(?i)(href|src|action)=["'']https?://surveypesa\.co\.ke')).Count
Write-Output "registration.html: absolute attrs remaining = $left"

# --- inert cache twin: replace with redirect stub back to registration.html ---
$stub = @"
<!DOCTYPE html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<title>Redirecting…</title>
<meta http-equiv="refresh" content="0; url=../../../../../registration.html">
<script>location.replace('../../../../../registration.html');</script>
</head>
<body>
<p>Redirecting to <a href="../../../../../registration.html">registration page</a>…</p>
</body>
</html>
"@
[System.IO.File]::WriteAllText($twin, $stub, $enc)
Write-Output 'cache twin -> redirect stub'
Write-Output 'Done.'