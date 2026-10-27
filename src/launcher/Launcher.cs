using System;
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
                    "No se encontró el motor Electron en:\n" + electronExe + "\n\nEjecutá 'npm install' en la carpeta del proyecto.",
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
                PostJson(BaseUrl + "/api/window/control", "{\"action\":\"quit\"}");
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
