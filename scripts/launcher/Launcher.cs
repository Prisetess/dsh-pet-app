using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

/// <summary>
/// DSH Pet 启动器（几十 KB 的原生 exe，双击即用）。
///
/// 为什么不直接把 electron.exe 改名：改名后的 Electron 副本会被 SmartScreen / 安全软件的
/// 「伪装二进制」启发式静默拦掉（进程秒退、连主进程日志都不写）。这个启动器是**我们自己编译的**
/// 独立 exe，只负责按正确参数拉起同目录的原版 electron.exe，不触碰它。
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string electron = Path.Combine(dir, "electron.exe");
        string appDir = Path.Combine(dir, "resources", "app");

        if (!File.Exists(electron) || !Directory.Exists(appDir))
        {
            MessageBox.Show(
                "启动失败：这个文件夹不完整。\n\n缺少：\n" +
                (File.Exists(electron) ? "" : electron + "\n") +
                (Directory.Exists(appDir) ? "" : appDir + "\n") +
                "\n请把整个「DSH Pet」文件夹一起拷贝，不要只拷 exe。",
                "DSH Pet",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var psi = new ProcessStartInfo(electron)
        {
            UseShellExecute = false,
            WorkingDirectory = dir,
            Arguments = "\"" + appDir + "\"" + (args.Length > 0 ? " " + string.Join(" ", args) : string.Empty),
        };

        // Electron 只要看到 ELECTRON_RUN_AS_NODE 就退化成纯 Node（不开窗、直接退出），
        // 必须整条删掉——置成空串反而会让 Electron abort。
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");

        try
        {
            Process.Start(psi);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "启动 electron.exe 失败：\n\n" + error.Message,
                "DSH Pet",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
