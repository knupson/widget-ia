const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Trae al frente la ventana y la PESTAÑA exacta de consola (Windows Terminal, PowerShell, CMD, VS Code o Claude App)
 * correspondiente a una sesión usando Restart Manager (rstrtmgr.dll) + árbol CIM + wt.exe focus-tab + UIAutomation
 */
function focusSessionWindow({ id, sessionId, pid, provider, surface, workspace, title }) {
  return new Promise((resolve) => {
    const safePid = Number(pid) || 0;
    const safeProvider = String(provider || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const safeSurface = String(surface || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const rawConvId = String(sessionId || id || '')
      .replace(/^agy:/i, '')
      .replace(/^claude:/i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '');

    const lockFilePath =
      safeProvider === 'agy' && rawConvId
        ? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'presence', `${rawConvId}.lock`)
        : '';

    const escapedLockPath = lockFilePath.replace(/'/g, "''");

    const psScript = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Win32Focus {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern IntPtr GetThreadDesktop(uint dwThreadId);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, System.Text.StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const byte VK_CONTROL = 0x11;
    public const byte VK_MENU = 0x12;
    public const byte VK_SHIFT = 0x10;

    public static string GetWindowTitle(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return "";
        System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
        GetWindowText(hWnd, sb, 256);
        return sb.ToString();
    }

    public static string GetCurrentDesktopName() {
        try {
            IntPtr hDesk = GetThreadDesktop(GetCurrentThreadId());
            System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
            int needed = 0;
            if (GetUserObjectInformation(hDesk, 2, sb, 256, out needed)) {
                return sb.ToString();
            }
        } catch {}
        return "unknown";
    }

    public static IntPtr FindMainWindowByPid(int targetPid) {
        IntPtr foundCascadia = IntPtr.Zero;
        IntPtr foundAny = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if ((int)pid == targetPid) {
                System.Text.StringBuilder sb = new System.Text.StringBuilder(128);
                GetClassName(hWnd, sb, 128);
                string cls = sb.ToString();
                if (cls == "CASCADIA_HOSTING_WINDOW_CLASS") {
                    foundCascadia = hWnd;
                    return false;
                }
                if (foundAny == IntPtr.Zero) {
                    foundAny = hWnd;
                }
            }
            return true;
        }, IntPtr.Zero);
        return foundCascadia != IntPtr.Zero ? foundCascadia : foundAny;
    }

    public static List<IntPtr> GetChildWindows(IntPtr parent) {
        List<IntPtr> result = new List<IntPtr>();
        EnumChildWindows(parent, (hWnd, lParam) => {
            result.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static bool IsProcessForeground(IntPtr targetHwnd, int targetPid) {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return false;
        if (fg == targetHwnd) return true;
        uint fgPid = 0;
        GetWindowThreadProcessId(fg, out fgPid);
        return targetPid > 0 && (int)fgPid == targetPid;
    }

    public static void ForceForeground(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        if (IsIconic(hWnd)) {
            ShowWindowAsync(hWnd, 9);
        }
        IntPtr fg = GetForegroundWindow();
        uint dummy = 0;
        uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out dummy) : 0;
        uint targetThread = GetWindowThreadProcessId(hWnd, out dummy);
        uint curThread = GetCurrentThreadId();

        bool attachedFg = false;
        bool attachedTarget = false;
        try {
            // Desbloquear SetForegroundWindow en Windows simulando pulsación de Alt
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

            if (fgThread != 0 && fgThread != curThread) {
                attachedFg = AttachThreadInput(curThread, fgThread, true);
            }
            if (targetThread != 0 && targetThread != curThread) {
                attachedTarget = AttachThreadInput(curThread, targetThread, true);
            }
            BringWindowToTop(hWnd);
            SwitchToThisWindow(hWnd, true);
            SetForegroundWindow(hWnd);
        } finally {
            if (attachedTarget) AttachThreadInput(curThread, targetThread, false);
            if (attachedFg) AttachThreadInput(curThread, fgThread, false);
        }
    }

    public static void SendKey(byte vk, bool up) {
        byte scan = (byte)MapVirtualKey(vk, 0);
        keybd_event(vk, scan, up ? KEYEVENTF_KEYUP : 0, UIntPtr.Zero);
    }

    public static void SwitchTabHotkey(int tabIndex) {
        if (tabIndex < 0 || tabIndex > 8) return;
        byte digitVk = (byte)(0x31 + tabIndex); // '1' (0x31) .. '9' (0x39)
        SendKey(VK_SHIFT, true);
        SendKey(VK_CONTROL, false);
        SendKey(VK_MENU, false);
        System.Threading.Thread.Sleep(25);
        SendKey(digitVk, false);
        System.Threading.Thread.Sleep(25);
        SendKey(digitVk, true);
        System.Threading.Thread.Sleep(15);
        SendKey(VK_MENU, true);
        SendKey(VK_CONTROL, true);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static int GetPidLockingFile(string filePath) {
        uint handle;
        string key = Guid.NewGuid().ToString();
        if (RmStartSession(out handle, 0, key) != 0) return 0;
        try {
            string[] files = new string[] { filePath };
            if (RmRegisterResources(handle, 1, files, 0, IntPtr.Zero, 0, null) != 0) return 0;
            uint needed = 0, count = 0, reason = 0;
            int res = RmGetList(handle, out needed, ref count, null, ref reason);
            if (needed > 0) {
                count = needed;
                RM_PROCESS_INFO[] infos = new RM_PROCESS_INFO[count];
                if (RmGetList(handle, out needed, ref count, infos, ref reason) == 0 && count > 0) {
                    return infos[0].Process.dwProcessId;
                }
            }
        } finally {
            RmEndSession(handle);
        }
        return 0;
    }
}
"@

function Restore-WidgetTopMost() {
    try {
        $wProcs = Get-Process -Name "electron", "AI Pulse Widget" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
        foreach ($wp in $wProcs) {
            [Win32Focus]::SetWindowPos(
                $wp.MainWindowHandle,
                [Win32Focus]::HWND_TOPMOST,
                0, 0, 0, 0,
                ([Win32Focus]::SWP_NOMOVE -bor [Win32Focus]::SWP_NOSIZE -bor [Win32Focus]::SWP_NOACTIVATE)
            ) | Out-Null
        }
    } catch {}
}

function Focus-WindowHandle([IntPtr]$h, [int]$procId = 0, [bool]$restoreTopMost = $true) {
    if ($h -eq [IntPtr]::Zero) { return $false }
    [Win32Focus]::ForceForeground($h)
    if ($procId -gt 0 -and -not [Win32Focus]::IsProcessForeground($h, $procId)) {
        try {
            $wshell = New-Object -ComObject WScript.Shell
            $wshell.AppActivate($procId) | Out-Null
        } catch {}
        [Win32Focus]::ForceForeground($h)
    }
    for ($w = 0; $w -lt 12; $w++) {
        if ([Win32Focus]::IsProcessForeground($h, $procId)) { break }
        Start-Sleep -Milliseconds 25
        [Win32Focus]::ForceForeground($h)
    }
    if ($restoreTopMost) {
        Restore-WidgetTopMost
    }
    return $true
}

function Select-WindowsTerminalTab([IntPtr]$wtHwnd, [int]$wtPid, [int]$tabIndex) {
    if ($wtHwnd -eq [IntPtr]::Zero -or $tabIndex -lt 0) { return "none" }
    $methodUsed = "none"

    # Método 1: UIAutomation sobre TabItem (requiere el mismo nivel de privilegio que WindowsTerminal por UIPI)
    try {
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::TabItem
        )
        $handlesToCheck = New-Object System.Collections.Generic.List[IntPtr]
        $handlesToCheck.Add($wtHwnd)
        foreach ($ch in [Win32Focus]::GetChildWindows($wtHwnd)) {
            $handlesToCheck.Add($ch)
        }

        foreach ($hCheck in $handlesToCheck) {
            try {
                $el = [System.Windows.Automation.AutomationElement]::FromHandle($hCheck)
                if (-not $el) { continue }
                $tabItems = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
                if ($tabItems -and $tabItems.Count -gt $tabIndex) {
                    $targetTab = $tabItems[$tabIndex]
                    $selPattern = $null
                    if ($targetTab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selPattern)) {
                        $selPattern.Select()
                        $methodUsed = "uia($($tabItems.Count))"
                        break
                    }
                    $invPattern = $null
                    if ($targetTab.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invPattern)) {
                        $invPattern.Invoke()
                        $methodUsed = "uia_inv($($tabItems.Count))"
                        break
                    }
                }
            } catch {}
        }
    } catch {}

    # Método 2 (Fallback): Atajo nativo de Windows Terminal Ctrl+Alt+<1..9> si UIAutomation no estuvo disponible
    if ($methodUsed -eq "none" -and $tabIndex -ge 0 -and $tabIndex -le 8) {
        try {
            if (-not [Win32Focus]::IsProcessForeground($wtHwnd, $wtPid)) {
                [Win32Focus]::ForceForeground($wtHwnd)
                Start-Sleep -Milliseconds 30
            }
            if ([Win32Focus]::IsProcessForeground($wtHwnd, $wtPid)) {
                [Win32Focus]::SwitchTabHotkey($tabIndex)
                Start-Sleep -Milliseconds 40
                $methodUsed = "hotkey"
            }
        } catch {}
    }

    return $methodUsed
}

$isCurrentlyAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isCurrentlyAdmin -and $PSCommandPath) {
    $outFile = "$PSCommandPath.out"
    try {
        Start-Process -FilePath "powershell.exe" -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList "-NoProfile -STA -NonInteractive -ExecutionPolicy Bypass -Command \`"& '$PSCommandPath' | Out-File -FilePath '$outFile' -Encoding utf8\`""
        if (Test-Path $outFile) {
            Get-Content $outFile -Raw
            Remove-Item $outFile -Force -ErrorAction SilentlyContinue
            exit 0
        }
    } catch {}
}

$targetPid = ${safePid}
$provider = "${safeProvider}"
$surface = "${safeSurface}"
$lockPath = '${escapedLockPath}'

# 0. Si es una sesión de Claude Desktop App, enfocar o restaurar desde bandeja la app de escritorio de Claude
if ($provider -eq "claude" -and $surface -eq "app") {
    $appWin = Get-Process -Name "claude" -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowHandle -ne 0 -and $_.Path -match "AnthropicClaude"
    } | Select-Object -First 1
    if (-not $appWin) {
        $appExe = (Get-Process -Name "claude" -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -match "AnthropicClaude"
        } | Select-Object -First 1).Path
        if ($appExe -and (Test-Path $appExe)) {
            Start-Process -FilePath $appExe | Out-Null
            Start-Sleep -Milliseconds 350
            $appWin = Get-Process -Name "claude" -ErrorAction SilentlyContinue | Where-Object {
                $_.MainWindowHandle -ne 0 -and $_.Path -match "AnthropicClaude"
            } | Select-Object -First 1
        }
    }
    if ($appWin) {
        Focus-WindowHandle $appWin.MainWindowHandle $appWin.Id | Out-Null
        Write-Output "focused_claude_app:$($appWin.Id)"
        exit 0
    }
}

# 1. Si es AGY y tenemos archivo .lock, consultar al Restart Manager de Windows qué PID exacto de agy.exe lo tiene bloqueado
if ($targetPid -le 0 -and $lockPath -ne "" -and (Test-Path $lockPath)) {
    try {
        $lockedByPid = [Win32Focus]::GetPidLockingFile($lockPath)
        if ($lockedByPid -gt 0) {
            $targetPid = $lockedByPid
        }
    } catch {}
}

$allProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue

# 2. Si aún no tenemos PID vivo, resolver el proceso CLI de claude.exe o agy.exe automáticamente
if ($targetPid -le 0 -or -not ($allProcs | Where-Object { $_.ProcessId -eq $targetPid })) {
    if ($provider -eq "agy") {
        $agyProc = $allProcs | Where-Object { $_.Name -match "^agy(\\.exe)?$" } | Sort-Object CreationDate -Descending | Select-Object -First 1
        if ($agyProc) { $targetPid = [int]$agyProc.ProcessId }
    } elseif ($provider -eq "claude") {
        $clProc = $allProcs | Where-Object {
            $_.Name -match "^claude(\\.exe)?$" -and $_.CommandLine -notmatch "AnthropicClaude"
        } | Sort-Object CreationDate -Descending | Select-Object -First 1
        if ($clProc) { $targetPid = [int]$clProc.ProcessId }
    }
}

# 3. Subir por el árbol de procesos desde $targetPid para detectar si corre dentro de una pestaña de WindowsTerminal.exe
if ($targetPid -gt 0 -and $allProcs) {
    $curr = $targetPid
    $shellPid = 0
    $wtPid = 0

    for ($i = 0; $i -lt 8; $i++) {
        $proc = $allProcs | Where-Object { $_.ProcessId -eq $curr } | Select-Object -First 1
        if (-not $proc) { break }
        $parent = $allProcs | Where-Object { $_.ProcessId -eq $proc.ParentProcessId } | Select-Object -First 1
        if (-not $parent) { break }

        if ($parent.Name -match "^WindowsTerminal") {
            $shellPid = [int]$proc.ProcessId
            $wtPid = [int]$parent.ProcessId
            break
        }
        $curr = [int]$parent.ProcessId
    }

    if ($wtPid -gt 0 -and $shellPid -gt 0) {
        # Calcular el índice exacto de pestaña (0-based) según el orden de creación de las shells hijas de WindowsTerminal
        $shells = @($allProcs | Where-Object {
            $_.ParentProcessId -eq $wtPid -and (
                $_.ProcessId -eq $shellPid -or
                $_.Name -match "^(pwsh|powershell|cmd|wsl|bash|zsh|fish|nu|sh|ubuntu|debian|kali|opensuse|alpine|agy|claude)(\.exe)?$"
            )
        } | Sort-Object CreationDate)

        $tabIndex = -1
        for ($j = 0; $j -lt $shells.Count; $j++) {
            if ([int]$shells[$j].ProcessId -eq $shellPid) {
                $tabIndex = $j
                break
            }
        }

        $wtProc = Get-Process -Id $wtPid -ErrorAction SilentlyContinue
        $wtHwnd = if ($wtProc -and $wtProc.MainWindowHandle -ne 0) { $wtProc.MainWindowHandle } else { [Win32Focus]::FindMainWindowByPid($wtPid) }
        if ($wtHwnd -ne [IntPtr]::Zero) {
            Focus-WindowHandle $wtHwnd $wtPid $false | Out-Null
            Start-Sleep -Milliseconds 35
        }

        if ($tabIndex -ge 0) {
            $tabMethod = "none"
            if ($wtHwnd -ne [IntPtr]::Zero) {
                $tabMethod = Select-WindowsTerminalTab $wtHwnd $wtPid $tabIndex
            }
            Start-Sleep -Milliseconds 40
            Restore-WidgetTopMost
            $deskName = [Win32Focus]::GetCurrentDesktopName()
            Write-Output "focused_wt_tab:\${wtPid}:tab=\${tabIndex}:shell=\${shellPid}:pid=\${targetPid}:hwnd=\${wtHwnd}:desk=\${deskName}:method=\${tabMethod}"
            exit 0
        }

        Restore-WidgetTopMost
    }

    # Si no es WindowsTerminal, subir por el árbol buscando cualquier proceso padre con ventana propia
    $curr = $targetPid
    for ($i = 0; $i -lt 6; $i++) {
        $p = Get-Process -Id $curr -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowHandle -ne 0) {
            Focus-WindowHandle $p.MainWindowHandle $p.Id | Out-Null
            Write-Output "focused_pid_tree:$($p.ProcessName):$($p.Id)"
            exit 0
        }
        $proc = $allProcs | Where-Object { $_.ProcessId -eq $curr } | Select-Object -First 1
        if (-not $proc -or -not $proc.ParentProcessId -or $proc.ParentProcessId -eq $curr) { break }
        $curr = [int]$proc.ParentProcessId
    }
}

# 4. Fallback general
$candidates = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.ProcessName -match "WindowsTerminal|pwsh|powershell|cmd|Claude|Code"
} | Sort-Object -Property @{Expression={
    if ($_.ProcessName -match "WindowsTerminal") { 0 }
    elseif ($provider -eq "claude" -and $_.ProcessName -match "Claude") { 1 }
    else { 2 }
}}

if ($candidates -and $candidates.Count -gt 0) {
    $win = $candidates[0]
    Focus-WindowHandle $win.MainWindowHandle $win.Id | Out-Null
    Write-Output "focused_candidate:$($win.ProcessName)"
    exit 0
}

Write-Output "not_found"
`;

    const tmpScript = path.join(
      os.tmpdir(),
      `ai-pulse-focus-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.ps1`
    );
    try {
      fs.writeFileSync(tmpScript, psScript, 'utf8');
    } catch (e) {
      resolve({ ok: false, reason: e.message });
      return;
    }

    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpScript],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        try {
          fs.unlinkSync(tmpScript);
        } catch {}
        if (err) {
          resolve({ ok: false, reason: err.message });
          return;
        }
        const out = String(stdout || '').trim();
        resolve({ ok: out.startsWith('focused_'), detail: out });
      }
    );
  });
}

module.exports = {
  focusSessionWindow
};
