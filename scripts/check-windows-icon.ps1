param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Executable
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path $Executable).Path

# Inspect the PE resource directory through Win32 rather than trusting the build script.
if (-not ('JAgent.ResourceProbe' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ResourceProbe {
  public delegate bool EnumResNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
  [DllImport("kernel32", SetLastError=true)]
  public static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32", SetLastError=true)]
  public static extern IntPtr LockResource(IntPtr resource);
  [DllImport("kernel32", SetLastError=true)]
  public static extern uint SizeofResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr LoadLibraryEx(string file, IntPtr fileHandle, uint flags);
  [DllImport("kernel32", SetLastError=true)]
  public static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResNameProc callback, IntPtr parameter);
}
'@
}

$LOAD_LIBRARY_AS_DATAFILE = 0x00000002
$RT_GROUP_ICON = [IntPtr]14
$module = [ResourceProbe]::LoadLibraryEx($resolved, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
if ($module -eq [IntPtr]::Zero) { throw "LoadLibraryEx failed for $resolved (win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
$group = [ResourceProbe]::FindResource($module, [IntPtr]1, $RT_GROUP_ICON)
if ($group -eq [IntPtr]::Zero) {
  [void][ResourceProbe]::FreeLibrary($module)
  throw "RT_GROUP_ICON ordinal 1 not found in $resolved"
}
$size = [ResourceProbe]::SizeofResource($module, $group)
$loaded = [ResourceProbe]::LoadResource($module, $group)
$pointer = [ResourceProbe]::LockResource($loaded)
if ($size -lt 20 -or $pointer -eq [IntPtr]::Zero) {
  [void][ResourceProbe]::FreeLibrary($module)
  throw "RT_GROUP_ICON #1 resource is empty or malformed (size=$size)"
}
$count = [Runtime.InteropServices.Marshal]::ReadInt16($pointer, 4)
[void][ResourceProbe]::FreeLibrary($module)
if ($count -lt 1) { throw "RT_GROUP_ICON #1 has no image frames" }
Write-Host "Windows RT_GROUP_ICON #1 verified ($count frames) in $resolved"
