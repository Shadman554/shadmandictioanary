$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$results = @{}
$files = Get-ChildItem 'C:\Users\NAMI\ShadmanDictionaryNew\data\*.json'
foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw -Encoding UTF8
    $matches = [regex]::Matches($content, '\[[^\]]{2,40}\]')
    foreach ($m in $matches) {
        $cat = $m.Value
        if (-not $results.ContainsKey($cat)) { $results[$cat] = 0 }
        $results[$cat]++
    }
}
$sorted = $results.GetEnumerator() | Sort-Object Value -Descending
$outData = @("Total unique categories: $($sorted.Count)", "")
foreach ($entry in $sorted) {
    $outData += "$($entry.Value.ToString().PadLeft(6))  $($entry.Key)"
}
$outData | Out-File -FilePath 'C:\Users\NAMI\ShadmanDictionaryNew\categories_count.txt' -Encoding UTF8
