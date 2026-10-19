$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $taskRoot
try {
    if (Get-NetTCPConnection -State Listen -LocalPort 4742 -ErrorAction SilentlyContinue) {
        throw '4742 is already occupied. Do not stop another preview. Use its existing page or choose a separate test port.'
    }
    $env:WACA_ISOLATED_PG_URL = 'postgresql://postgres@127.0.0.1:55492/waca_v3_base'
    if (-not $env:WACA_TEST_SAFEUPDATE_LIBRARY) { $env:WACA_TEST_SAFEUPDATE_LIBRARY = '/tmp/erp2-waca-21000-safeupdate.WVPsHx/safeupdate.so' }
    if (-not $env:WACA_TEST_POSTGREST_BINARY) { $env:WACA_TEST_POSTGREST_BINARY = '/tmp/erp2-waca-074-postgrest.9CoffC/postgrest' }
    & wsl.exe -e test -f $env:WACA_TEST_SAFEUPDATE_LIBRARY
    if ($LASTEXITCODE -ne 0) { throw 'The existing isolated safeupdate runtime is unavailable. Stop; do not connect to a cloud database.' }
    & wsl.exe -e test -x $env:WACA_TEST_POSTGREST_BINARY
    if ($LASTEXITCODE -ne 0) { throw 'The existing isolated PostgREST runtime is unavailable. Stop; do not obtain production credentials.' }
    & node tests/waca-order-recognition-ui.mjs --serve
    if ($LASTEXITCODE -ne 0) { throw 'Isolated preview failed.' }
} finally { Pop-Location }
