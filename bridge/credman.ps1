#Requires -Version 5.1
# Emits JSON [{target, secret}] for GitHub OAuth tokens already stored for the current
# Windows user (written by the GitHub Copilot app / CLI). Nothing is written or sent anywhere.
$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class CodexCopilotCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredEnumerateW(string filter, uint flag, out uint count, out IntPtr creds);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buf);

  // flag 0x1 = CRED_ENUMERATE_ALL_CREDENTIALS (requires a null filter).
  public static List<string[]> Enumerate(uint flag) {
    var result = new List<string[]>();
    uint count; IntPtr ptr;
    if (!CredEnumerateW(null, flag, out count, out ptr)) return result;
    try {
      for (uint i = 0; i < count; i++) {
        IntPtr item = Marshal.ReadIntPtr(ptr, (int)(i * IntPtr.Size));
        var cred = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));
        string target = cred.TargetName != IntPtr.Zero ? Marshal.PtrToStringUni(cred.TargetName) : "";
        string secret = "";
        if (cred.CredentialBlobSize > 1 && cred.CredentialBlob != IntPtr.Zero) {
          try { secret = Marshal.PtrToStringUni(cred.CredentialBlob, (int)(cred.CredentialBlobSize / 2)); }
          catch { secret = ""; }
        }
        result.Add(new string[] { target, secret });
      }
    } finally { CredFree(ptr); }
    return result;
  }
}
'@

if (-not ('CodexCopilotCred' -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp | Out-Null }

$found = [ordered]@{}
foreach ($flag in @([uint32]1, [uint32]0)) {
    $entries = @()
    try { $entries = [CodexCopilotCred]::Enumerate($flag) } catch { $entries = @() }
    foreach ($entry in $entries) {
        $target = [string]$entry[0]
        $secret = [string]$entry[1]
        if ([string]::IsNullOrWhiteSpace($secret)) { continue }
        $secret = $secret.Trim([char]0).Trim()
        if ($secret -notmatch '^(gho_|ghu_|ghp_|github_pat_)[A-Za-z0-9_]+$') { continue }
        if ($found.Contains($secret)) { continue }
        $found[$secret] = $target
    }
    if ($found.Count -gt 0) { break }
}

# Prefer credentials that clearly belong to a GitHub Copilot client.
$list = @()
foreach ($key in $found.Keys) {
    $list += [PSCustomObject]@{ target = $found[$key]; secret = $key }
}
$list = @($list | Sort-Object -Property @{ Expression = { if ($_.target -match 'copilot') { 0 } else { 1 } } }, target)

if ($list.Count -eq 0) { Write-Output '[]' }
else { Write-Output (ConvertTo-Json -InputObject $list -Compress -Depth 3) }
