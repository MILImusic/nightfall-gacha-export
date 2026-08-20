param(
  [int]$ClickCount = 300,
  [int]$DelayMilliseconds = 200
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class NightfallMouse {
  [StructLayout(LayoutKind.Sequential)]
  public struct Point { public int X; public int Y; }

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out Point point);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@

$point = New-Object NightfallMouse+Point
if (-not [NightfallMouse]::GetCursorPos([ref]$point)) { throw "无法读取鼠标位置" }

for ($index = 0; $index -lt $ClickCount; $index++) {
  [NightfallMouse]::SetCursorPos($point.X, $point.Y) | Out-Null
  [NightfallMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [NightfallMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $DelayMilliseconds
}
