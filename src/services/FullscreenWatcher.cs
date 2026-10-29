using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class FullscreenWatcher
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern uint GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    private const int GWL_STYLE = -16;
    private const uint WS_MAXIMIZE = 0x01000000;
    private const uint WS_CAPTION = 0x00C00000;
    private const uint MONITOR_DEFAULTTONEAREST = 2;

    private static void Main(string[] args)
    {
        int parentPid = 0;
        if (args.Length > 0)
        {
            int.TryParse(args[0], out parentPid);
        }

        Process parentProc = null;
        if (parentPid > 0)
        {
            try
            {
                parentProc = Process.GetProcessById(parentPid);
            }
            catch
            {
                return;
            }
        }

        string lastLine = "";
        StringBuilder sb = new StringBuilder(128);

        while (true)
        {
            if (parentProc != null)
            {
                try
                {
                    if (parentProc.HasExited) break;
                }
                catch
                {
                    break;
                }
            }

            try
            {
                IntPtr hwnd = GetForegroundWindow();
                string line = "NONE";
                if (hwnd != IntPtr.Zero && IsWindowVisible(hwnd) && !IsIconic(hwnd))
                {
                    RECT r;
                    if (GetWindowRect(hwnd, out r))
                    {
                        uint pid = 0;
                        GetWindowThreadProcessId(hwnd, out pid);
                        sb.Clear();
                        GetClassName(hwnd, sb, sb.Capacity);
                        int w = r.Right - r.Left;
                        int h = r.Bottom - r.Top;

                        int isFs = 0;
                        int monX = r.Left;
                        int monY = r.Top;
                        int monW = w;
                        int monH = h;

                        IntPtr hMon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                        if (hMon != IntPtr.Zero)
                        {
                            MONITORINFO mi = new MONITORINFO();
                            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                            if (GetMonitorInfo(hMon, ref mi))
                            {
                                monX = mi.rcMonitor.Left;
                                monY = mi.rcMonitor.Top;
                                monW = mi.rcMonitor.Right - mi.rcMonitor.Left;
                                monH = mi.rcMonitor.Bottom - mi.rcMonitor.Top;

                                bool coversMonitor =
                                    r.Left <= mi.rcMonitor.Left + 2 &&
                                    r.Top <= mi.rcMonitor.Top + 2 &&
                                    r.Right >= mi.rcMonitor.Right - 2 &&
                                    r.Bottom >= mi.rcMonitor.Bottom - 2;

                                uint style = GetWindowLong(hwnd, GWL_STYLE);
                                bool isMaximized = (style & WS_MAXIMIZE) != 0;

                                if (coversMonitor && !isMaximized && monW > 0 && monH > 0)
                                {
                                    isFs = 1;
                                }
                            }
                        }

                        line = string.Format(
                            "{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}|{9}|{10}",
                            hwnd.ToInt64(),
                            r.Left,
                            r.Top,
                            w,
                            h,
                            pid,
                            isFs,
                            monX,
                            monY,
                            monW,
                            monH
                        ) + "|" + sb.ToString();
                    }
                }

                if (line != lastLine)
                {
                    Console.WriteLine(line);
                    Console.Out.Flush();
                    lastLine = line;
                }
            }
            catch
            {
            }

            Thread.Sleep(2500);
        }
    }
}
