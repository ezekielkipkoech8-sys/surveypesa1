$baseUrl = "http://localhost:8080"
$siteRoot = Get-Location
$htmlFiles = Get-ChildItem -Path $siteRoot -Filter *.html -File

$results = @()

foreach ($file in $htmlFiles) {
    $url = "$baseUrl/$($file.Name)"
    try {
        $response = Invoke-WebRequest -Uri $url -Method Get -UseBasicParsing -TimeoutSec 10
        $status = $response.StatusCode
    } catch {
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
        } else {
            $status = "ERROR: $($_.Exception.Message)"
        }
    }
    $results += [PSCustomObject]@{ Page = $file.Name; Status = $status }
    Write-Host "$($file.Name) -> $status"
}

Write-Host "`n===== SUMMARY ====="
Write-Host "Total pages tested: $($results.Count)"
$failed = $results | Where-Object { $_.Status -ne 200 }
if ($failed.Count -eq 0) {
    Write-Host "All pages returned 200 OK!"
} else {
    Write-Host "$($failed.Count) page(s) had issues:"
    $failed | ForEach-Object { Write-Host "  $($_.Page) -> $($_.Status)" }
}

$results | Export-Csv -Path "page-test-results.csv" -NoTypeInformation
Write-Host "`nFull results saved to page-test-results.csv"