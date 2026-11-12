param(
    [Parameter(Mandatory)][string]$LockPath,
    [Parameter(Mandatory)][string]$ExpectedSha256
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$recoveryMutex = $null
$hasRecoveryMutex = $false
$result = @{ status = 'unavailable' }
$stage = 'validate'
$jsonCodec = $null
function Get-RecordHash([string]$Target) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($Target)))).Replace('-', '')
    } finally { $algorithm.Dispose() }
}
try {
    # Do not depend on auto-loaded PowerShell modules inherited from a pwsh 7
    # parent; this helper runs under the system Windows PowerShell 5 runtime.
    $stage = 'json_runtime'
    [void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
    $jsonCodec = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
    $jsonCodec.MaxJsonLength = 16384
    $stage = 'validate'
    $resolvedLock = [IO.Path]::GetFullPath($LockPath)
    $lockDirectory = [IO.Path]::GetDirectoryName($resolvedLock)
    if (-not [IO.Path]::IsPathRooted($LockPath) -or
        -not $resolvedLock.EndsWith('.lock', [StringComparison]::OrdinalIgnoreCase) -or
        $ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw 'Invalid recovery target.'
    }
    $stage = 'mutex_create'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $mutexBytes = [Text.Encoding]::UTF8.GetBytes($identity.User.Value + '|' + $resolvedLock.ToLowerInvariant())
        $mutexHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash($mutexBytes))).Replace('-', '')
    } finally { $hashAlgorithm.Dispose() }
    $mutexSecurity = [System.Security.AccessControl.MutexSecurity]::new()
    $mutexSecurity.AddAccessRule([Security.AccessControl.MutexAccessRule]::new(
        $identity.User, [Security.AccessControl.MutexRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow))
    $createdNew = $false
    $recoveryMutex = [Threading.Mutex]::new(
        $false, ('Global\CCodexWorkIqRecovery_' + $mutexHash),
        [ref]$createdNew, $mutexSecurity)
    $stage = 'mutex_wait'
    try { $hasRecoveryMutex = $recoveryMutex.WaitOne(2000) }
    catch [Threading.AbandonedMutexException] { $hasRecoveryMutex = $true }
    if (-not $hasRecoveryMutex) {
        $result.status = 'busy'
    } elseif (-not [IO.File]::Exists($resolvedLock)) {
        $result.status = 'changed'
    } else {
        $stage = 'lock_read'
        $entry = [IO.FileInfo]::new($resolvedLock)
        if (-not $entry.Exists) {
            throw [IO.FileNotFoundException]::new('Lock changed during recovery.')
        }
        if (($entry.Attributes -band [IO.FileAttributes]::Directory) -or
            ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Length -gt 4096) {
            throw 'Recovery target is not a regular lock record.'
        }
        $recordHash = Get-RecordHash $resolvedLock
        if ($recordHash -ne $ExpectedSha256) {
            $result.status = 'changed'
        } else {
            $stage = 'owner_parse'
            $lockOwner = $jsonCodec.DeserializeObject([IO.File]::ReadAllText($resolvedLock))
            if (-not ($lockOwner -is [Collections.IDictionary]) -or
                -not ($lockOwner['pid'] -is [int] -or $lockOwner['pid'] -is [long]) -or
                [long]$lockOwner['pid'] -le 0 -or [long]$lockOwner['pid'] -gt [int]::MaxValue) {
                throw 'Lock has no verifiable owner.'
            }
            $stage = 'owner_check'
            $ownerIsAbsent = $false
            try {
                $ownerProcess = [Diagnostics.Process]::GetProcessById([int]$lockOwner['pid'])
                $ownerProcess.Dispose()
            } catch {
                $processError = $_.Exception
                while ($null -ne $processError.InnerException) { $processError = $processError.InnerException }
                if ($processError -is [ArgumentException]) { $ownerIsAbsent = $true }
                else { throw }
            }
            if (-not $ownerIsAbsent) {
                $result.status = 'live'
            } elseif ((Get-RecordHash $resolvedLock) -ne $ExpectedSha256) {
                $result.status = 'changed'
            } else {
                # Recovery is serialized by an OS mutex, including across crashes.
                # Ordinary acquirers cannot replace an existing stale lock. Move
                # only this exact dead-owner record; never unlink a new live lock.
                $backupPath = [IO.Path]::GetFullPath(
                    $resolvedLock + '.abandoned.' + [guid]::NewGuid().ToString('N') + '.json')
                if (-not $backupPath.StartsWith(
                    $lockDirectory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'Recovery backup escaped the lock directory.'
                }
                $stage = 'lock_move'
                [IO.File]::Move($resolvedLock, $backupPath)
                $result = @{ status='recovered'; previousOwnerPid=[int]$lockOwner['pid']; backupPath=$backupPath }
            }
        }
    }
} catch {
    # No credential bytes, raw record contents, or exception detail leave this helper.
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    if ($failure -is [IO.FileNotFoundException] -or $failure -is [IO.DirectoryNotFoundException]) {
        # A legitimate owner can acquire/release a replacement while this helper
        # starts. Re-enter exclusive acquisition; do not misreport it as auth failure.
        $result = @{ status='changed'; stage=$stage }
    } elseif ($failure -is [IO.IOException] -and (($failure.HResult -band 65535) -in @(32, 33))) {
        # Windows can briefly retain file handles while an exited process is
        # being cleaned up. Wait; never override an OS sharing/locking refusal.
        $result = @{ status='busy'; stage=$stage }
    } else {
        $result = @{ status='unavailable'; stage=$stage; exceptionType=$failure.GetType().FullName; hresult=$failure.HResult }
    }
} finally {
    if ($hasRecoveryMutex) { $recoveryMutex.ReleaseMutex() }
    if ($null -ne $recoveryMutex) { $recoveryMutex.Dispose() }
}
if ($null -ne $jsonCodec) { [Console]::Out.Write($jsonCodec.Serialize($result)) }
else { [Console]::Out.Write('{"status":"unavailable","stage":"json_runtime"}') }
