[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$LanIp,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$parsedIp = [System.Net.IPAddress]::Parse($LanIp)
if ($parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
  throw 'LanIp must be an IPv4 address.'
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$certificateDirectory = Join-Path $projectRoot '.certs'
[System.IO.Directory]::CreateDirectory($certificateDirectory) | Out-Null

$caPath = Join-Path $certificateDirectory 'lan-ca.crt'
$serverCertificatePath = Join-Path $certificateDirectory 'lan-server.crt'
$serverKeyPath = Join-Path $certificateDirectory 'lan-server.key'
$outputPaths = @($caPath, $serverCertificatePath, $serverKeyPath)
$existingPaths = $outputPaths | Where-Object { Test-Path $_ }
if ($existingPaths -and -not $Force) {
  throw "Certificate files already exist. Remove them or rerun with -Force: $($existingPaths -join ', ')"
}

$caCertificate = $null
$serverCertificate = $null
$serverPrivateKey = $null
try {
  $storePath = 'Cert:\CurrentUser\My'
  $caCertificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject 'CN=Qingye Anywear LAN Demo CA' `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(3) `
    -CertStoreLocation $storePath `
    -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0')

  $subjectAlternativeName = "2.5.29.17={text}IPAddress=$LanIp&IPAddress=127.0.0.1&DNS=localhost"
  $serverCertificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject "CN=$LanIp" `
    -Signer $caCertificate `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(1) `
    -CertStoreLocation $storePath `
    -TextExtension @(
      $subjectAlternativeName,
      '2.5.29.37={text}1.3.6.1.5.5.7.3.1',
      '2.5.29.19={critical}{text}ca=0'
    )

  $serverPrivateKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($serverCertificate)
  [System.IO.File]::WriteAllText($caPath, $caCertificate.ExportCertificatePem(), [System.Text.Encoding]::ASCII)
  [System.IO.File]::WriteAllText($serverCertificatePath, $serverCertificate.ExportCertificatePem(), [System.Text.Encoding]::ASCII)
  [System.IO.File]::WriteAllText($serverKeyPath, $serverPrivateKey.ExportPkcs8PrivateKeyPem(), [System.Text.Encoding]::ASCII)

  Write-Output "LAN HTTPS certificate created for $LanIp"
  Write-Output "CA certificate: $caPath"
  Write-Output "CA SHA-256: $((Get-FileHash -Path $caPath -Algorithm SHA256).Hash)"
  Write-Output "Server certificate and private key are local-only files under $certificateDirectory"
  Write-Output 'Do not share lan-server.key. Import lan-ca.crt into Trusted Root Certification Authorities on each client computer.'
}
finally {
  if ($serverPrivateKey) { $serverPrivateKey.Dispose() }
  if ($serverCertificate) {
    Remove-Item "Cert:\CurrentUser\My\$($serverCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    $serverCertificate.Dispose()
  }
  if ($caCertificate) {
    Remove-Item "Cert:\CurrentUser\My\$($caCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    $caCertificate.Dispose()
  }
}
