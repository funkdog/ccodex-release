param(
    [Parameter(Mandatory)]
    [ValidateSet('protect', 'unprotect')]
    [string]$Operation,
    [ValidateSet('token-cache', 'action-record')]
    [string]$Purpose = 'token-cache'
)
$ErrorActionPreference = 'Stop'
$inputStream = $null
$inputBuffer = $null
$outputStream = $null
try {
    Add-Type -AssemblyName System.Security
    # Use byte streams end-to-end. Console text readers/writers can corrupt
    # multibyte UTF-8 near their buffer boundary under Windows PowerShell.
    # The existing DPAPI entropy, scope and base64 storage format stay unchanged.
    $inputStream = [Console]::OpenStandardInput()
    $inputBuffer = [IO.MemoryStream]::new()
    $buffer = [byte[]]::new(65536)
    while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($inputBuffer.Length + $count -gt 16MB) {
            throw [IO.InvalidDataException]::new('Vault input exceeded its bounded pipe size.')
        }
        $inputBuffer.Write($buffer, 0, $count)
    }
    $valueBytes = $inputBuffer.ToArray()
    $entropy = [Text.Encoding]::UTF8.GetBytes("ccodex-workiq-$Purpose-v1")
    $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Operation -eq 'protect') {
        $protected = [Security.Cryptography.ProtectedData]::Protect($valueBytes, $entropy, $scope)
        $resultBytes = [Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($protected))
    } else {
        $bytes = [Convert]::FromBase64String([Text.Encoding]::ASCII.GetString($valueBytes))
        $resultBytes = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
    }
    $outputStream = [Console]::OpenStandardOutput()
    $outputStream.Write($resultBytes, 0, $resultBytes.Length)
    $outputStream.Flush()
} catch {
    # Do not include exception text or input: either can contain credential data.
    [Console]::Error.WriteLine('Work IQ current-user credential vault operation failed.')
    exit 1
} finally {
    if ($inputBuffer) { $inputBuffer.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
    if ($outputStream) { $outputStream.Dispose() }
}
