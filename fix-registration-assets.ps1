$ErrorActionPreference = 'Stop'
$site = 'C:\My Web Sites\https___surveypesa.co.ke_\surveypesa.co.ke'
$reg = Join-Path $site 'registration.html'
$donor = Join-Path $site 'about-survey-money.html'
$enc = New-Object System.Text.UTF8Encoding($false)

# --- build map: normalized clean name -> local relative path (hashed names) ---
$map = @{}
$assets = Get-ChildItem -LiteralPath $site -Recurse -File | Where-Object { $_.Extension -match '^\.(js|css|png|jpe?g|webp|gif|svg|woff2?|ttf|mp4)$' }
foreach ($a in $assets) {
  $rel = $a.FullName.Substring($site.Length + 1).Replace('\','/')
  $name = $a.Name
  # strip 4-hex hash appended before extension (HTTrack style: name + 4hex + .ext)
  if ($name -match '^(?<base>.+?)(?<hash>[0-9a-f]{4})(?<ext>\.(js|css|png|jpe?g|webp|gif|svg|woff2?|ttf|mp4))$' -and $name -notmatch '^[0-9a-f]{8}-') {
    $clean = $Matches['base'] + $Matches['ext']
  } else { $clean = $name }
  $key = ($rel.Substring(0, $rel.Length - $name.Length) + $clean).ToLower()
  if (-not $map.ContainsKey($key)) { $map[$key] = $rel }
}
Write-Output ("asset map entries: {0}" -f $map.Count)

# --- splice donor stylesheet block into registration.html ---
$dc = [System.IO.File]::ReadAllText($donor)
$dm = [regex]::Match($dc, "(?s)(<link rel='stylesheet' id='wpo_min-header-0-css'.*?)(<script id=`"jquery-core-js`")")
if (-not $dm.Success) { throw 'donor block not found' }
$donorBlock = $dm.Groups[1].Value

$c = [System.IO.File]::ReadAllText($reg)
$rm = [regex]::Match($c, "(?s)(<link rel='stylesheet' id='wpo_min-header-0-css'.*?)(<script id=`"jquery-core-js`")")
if (-not $rm.Success) { throw 'registration block not found' }
$c = $c.Substring(0, $rm.Groups[1].Index) + $donorBlock + $c.Substring($rm.Groups[1].Index + $rm.Groups[1].Length)

# --- rewrite remaining plain ?ver= asset refs to hashed local names ---
$rx = [regex]'\b(src|href)\s*=\s*"(?!(https?:|//|#|mailto:|data:))([^"?]+\.(?:js|css|png|jpe?g|webp|gif|svg))(\?[^"]*)?"'
$c = $rx.Replace($c, {
  param($m)
  $attr = $m.Groups[1].Value
  $path = $m.Groups[3].Value
  $query = $m.Groups[4].Value
  $cleanKey = $path.ToLower()
  if ($map.ContainsKey($cleanKey)) {
    return $attr + '="' + $map[$cleanKey] + $query + '"'
  }
  return $m.Value
})

[System.IO.File]::WriteAllText($reg, $c, $enc)
$leftAbs = ([regex]::Matches($c, '(?i)(href|src|action)=["'']https?://surveypesa\.co\.ke')).Count
Write-Output "registration.html: absolute attrs remaining = $leftAbs"
Write-Output 'Done.'