# Test fixture only: the previous text-pipe implementation, used solely to
# verify that the new byte pipe retains compatibility with existing ASCII
# DPAPI records. Never use this fixture for credentials or enterprise content.
param(
    [Parameter(Mandatory)]
    [ValidateSet('protect', 'unprotect')]
    [string]$Operation,
    [ValidateSet('token-cache', 'action-record')]
    [string]$Purpose = 'token-cache'
)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $value = [Console]::In.ReadToEnd()
    $entropy = [Text.Encoding]::UTF8.GetBytes("ccodex-workiq-$Purpose-v1")
    $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Operation -eq 'protect') {
        $bytes = [Text.Encoding]::UTF8.GetBytes($value)
        $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
        [Console]::Out.Write([Convert]::ToBase64String($protected))
    } else {
        $bytes = [Convert]::FromBase64String($value)
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
        [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
    }
} catch {
    [Console]::Error.WriteLine('Synthetic legacy vault operation failed.')
    exit 1
}
