const { execFile } = require('child_process');
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
using System.Runtime.InteropServices;

public class Win32Focus {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

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

function Focus-WindowHandle([IntPtr]$h, [int]$procId = 0) {
    if ($h -eq [IntPtr]::Zero) { return $false }
    if ([Win32Focus]::IsIconic($h)) {
        [Win32Focus]::ShowWindowAsync($h, 9) | Out-Null
    }
    [Win32Focus]::SwitchToThisWindow($h, $true)
    [Win32Focus]::SetForegroundWindow($h) | Out-Null
    if ($procId -gt 0) {
        try {
            $wshell = New-Object -ComObject WScript.Shell
            $wshell.AppActivate($procId) | Out-Null
        } catch {}
    }
    return $true
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
            $_.ParentProcessId -eq $wtPid -and $_.Name -notmatch "^OpenConsole"
        } | Sort-Object CreationDate)

        $tabIndex = -1
        for ($j = 0; $j -lt $shells.Count; $j++) {
            if ([int]$shells[$j].ProcessId -eq $shellPid) {
                $tabIndex = $j
                break
            }
        }

        $wtProc = Get-Process -Id $wtPid -ErrorAction SilentlyContinue
        if ($wtProc -and $wtProc.MainWindowHandle -ne 0) {
            Focus-WindowHandle $wtProc.MainWindowHandle $wtPid | Out-Null
        }

        if ($tabIndex -ge 0) {
            try {
                Start-Process -FilePath "wt.exe" -ArgumentList @("-w", "0", "focus-tab", "-t", "$tabIndex") -WindowStyle Hidden -ErrorAction SilentlyContinue
            } catch {}

            try {
                Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
                if ($wtProc -and $wtProc.MainWindowHandle -ne 0) {
                    $rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($wtProc.MainWindowHandle)
                    if ($rootEl) {
                        $cond = New-Object System.Windows.Automation.PropertyCondition(
                            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                            [System.Windows.Automation.ControlType]::TabItem
                        )
                        $tabItems = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
                        if ($tabItems -and $tabIndex -lt $tabItems.Count) {
                            $targetTab = $tabItems[$tabIndex]
                            $selPattern = $null
                            if ($targetTab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selPattern)) {
                                $selPattern.Select()
                            }
                        }
                    }
                }
            } catch {}

            Write-Output "focused_wt_tab:\${wtPid}:tab=\${tabIndex}:shell=\${shellPid}:pid=\${targetPid}"
            exit 0
        }
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

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeout: 4500 },
      (err, stdout) => {
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
