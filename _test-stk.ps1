$ErrorActionPreference = 'Continue'
$proj = 'c:\My Web Sites\https___surveypesa.co.ke_\stk-push-server'
$base = 'http://localhost:3000'

function Invoke-Test([string]$name, [scriptblock]$block) {
  try {
    $result = & $block
    Write-Output ("{0} => {1}" -f $name, $result)
  } catch {
    $code = ''
    $body = ''
    try {
      $code = [int]$_.Exception.Response.StatusCode
      $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $body = $sr.ReadToEnd()
      $sr.Close()
    } catch { $body = $_.Exception.Message }
    Write-Output ("{0} => HTTP {1} {2}" -f $name, $code, $body)
  }
}

Write-Output '=== TEST 1: unconfigured server (placeholder .env values) ==='
$p1 = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $proj -PassThru -WindowStyle Hidden -RedirectStandardOutput "$proj\_s1.log" -RedirectStandardError "$proj\_s1.err.log"
Start-Sleep -Seconds 2
Invoke-Test 'HEALTH (expect ok, configured=false)' { (Invoke-RestMethod "$base/health" -TimeoutSec 5 | ConvertTo-Json -Compress) }
Invoke-Test 'MISSING-PHONE (expect 400)' { (Invoke-RestMethod -Uri "$base/api/stk-push" -Method Post -Body '{"amount":99}' -ContentType 'application/json' -TimeoutSec 10 | ConvertTo-Json -Compress) }
Invoke-Test 'BAD-TIER 123 (expect 400)' { (Invoke-RestMethod -Uri "$base/api/stk-push" -Method Post -Body '{"phone":"0712345678","tier":123}' -ContentType 'application/json' -TimeoutSec 10 | ConvertTo-Json -Compress) }
Invoke-Test 'BAD-PHONE 12345 (expect 400)' { (Invoke-RestMethod -Uri "$base/api/stk-push" -Method Post -Body '{"phone":"12345","tier":99}' -ContentType 'application/json' -TimeoutSec 10 | ConvertTo-Json -Compress) }
Invoke-Test 'BAD-AMOUNT 9.5 (expect 400)' { (Invoke-RestMethod -Uri "$base/api/stk-push" -Method Post -Body '{"phone":"0712345678","amount":9.5}' -ContentType 'application/json' -TimeoutSec 10 | ConvertTo-Json -Compress) }
Invoke-Test 'VALID-UNCONFIGURED (expect 500 config message)' { (Invoke-RestMethod -Uri "$base/api/stk-push" -Method Post -Body '{"phone":"0712345678","tier":99}' -ContentType 'application/json' -TimeoutSec 10 | ConvertTo-Json -Compress) }
Stop-Process -Id $p1.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Output '=== TEST 2: configured with dummy provider endpoint (exercises axios path) ==='
$env:HASHBACK_API_KEY = 'test-key-123'
$env:HASHBACK_STK_ENDPOINT = 'http://127.0.0.1:59999/stk-push'
$p2 = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $proj -PassThru -WindowStyle Hidden -RedirectStandardOutput "$proj\_s2.log" -RedirectStandardError "$proj\_s2.err.log"
Start-Sleep -Seconds 2
Invoke-Test 'PHONE-NORMALIZED + VALID (expect 502 provider-unreachable)' { (Invoke-RestMethod -Uri "$base/api/stk-push" -Method Post -Body '{"phone":"+254 (712) 345-678","tier":149}' -ContentType 'application/json' -TimeoutSec 30 | ConvertTo-Json -Compress) }
Stop-Process -Id $p2.Id -Force -ErrorAction SilentlyContinue

Write-Output '--- server startup logs ---'
Get-Content "$proj\_s1.log" -ErrorAction SilentlyContinue
Get-Content "$proj\_s1.err.log" -ErrorAction SilentlyContinue
Get-Content "$proj\_s2.log" -ErrorAction SilentlyContinue
Get-Content "$proj\_s2.err.log" -ErrorAction SilentlyContinue
