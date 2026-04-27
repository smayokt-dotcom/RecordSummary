$port = 3001
$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving at http://localhost:$port"
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $reqPath = $ctx.Request.Url.LocalPath
    if ($reqPath -eq "/") { $reqPath = "/index.html" }
    $file = Join-Path $root ($reqPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar))
    if (Test-Path $file -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($file)
        $mime = switch ($ext) {
            ".html" { "text/html; charset=utf-8" }
            ".css"  { "text/css; charset=utf-8" }
            ".js"   { "application/javascript; charset=utf-8" }
            ".json" { "application/json; charset=utf-8" }
            ".svg"  { "image/svg+xml" }
            default { "application/octet-stream" }
        }
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $ctx.Response.ContentType = $mime
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
}
