# Foreground launch template. Run under the consenting user; never embed credentials.
param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$BridgeCli,
  [Parameter(Mandatory=$true)][string]$IdentityPath,
  [Parameter(Mandatory=$true)][string]$PassphrasePath
)
$ErrorActionPreference = 'Stop'
foreach ($target in @($NodePath, $BridgeCli, $IdentityPath, $PassphrasePath)) {
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Bridge launch file missing' }
}
& $NodePath $BridgeCli connect --identity $IdentityPath --passphrase-file $PassphrasePath
exit $LASTEXITCODE
