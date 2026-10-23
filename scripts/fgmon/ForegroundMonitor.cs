using System;
using System.Runtime.InteropServices;
using System.Threading;

/// <summary>
/// 前台窗口监视器（DSH Pet 的「全屏自动隐藏」用）。
///
/// Electron 只能看到自己的窗口，所以用这个 45KB 的小工具每秒轮询一次前台窗口矩形，
/// 一行一个样本打印到 stdout：  handle|x|y|w|h
///
/// handle 取低 32 位：主进程比对自家窗口时用的是 getNativeWindowHandle().readUInt32LE(0)。
/// </summary>
internal static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    private static void Main()
    {
        var stdout = Console.Out;
        while (true)
        {
            try
            {
                IntPtr handle = GetForegroundWindow();
                if (handle != IntPtr.Zero)
                {
                    RECT rect;
                    if (GetWindowRect(handle, out rect))
                    {
                        long low = handle.ToInt64() & 0xFFFFFFFFL;
                        stdout.WriteLine(
                            low + "|" + rect.Left + "|" + rect.Top + "|" + (rect.Right - rect.Left) + "|" + (rect.Bottom - rect.Top));
                        stdout.Flush();
                    }
                }
            }
            catch
            {
                // 单次读取失败不影响后续轮询
            }
            Thread.Sleep(700);
        }
    }
}
