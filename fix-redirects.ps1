$ErrorActionPreference = 'Stop'
$site = 'C:\My Web Sites\https___surveypesa.co.ke_\surveypesa.co.ke'
$rootIndex = 'C:\My Web Sites\https___surveypesa.co.ke_\index.html'

function New-Redirect([string]$path, [string]$target) {
  $esc = $target.Replace('&','&amp;')
  $js  = $target.Replace('\','\\').Replace("'","\'")
  $html = @"
<!DOCTYPE html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<title>Redirecting…</title>
<meta http-equiv="refresh" content="0; url=$esc">
<link rel="canonical" href="$esc">
<script>location.replace('$js');</script>
</head>
<body>
<p>Redirecting to <a href="$esc">$esc</a>…</p>
</body>
</html>
"@
  [System.IO.File]::WriteAllText($path, $html, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "redirected: $(Split-Path -Leaf $path) -> $target"
}

# 404-placeholder captures -> real local pages
New-Redirect (Join-Path $site 'ABOUT_LINK.html')  'about-survey-money.html'
New-Redirect (Join-Path $site 'TERMS_LINK.html')   'terms-and-conditions.html'
New-Redirect (Join-Path $site 'SUPPORT_LINK.html') 'contact-us.html'
New-Redirect (Join-Path $site 'PRIVACY_LINK.html') 'privacy-policy.html'
New-Redirect (Join-Path $site 'LOGOUT_LINK.html')  'index.html'
New-Redirect (Join-Path $site 'FAVICON.html')      'index.html'

# Wrapper index (broken HTTrack TOC) -> clean redirect into the real site
New-Redirect $rootIndex 'surveypesa.co.ke/index.html'
Write-Output 'Done.'