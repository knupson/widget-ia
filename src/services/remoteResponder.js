const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Acciones rápidas permitidas: deben coincidir con el switch de quickAction del script PowerShell
const QUICK_ACTIONS = new Set(['approve', 'enter', 'option1', 'option2', 'option3', 'reject', 'escape']);

/**
 * Script temporal en un directorio por usuario (LOCALAPPDATA) con nombre aleatorio.
 * El llamador lo borra después de usarlo.
 */
function writeTempScript(prefix, content) {
  const base = process.env.LOCALAPPDATA || os.homedir();
  const dir = path.join(base, 'AI Pulse Widget', 'run');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${crypto.randomBytes(12).toString('hex')}.ps1`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * Resuelve un ejecutable de claude sin usar shell: claude.exe directo, o el cli.js
 * del shim npm (claude.cmd) ejecutado con node. Devuelve null si no lo encuentra.
 */
function resolveClaudeCommand(cb) {
  execFile('where', ['claude'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
    if (err) return cb(null);
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const exe = lines.find((l) => /\.exe$/i.test(l));
    if (exe) return cb({ file: exe, prefix: [] });
    const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l));
    if (shim) {
      const cli = path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (fs.existsSync(cli)) return cb({ file: 'node', prefix: [cli] });
    }
    cb(null);
  });
}

/**
 * Envía una respuesta remota o acción rápida (Aprobar y/Enter, 1/2/3, Esc, o prompt de texto)
 * directamente al buffer de entrada de consola (CONIN$ via AttachConsole + WriteConsoleInput)
 * del proceso exacto (agy.exe / claude.exe), con fallback a inyección Win32 en ventana activa.
 */
function sendSessionReply({
  id,
  sessionId,
  pid,
  provider,
  surface,
  workspace,
  isOpen,
  text = '',
  quickAction = ''
}) {
  return new Promise((resolve) => {
    const safePid = Number(pid) || 0;
    const safeProvider = String(provider || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const safeSurface = String(surface || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const rawConvId = String(sessionId || id || '')
      .replace(/^agy:/i, '')
      .replace(/^claude:/i, '')
      .replace(/^claude-app:/i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '');

    const cleanText = String(text || '').trim();
    const cleanAction = String(quickAction || '').trim().toLowerCase();

    if (cleanAction && !QUICK_ACTIONS.has(cleanAction)) {
      resolve({ ok: false, error: 'Acción no permitida' });
      return;
    }

    if (!cleanText && !cleanAction) {
      resolve({ ok: false, error: 'Mensaje o acción vacía' });
      return;
    }

    const lockFilePath =
      safeProvider === 'agy' && rawConvId
        ? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'presence', `${rawConvId}.lock`)
        : '';

    const escapedLockPath = lockFilePath.replace(/'/g, "''");
    const b64Text = Buffer.from(cleanText, 'utf8').toString('base64');
    const b64Action = Buffer.from(cleanAction, 'utf8').toString('base64');

    const psScript = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public class Win32Injector {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool WriteConsoleInput(
        IntPtr hConsoleInput,
        INPUT_RECORD[] lpBuffer,
        uint nLength,
        out uint lpNumberOfEventsWritten);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern short VkKeyScan(char ch);

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
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const byte VK_RETURN = 0x0D;
    public const byte VK_ESCAPE = 0x1B;
    public const byte VK_CONTROL = 0x11;
    public const byte VK_MENU = 0x12;
    public const byte VK_SHIFT = 0x10;
    public const byte VK_V = 0x56;
    public const byte VK_Y = 0x59;
    public const byte VK_N = 0x4E;
    public const byte VK_1 = 0x31;
    public const byte VK_2 = 0x32;
    public const byte VK_3 = 0x33;

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_RECORD {
        [FieldOffset(0)]
        public ushort EventType;
        [FieldOffset(4)]
        public KEY_EVENT_RECORD KeyEvent;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD {
        [MarshalAs(UnmanagedType.Bool)]
        public bool bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    public static INPUT_RECORD MakeCharKey(bool down, char ch) {
        short vks = VkKeyScan(ch);
        ushort vk = vks != -1 ? (ushort)(vks & 0xFF) : (ushort)0;
        INPUT_RECORD r = new INPUT_RECORD();
        r.EventType = 1;
        r.KeyEvent.bKeyDown = down;
        r.KeyEvent.wRepeatCount = 1;
        r.KeyEvent.wVirtualKeyCode = vk;
        r.KeyEvent.wVirtualScanCode = vk != 0 ? (ushort)MapVirtualKey(vk, 0) : (ushort)0;
        r.KeyEvent.UnicodeChar = ch;
        r.KeyEvent.dwControlKeyState = 0;
        return r;
    }

    public static INPUT_RECORD MakeVkKey(bool down, ushort vk, char ch) {
        INPUT_RECORD r = new INPUT_RECORD();
        r.EventType = 1;
        r.KeyEvent.bKeyDown = down;
        r.KeyEvent.wRepeatCount = 1;
        r.KeyEvent.wVirtualKeyCode = vk;
        r.KeyEvent.wVirtualScanCode = (ushort)MapVirtualKey(vk, 0);
        r.KeyEvent.UnicodeChar = ch;
        r.KeyEvent.dwControlKeyState = 0;
        return r;
    }

    public static int WriteDirectToConsolePid(uint pid, string text, bool sendEnter, bool sendEsc) {
        FreeConsole();
        if (!AttachConsole(pid)) return -1;
        IntPtr hIn = CreateFile("CONIN$", 0x80000000u | 0x40000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
        if (hIn == IntPtr.Zero || hIn == new IntPtr(-1)) {
            FreeConsole();
            return -2;
        }
        try {
            uint totalWritten = 0;
            if (sendEsc) {
                INPUT_RECORD[] escRecs = new INPUT_RECORD[] {
                    MakeVkKey(true, VK_ESCAPE, (char)27),
                    MakeVkKey(false, VK_ESCAPE, (char)27)
                };
                uint wEsc = 0;
                WriteConsoleInput(hIn, escRecs, 2, out wEsc);
                totalWritten += wEsc;
                return (int)totalWritten;
            }
            if (!string.IsNullOrEmpty(text)) {
                INPUT_RECORD[] recs = new INPUT_RECORD[text.Length * 2];
                for (int i = 0; i < text.Length; i++) {
                    char c = text[i];
                    recs[i * 2] = MakeCharKey(true, c);
                    recs[i * 2 + 1] = MakeCharKey(false, c);
                }
                uint w = 0;
                WriteConsoleInput(hIn, recs, (uint)recs.Length, out w);
                totalWritten += w;
            }
            if (sendEnter) {
                // Pausa de 90ms entre el texto y Enter para que TUI (AGY / Claude Ink) no lo tome como salto de línea pegado sino como Submit
                Thread.Sleep(90);
                INPUT_RECORD[] enterRecs = new INPUT_RECORD[] {
                    MakeVkKey(true, VK_RETURN, '\\r'),
                    MakeVkKey(false, VK_RETURN, '\\r')
                };
                uint w2 = 0;
                WriteConsoleInput(hIn, enterRecs, 2, out w2);
                totalWritten += w2;
            }
            return (int)totalWritten;
        } finally {
            CloseHandle(hIn);
            FreeConsole();
        }
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

    public static void TapKey(byte vk) {
        SendKey(vk, false);
        Thread.Sleep(25);
        SendKey(vk, true);
    }

    public static void PasteCtrlV() {
        SendKey(VK_CONTROL, false);
        Thread.Sleep(25);
        SendKey(VK_V, false);
        Thread.Sleep(25);
        SendKey(VK_V, true);
        Thread.Sleep(25);
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

$isCurrentlyAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Send-ForegroundGuiInput([string]$action, [string]$b64Payload) {
    Start-Sleep -Milliseconds 180
    if ($action -ne "") {
        switch ($action) {
            "approve" {
                [Win32Injector]::TapKey([Win32Injector]::VK_Y)
                Start-Sleep -Milliseconds 50
                [Win32Injector]::TapKey([Win32Injector]::VK_RETURN)
            }
            "enter"   { [Win32Injector]::TapKey([Win32Injector]::VK_RETURN) }
            "option1" { [Win32Injector]::TapKey([Win32Injector]::VK_1); Start-Sleep -Milliseconds 50; [Win32Injector]::TapKey([Win32Injector]::VK_RETURN) }
            "option2" { [Win32Injector]::TapKey([Win32Injector]::VK_2); Start-Sleep -Milliseconds 50; [Win32Injector]::TapKey([Win32Injector]::VK_RETURN) }
            "option3" { [Win32Injector]::TapKey([Win32Injector]::VK_3); Start-Sleep -Milliseconds 50; [Win32Injector]::TapKey([Win32Injector]::VK_RETURN) }
            "reject"  { [Win32Injector]::TapKey([Win32Injector]::VK_N); Start-Sleep -Milliseconds 50; [Win32Injector]::TapKey([Win32Injector]::VK_RETURN) }
            "escape"  { [Win32Injector]::TapKey([Win32Injector]::VK_ESCAPE) }
        }
        return
    }
    if ($b64Payload -ne "") {
        $textBytes = [System.Convert]::FromBase64String($b64Payload)
        $replyText = [System.Text.Encoding]::UTF8.GetString($textBytes)
        $prevClip = $null
        try { $prevClip = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
        Set-Clipboard -Value $replyText
        Start-Sleep -Milliseconds 70
        [Win32Injector]::PasteCtrlV()
        Start-Sleep -Milliseconds 130
        [Win32Injector]::TapKey([Win32Injector]::VK_RETURN)
        if ($null -ne $prevClip) {
            Start-Sleep -Milliseconds 250
            try { Set-Clipboard -Value $prevClip -ErrorAction SilentlyContinue } catch {}
        }
    }
}

$targetPid = ${safePid}
$provider = "${safeProvider}"
$surface = "${safeSurface}"
$lockPath = '${escapedLockPath}'
$quickAction = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${b64Action}"))
$b64Text = "${b64Text}"

# 0. Si es Claude Desktop App (interfaz gráfica Electron)
if ($provider -eq "claude" -and $surface -eq "app") {
    $appWin = Get-Process -Name "claude" -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowHandle -ne 0 -and $_.Path -match "AnthropicClaude"
    } | Select-Object -First 1
    if ($appWin) {
        [Win32Injector]::ForceForeground($appWin.MainWindowHandle)
        Send-ForegroundGuiInput $quickAction $b64Text
        Write-Output "sent_claude_app:$($appWin.Id)"
        exit 0
    }
}

# 1. Si es AGY con archivo .lock, consultar al Restart Manager de Windows qué PID exacto lo tiene abierto
if ($targetPid -le 0 -and $lockPath -ne "" -and (Test-Path $lockPath)) {
    try {
        $lockedByPid = [Win32Injector]::GetPidLockingFile($lockPath)
        if ($lockedByPid -gt 0) {
            $targetPid = $lockedByPid
        }
    } catch {}
}

$allProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue

# 2. Resolver proceso CLI si aún no tenemos PID
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

# 3. INYECCIÓN DIRECTA AL BUFFER DE CONSOLA (CONIN$) DEL PROCESO EXACTO
# Funciona sin depender del portapapeles, sin importar qué ventana o pestaña esté activa en la PC
if ($targetPid -gt 0) {
    $textToInject = ""
    $sendEnter = $true
    $sendEsc = $false

    if ($quickAction -ne "") {
        switch ($quickAction) {
            "approve" { $textToInject = "y"; $sendEnter = $true }
            "enter"   { $textToInject = "";  $sendEnter = $true }
            "option1" { $textToInject = "1"; $sendEnter = $true }
            "option2" { $textToInject = "2"; $sendEnter = $true }
            "option3" { $textToInject = "3"; $sendEnter = $true }
            "reject"  { $textToInject = "n"; $sendEnter = $true }
            "escape"  { $textToInject = "";  $sendEnter = $false; $sendEsc = $true }
        }
    } elseif ($b64Text -ne "") {
        $textBytes = [System.Convert]::FromBase64String($b64Text)
        $textToInject = [System.Text.Encoding]::UTF8.GetString($textBytes)
        $sendEnter = $true
    }

    # Probar sobre el PID directo (agy.exe / claude.exe) y, si no tiene consola propia, subir al shell padre (pwsh.exe / cmd.exe)
    $pidsToTry = New-Object System.Collections.Generic.List[int]
    $pidsToTry.Add($targetPid)
    if ($allProcs) {
        $curr = $targetPid
        for ($i = 0; $i -lt 4; $i++) {
            $pObj = $allProcs | Where-Object { $_.ProcessId -eq $curr } | Select-Object -First 1
            if (-not $pObj -or -not $pObj.ParentProcessId) { break }
            $parentObj = $allProcs | Where-Object { $_.ProcessId -eq $pObj.ParentProcessId } | Select-Object -First 1
            if (-not $parentObj -or $parentObj.Name -match "^WindowsTerminal") { break }
            $pidsToTry.Add([int]$parentObj.ProcessId)
            $curr = [int]$parentObj.ProcessId
        }
    }

    $denied = $false
    foreach ($candPid in $pidsToTry) {
        $written = [Win32Injector]::WriteDirectToConsolePid([uint32]$candPid, $textToInject, $sendEnter, $sendEsc)
        if ($written -gt 0) {
            Write-Output "sent_conin:pid=\${candPid}:target=\${targetPid}:events=\${written}"
            exit 0
        }
        if ($written -eq -1 -or $written -eq -2) { $denied = $true }
    }

    # Sin elevación no se puede adjuntar a una consola elevada: se informa, no se pide UAC
    if ($denied -and -not $isCurrentlyAdmin) {
        Write-Output "needs_elevation"
        exit 0
    }
}

Write-Output "not_found"
`;

    let tmpScript = '';
    try {
      tmpScript = writeTempScript('ai-pulse-reply', psScript);
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }

    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpScript],
      { timeout: 8500, windowsHide: true },
      (err, stdout) => {
        try {
          fs.unlinkSync(tmpScript);
        } catch {}

        const out = String(stdout || '').trim();
        if (!err && out.startsWith('sent_')) {
          resolve({ ok: true, method: 'console_inject', detail: out });
          return;
        }

        if (out.startsWith('needs_elevation')) {
          resolve({
            ok: false,
            code: 'needs_elevation',
            error: 'La consola de esta sesión corre elevada. Ejecutá el widget como administrador para responder.',
            detail: out
          });
          return;
        }

        // Fallback: si es una sesión de Claude CLI cerrada y enviaron un prompt de texto, reanudar con claude --resume
        if (safeProvider === 'claude' && safeSurface !== 'app' && rawConvId && cleanText) {
          const cwd = workspace && fs.existsSync(workspace) ? workspace : os.homedir();
          resolveClaudeCommand((bin) => {
            if (!bin) {
              resolve({
                ok: false,
                error: 'La consola no está abierta y no se encontró el ejecutable de claude'
              });
              return;
            }
            // Sin shell: el texto viaja como un argv separado, nunca dentro de una cadena de comando
            execFile(
              bin.file,
              [...bin.prefix, '--resume', rawConvId, '-p', cleanText],
              { cwd, timeout: 60000, windowsHide: true, shell: false },
              (clErr, clOut) => {
                if (clErr) {
                  resolve({
                    ok: false,
                    error: 'La consola no está abierta y falló claude --resume: ' + clErr.message
                  });
                } else {
                  resolve({
                    ok: true,
                    method: 'claude_resume_headless',
                    detail: String(clOut || '').slice(0, 300)
                  });
                }
              }
            );
          });
          return;
        }

        resolve({
          ok: false,
          error: err
            ? err.message
            : 'No se encontró una consola activa para esta sesión en tu PC.',
          detail: out
        });
      }
    );
  });
}

module.exports = {
  sendSessionReply
};
