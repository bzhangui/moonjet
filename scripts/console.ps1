$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectPath
Write-Host ('MoonJet ' + (Get-Content -LiteralPath (Join-Path $projectPath 'package.json') -Encoding UTF8 | ConvertFrom-Json).version)
while ($true) {
    Write-Host '1 运行隔离演示   2 维护测试   3 使用说明   0 退出'
    $choice = Read-Host '请选择'
    if ($choice -eq '0') { break }
    try {
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js >=22.13' }
        if (-not (Test-Path -LiteralPath (Join-Path $projectPath '_build\js\release\build\cmd\bridge\bridge.js'))) {
            & node (Join-Path $projectPath 'scripts\build.mjs')
            if ($LASTEXITCODE -ne 0) { throw '构建失败，请检查 MoonBit >=0.10.15' }
        }
        switch ($choice) {
            '1' { & node (Join-Path $projectPath 'scripts\install-server.mjs')
                if ($LASTEXITCODE -ne 0) { throw '服务下载或核验失败' }
                & node (Join-Path $projectPath 'examples\demo.mjs') }
            '2' { if (-not (Test-Path -LiteralPath (Join-Path $projectPath 'scripts\validate.mjs'))) { throw '运行包不包含开发测试，请使用源码目录' }; & node (Join-Path $projectPath 'scripts\validate.mjs') }
            '3' { Get-Content -LiteralPath (Join-Path $projectPath 'README.md') -Encoding UTF8 }
            default { Write-Host '请选择 0 到 3' }
        }
    } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
}

