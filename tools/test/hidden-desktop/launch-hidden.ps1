<#
  Launches a process on a separate, invisible Windows desktop ("WinSta0\pikara-test") so test
  windows never appear on the user's desktop and never take foreground focus. Child processes
  (installers, self-update helper, relaunched app) inherit the same invisible desktop.

  Start it WITHOUT any visible console and outside the Claude app container:
      explorer.exe <generated .vbs>   (see run-hidden.mjs)

  -Wait writes "<exitcode>" to -ExitFile when the process ends (for silent installers).
#>
param(
  [Parameter(Mandatory)] [string] $Exe,
  [string] $Arguments = "",
  [string[]] $Env = @(),
  [string] $Desktop = "pikara-test",
  [string] $PidFile = "",
  [string] $ExitFile = "",
  [switch] $Wait
)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HiddenDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr mode, int flags, uint access, IntPtr sa);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
"@
foreach ($kv in $Env) { $k, $v = $kv -split "=", 2; [Environment]::SetEnvironmentVariable($k, $v, "Process") }

$GENERIC_ALL = 0x10000000
$hDesk = [HiddenDesktop]::CreateDesktop($Desktop, [IntPtr]::Zero, [IntPtr]::Zero, 0, $GENERIC_ALL, [IntPtr]::Zero)
if ($hDesk -eq [IntPtr]::Zero) { throw "CreateDesktop failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$si = New-Object HiddenDesktop+STARTUPINFO
$si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
$si.lpDesktop = "WinSta0\$Desktop"
$pi = New-Object HiddenDesktop+PROCESS_INFORMATION
$cmd = "`"$Exe`" $Arguments"
$CREATE_NO_WINDOW = 0x08000000
$ok = [HiddenDesktop]::CreateProcess([NullString]::Value, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, $CREATE_NO_WINDOW, [IntPtr]::Zero, (Split-Path $Exe), [ref]$si, [ref]$pi)
if (-not $ok) { throw "CreateProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
if ($PidFile) { Set-Content -Path $PidFile -Value $pi.dwProcessId -Encoding ascii }
if ($Wait) {
  [void][HiddenDesktop]::WaitForSingleObject($pi.hProcess, [uint32]::MaxValue)
  [uint32]$code = 0; [void][HiddenDesktop]::GetExitCodeProcess($pi.hProcess, [ref]$code)
  if ($ExitFile) { Set-Content -Path $ExitFile -Value $code -Encoding ascii }
}
[void][HiddenDesktop]::CloseHandle($pi.hThread); [void][HiddenDesktop]::CloseHandle($pi.hProcess)
