/**
 * Generador de Icono Nativo (.ico) y Compilador del Ejecutable GUI (AI Pulse Widget.exe)
 * - Crea assets/icon.ico en alta definición (paleta Obsidiana + Naranja + Ocre)
 * - Compila src/launcher/Launcher.cs -> "AI Pulse Widget.exe" (/target:winexe, sin consola negra)
 * - Crea accesos directos (.lnk) en Escritorio y Menú Inicio de Windows
 * - Elimina el antiguo Iniciar-Widget.bat
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const LAUNCHER_DIR = path.join(ROOT_DIR, 'src', 'launcher');
const ICON_PATH = path.join(ASSETS_DIR, 'icon.ico');
const CS_PATH = path.join(LAUNCHER_DIR, 'Launcher.cs');
const EXE_PATH = path.join(ROOT_DIR, 'AI Pulse Widget.exe');
const OLD_BAT_PATH = path.join(ROOT_DIR, 'Iniciar-Widget.bat');

function createBmpFrame(size) {
  const xorSize = size * size * 4;
  const andRowBytes = Math.ceil(size / 32) * 4;
  const andSize = andRowBytes * size;
  const headerSize = 40;
  const buf = Buffer.alloc(headerSize + xorSize + andSize, 0);

  // BITMAPINFOHEADER
  buf.writeUInt32LE(headerSize, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8); // Altura combinada XOR + AND
  buf.writeUInt16LE(1, 12); // Planes
  buf.writeUInt16LE(32, 14); // 32-bit BGRA
  buf.writeUInt32LE(0, 16); // BI_RGB
  buf.writeUInt32LE(xorSize + andSize, 20);

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const maxR = size / 2;

  for (let y = 0; y < size; y++) {
    // En BMP las filas van de abajo hacia arriba
    const bmpY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const norm = dist / maxR;

      const offset = headerSize + (bmpY * size + x) * 4;

      if (norm > 0.96) {
        // Transparente fuera del círculo
        buf[offset] = 0;
        buf[offset + 1] = 0;
        buf[offset + 2] = 0;
        buf[offset + 3] = 0;
        continue;
      }

      // Antialiasing en el borde exterior
      let alpha = 255;
      if (norm > 0.90) {
        alpha = Math.round(((0.96 - norm) / 0.06) * 255);
      }

      let r = 12, g = 9, b = 6; // Fondo obsidiana (#0c0906)

      if (norm >= 0.72 && norm <= 0.90) {
        // Anillo exterior Naranja Fundido (#ff6b1a -> #ea580c)
        const t = (norm - 0.72) / 0.18;
        r = Math.round(255 - t * 20);
        g = Math.round(115 - t * 25);
        b = Math.round(28 - t * 12);
      } else if (norm >= 0.56 && norm < 0.72) {
        // Surco oscuro con resplandor ámbar
        const glow = Math.max(0, 1 - Math.abs(norm - 0.64) / 0.08);
        r = Math.round(18 + glow * 90);
        g = Math.round(13 + glow * 45);
        b = Math.round(9 + glow * 10);
      } else if (norm < 0.42) {
        // Núcleo Ocre / Dorado brillante (#facc15 -> #ff6b1a)
        const coreT = norm / 0.42;
        r = 255;
        g = Math.round(215 - coreT * 95);
        b = Math.round(45 - coreT * 20);
      }

      // Pequeño destello superior izquierdo
      if (dx < -size * 0.08 && dy < -size * 0.08 && norm < 0.35) {
        r = Math.min(255, r + 30);
        g = Math.min(255, g + 35);
        b = Math.min(255, b + 40);
      }

      buf[offset] = b;
      buf[offset + 1] = g;
      buf[offset + 2] = r;
      buf[offset + 3] = alpha;
    }
  }

  return buf;
}

function generateIcoFile(destPath) {
  const sizes = [64, 32, 16];
  const frames = sizes.map((s) => ({ size: s, data: createBmpFrame(s) }));

  const iconDirSize = 6 + frames.length * 16;
  const totalSize = iconDirSize + frames.reduce((acc, f) => acc + f.data.length, 0);
  const ico = Buffer.alloc(totalSize, 0);

  // ICONDIR header
  ico.writeUInt16LE(0, 0); // Reserved
  ico.writeUInt16LE(1, 2); // Type 1 = ICO
  ico.writeUInt16LE(frames.length, 4); // Count

  let dataOffset = iconDirSize;
  frames.forEach((f, idx) => {
    const entryOffset = 6 + idx * 16;
    ico.writeUInt8(f.size === 256 ? 0 : f.size, entryOffset);
    ico.writeUInt8(f.size === 256 ? 0 : f.size, entryOffset + 1);
    ico.writeUInt8(0, entryOffset + 2); // Palette
    ico.writeUInt8(0, entryOffset + 3); // Reserved
    ico.writeUInt16LE(1, entryOffset + 4); // Color planes
    ico.writeUInt16LE(32, entryOffset + 6); // Bits per pixel
    ico.writeUInt32LE(f.data.length, entryOffset + 8); // Size of image data
    ico.writeUInt32LE(dataOffset, entryOffset + 12); // Offset

    f.data.copy(ico, dataOffset);
    dataOffset += f.data.length;
  });

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, ico);
  console.log(`[Build] Icono nativo generado en: ${destPath}`);
}

function writeLauncherCs(csPath) {
  const code = `using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AIPulseLauncher
{
    internal static class Program
    {
        private const string BaseUrl = "http://127.0.0.1:19876";

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool forceRestart = false;
            foreach (string a in args)
            {
                if (string.Equals(a, "--restart", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "-r", StringComparison.OrdinalIgnoreCase))
                {
                    forceRestart = true;
                }
            }

            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string electronExe = Path.Combine(appDir, "node_modules", "electron", "dist", "electron.exe");

            if (!File.Exists(electronExe))
            {
                MessageBox.Show(
                    "No se encontró el motor Electron en:\\n" + electronExe + "\\n\\nEjecutá 'npm install' en la carpeta del proyecto.",
                    "AI Pulse Widget",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            bool isRunning = CheckServerAlive();

            if (isRunning)
            {
                // Cerrar limpiamente cualquier instancia previa para evitar duplicados y asegurar código fresco
                PostJson(BaseUrl + "/api/window/control", "{\\"action\\":\\"quit\\"}");
                for (int i = 0; i < 12; i++)
                {
                    Thread.Sleep(120);
                    if (!CheckServerAlive()) break;
                }
            }

            // Mostrar mini-HUD de arranque con estética Obsidiana / Naranja / Ocre mientras despega Electron
            using (SplashForm splash = new SplashForm(appDir, electronExe))
            {
                Application.Run(splash);
            }
        }

        private static bool CheckServerAlive()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/state");
                req.Method = "GET";
                req.Timeout = 450;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return res.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        public static bool PostJson(string url, string json)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = 600;
                byte[] data = Encoding.UTF8.GetBytes(json);
                req.ContentLength = data.Length;
                using (Stream s = req.GetRequestStream())
                {
                    s.Write(data, 0, data.Length);
                }
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return res.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }
    }

    internal sealed class SplashForm : Form
    {
        private readonly string _appDir;
        private readonly string _electronExe;
        private readonly System.Windows.Forms.Timer _timer;
        private int _ticks = 0;

        public SplashForm(string appDir, string electronExe)
        {
            _appDir = appDir;
            _electronExe = electronExe;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(340, 88);
            BackColor = Color.FromArgb(12, 9, 6);
            ForeColor = Color.FromArgb(250, 244, 237);
            TopMost = true;
            ShowInTaskbar = false;
            DoubleBuffered = true;

            string icoPath = Path.Combine(_appDir, "assets", "icon.ico");
            if (File.Exists(icoPath))
            {
                try { Icon = new Icon(icoPath); } catch { }
            }

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 60;
            _timer.Tick += OnTick;
            Load += OnLoad;
        }

        private void OnLoad(object sender, EventArgs e)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = _electronExe,
                    Arguments = ".",
                    WorkingDirectory = _appDir,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error al iniciar AI Pulse Widget: " + ex.Message, "AI Pulse Widget");
                Close();
                return;
            }

            _timer.Start();
        }

        private void OnTick(object sender, EventArgs e)
        {
            _ticks++;
            Invalidate();
            if (_ticks >= 16)
            {
                _timer.Stop();
                Close();
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (LinearGradientBrush bg = new LinearGradientBrush(
                rect,
                Color.FromArgb(22, 16, 11),
                Color.FromArgb(9, 7, 5),
                LinearGradientMode.ForwardDiagonal))
            {
                g.FillRectangle(bg, rect);
            }

            // Borde naranja/ocre
            using (Pen borderPen = new Pen(Color.FromArgb(180, 255, 107, 26), 1.5f))
            {
                g.DrawRectangle(borderPen, 1, 1, Width - 3, Height - 3);
            }

            // Orbe pulsante
            float pulse = (float)(Math.Sin(_ticks * 0.45) * 2.0 + 14.0);
            using (SolidBrush glowBrush = new SolidBrush(Color.FromArgb(65, 255, 107, 26)))
            {
                g.FillEllipse(glowBrush, 26 - pulse, 44 - pulse, pulse * 2, pulse * 2);
            }
            using (SolidBrush coreBrush = new SolidBrush(Color.FromArgb(255, 107, 26)))
            {
                g.FillEllipse(coreBrush, 19, 37, 14, 14);
            }
            using (SolidBrush innerBrush = new SolidBrush(Color.FromArgb(250, 204, 21)))
            {
                g.FillEllipse(innerBrush, 23, 41, 6, 6);
            }

            // Texto principal
            using (Font titleFont = new Font("Segoe UI", 11.5f, FontStyle.Bold))
            using (SolidBrush titleBrush = new SolidBrush(Color.FromArgb(255, 247, 237)))
            {
                g.DrawString("AI PULSE WIDGET", titleFont, titleBrush, 48, 22);
            }

            using (Font subFont = new Font("Segoe UI", 8.5f, FontStyle.Regular))
            using (SolidBrush subBrush = new SolidBrush(Color.FromArgb(224, 159, 62)))
            {
                g.DrawString("Iniciando HUD · Claude & Antigravity (AGY)...", subFont, subBrush, 49, 45);
            }

            // Barra inferior de carga
            int barWidth = (int)((Width - 4) * Math.Min(1.0, _ticks / 15.0));
            using (LinearGradientBrush barBrush = new LinearGradientBrush(
                new Rectangle(2, Height - 5, Width - 4, 3),
                Color.FromArgb(255, 107, 26),
                Color.FromArgb(250, 204, 21),
                LinearGradientMode.Horizontal))
            {
                g.FillRectangle(barBrush, 2, Height - 5, Math.Max(10, barWidth), 3);
            }
        }
    }
}
`;

  fs.mkdirSync(path.dirname(csPath), { recursive: true });
  fs.writeFileSync(csPath, code, 'utf8');
}

function compileExe() {
  const cscCandidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
  ];
  const csc = cscCandidates.find((p) => fs.existsSync(p));
  if (!csc) {
    throw new Error('No se encontró csc.exe de .NET Framework v4.0.30319');
  }

  execFileSync(
    csc,
    [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      `/win32icon:${ICON_PATH}`,
      `/out:${EXE_PATH}`,
      '/r:System.dll',
      '/r:System.Drawing.dll',
      '/r:System.Windows.Forms.dll',
      CS_PATH
    ],
    { stdio: 'inherit', windowsHide: true }
  );
  console.log(`[Build] Ejecutable nativo compilado con éxito: ${EXE_PATH}`);
}

function createWindowsShortcuts() {
  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$exePath = '${EXE_PATH.replace(/'/g, "''")}'
$workDir = '${ROOT_DIR.replace(/'/g, "''")}'
$iconPath = '${ICON_PATH.replace(/'/g, "''")}'

$desktopDir = [Environment]::GetFolderPath('Desktop')
$startMenuDir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'

foreach ($dir in @($desktopDir, $startMenuDir)) {
  if ($dir -and (Test-Path $dir)) {
    $lnkPath = Join-Path $dir 'AI Pulse Widget.lnk'
    $sc = $WshShell.CreateShortcut($lnkPath)
    $sc.TargetPath = $exePath
    $sc.WorkingDirectory = $workDir
    $sc.IconLocation = "$iconPath,0"
    $sc.Description = 'AI Pulse Widget - Monitor HUD para Claude y Google Antigravity (AGY)'
    $sc.Save()
    Write-Output "Shortcut creado: $lnkPath"
  }
}
`;
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    { stdio: 'inherit', windowsHide: true }
  );
}

function main() {
  generateIcoFile(ICON_PATH);
  writeLauncherCs(CS_PATH);
  compileExe();

  if (fs.existsSync(OLD_BAT_PATH)) {
    fs.unlinkSync(OLD_BAT_PATH);
    console.log(`[Build] Eliminado antiguo archivo .bat: ${OLD_BAT_PATH}`);
  }

  createWindowsShortcuts();
}

main();
