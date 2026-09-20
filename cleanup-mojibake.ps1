$ErrorActionPreference = 'Stop'
$root = 'C:\My Web Sites\https___surveypesa.co.ke_'
$site = Join-Path $root 'surveypesa.co.ke'
$enc = New-Object System.Text.UTF8Encoding($false)

# mojibake sequence produced by ANSI-parsed UTF-8 ellipsis: 0xE2 0x20AC 0xA6 ("â€¦")
$moji = [string][char]0xE2 + [string][char]0x20AC + [string][char]0xA6

$targets = @(
  (Join-Path $root 'index.html'),
  (Join-Path $site 'ABOUT_LINK.html'),
  (Join-Path $site 'TERMS_LINK.html'),
  (Join-Path $site 'SUPPORT_LINK.html'),
  (Join-Path $site 'PRIVACY_LINK.html'),
  (Join-Path $site 'LOGOUT_LINK.html'),
  (Join-Path $site 'FAVICON.html'),
  (Join-Path $site 'wp-content\cache\wpo-minify\1786367125\assets\wpo-minify-header-elementor-post-17091788953347.min.html')
)
foreach ($f in $targets) {
  if (-not (Test-Path -LiteralPath $f)) { Write-Output "skip: $f"; continue }
  $t = [System.IO.File]::ReadAllText($f)
  if ($t.Contains($moji)) {
    $t = $t.Replace($moji, '...')
    [System.IO.File]::WriteAllText($f, $t, $enc)
    Write-Output "cleaned: $(Split-Path -Leaf $f)"
  } else {
    Write-Output "clean already: $(Split-Path -Leaf $f)"
  }
}
Write-Output 'Done.'