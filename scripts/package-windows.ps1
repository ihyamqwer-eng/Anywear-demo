[CmdletBinding()]
param(
  [string]$IsccPath
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installerRoot = Join-Path $projectRoot 'installer'
$stageRoot = Join-Path $installerRoot 'staging'
$outputRoot = Join-Path $installerRoot 'output'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$nodeRuntime = (& $nodeExecutable -p "JSON.stringify({version:process.versions.node,arch:process.arch})" | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Node.js runtime selected for packaging.' }
if ($nodeRuntime.version -notmatch '^24\.' -or $nodeRuntime.arch -ne 'x64') {
  throw "Packaging requires a Node.js 24 x64 runtime; found v$($nodeRuntime.version) $($nodeRuntime.arch) at $nodeExecutable."
}

if (-not $IsccPath) {
  $isccCommand = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($isccCommand) {
    $IsccPath = $isccCommand.Source
  } else {
    $userInstallPath = Join-Path $env:LOCALAPPDATA 'Programs\Inno\ISCC.exe'
    $knownPath = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    if (Test-Path $userInstallPath) {
      $IsccPath = $userInstallPath
    } elseif (Test-Path $knownPath) {
      $IsccPath = $knownPath
    }
  }
}
if (-not $IsccPath -or -not (Test-Path $IsccPath)) {
  throw 'Inno Setup 6 was not found. Install it or pass -IsccPath with the path to ISCC.exe.'
}

Push-Location $projectRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }

  $requiredPaths = @(
    (Join-Path $projectRoot 'server\dist\index.js'),
    (Join-Path $projectRoot 'client\dist\index.html'),
    (Join-Path $projectRoot '.env'),
    (Join-Path $projectRoot 'scripts\anywear-cli.mjs'),
    (Join-Path $projectRoot 'scripts\anywear.cmd')
  )
  $missing = $requiredPaths | Where-Object { -not (Test-Path $_) }
  if ($missing) { throw "Required packaging inputs are missing: $($missing -join ', ')" }

  if (Test-Path $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $stageRoot 'app\server'), (Join-Path $stageRoot 'app\client'), (Join-Path $stageRoot 'app\scripts'), (Join-Path $stageRoot 'runtime') -Force | Out-Null
  $dependencyRoot = Join-Path $stageRoot 'dependency-install'
  New-Item -ItemType Directory -Path (Join-Path $dependencyRoot 'server'), (Join-Path $dependencyRoot 'client') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json'), (Join-Path $projectRoot 'package-lock.json') -Destination $dependencyRoot
  Copy-Item -LiteralPath (Join-Path $projectRoot 'server\package.json') -Destination (Join-Path $dependencyRoot 'server\package.json')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'client\package.json') -Destination (Join-Path $dependencyRoot 'client\package.json')
  Push-Location $dependencyRoot
  try {
    & npm.cmd ci --omit=dev --include-workspace-root=false --workspace=anywear-demo-server --install-strategy=nested --audit=false --fund=false
    if ($LASTEXITCODE -ne 0) { throw 'Installing locked production dependencies failed.' }
  } finally {
    Pop-Location
  }
  $productionNodeModules = Join-Path $dependencyRoot 'node_modules'
  if (-not (Test-Path $productionNodeModules)) { throw 'Locked production dependencies were not installed.' }
  Copy-Item -LiteralPath (Join-Path $projectRoot 'server\dist') -Destination (Join-Path $stageRoot 'app\server\dist') -Recurse
  $stagedNodeModules = Join-Path $stageRoot 'app\server\node_modules'
  New-Item -ItemType Directory -Path $stagedNodeModules -Force | Out-Null
  Get-ChildItem -Force -LiteralPath $productionNodeModules |
    Where-Object { $_.Name -ne 'anywear-demo-server' } |
    Copy-Item -Destination $stagedNodeModules -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $projectRoot 'client\dist') -Destination (Join-Path $stageRoot 'app\client\dist') -Recurse
  Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\anywear-cli.mjs') -Destination (Join-Path $stageRoot 'app\scripts\anywear-cli.mjs')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\anywear.cmd') -Destination (Join-Path $stageRoot 'app\scripts\anywear.cmd')
  Copy-Item -LiteralPath (Join-Path $projectRoot '.env') -Destination (Join-Path $stageRoot 'app\.env.seed')
  Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $stageRoot 'runtime\node.exe')

  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
  & $IsccPath "/DStageDir=$stageRoot" "/DOutputDir=$outputRoot" (Join-Path $installerRoot 'anywear.iss')
  if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }
} finally {
  Pop-Location
}
