using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

/// <summary>
/// DSH Pet uninstaller. Removes the install folder, the shortcuts and the "Apps &amp; features"
/// entry. User data (config at %USERPROFILE%\.dsh\dsh-pet) is intentionally kept.
///
/// Silent: uninstall.exe /S
/// </summary>
internal static class Program
{
    private const string AppName = "DSH Pet";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH Pet";

    [STAThread]
    private static void Main(string[] args)
    {
        bool silent = false;
        foreach (var arg in args)
        {
            if (string.Equals(arg, "/S", StringComparison.OrdinalIgnoreCase)) silent = true;
        }

        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

        if (!silent)
        {
            var answer = MessageBox.Show(
                "确定要卸载 " + AppName + " 吗？\n\n会删除：" + dir + "\n以及桌面/开始菜单快捷方式。\n\n" +
                "（配置目录 %USERPROFILE%\\.dsh\\dsh-pet 也会一起删除）",
                AppName + " 卸载", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;
        }

        TryDelete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"));
        TryDeleteDirectory(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName));

        // 安装时可能写在 HKLM（提权装到 Program Files）也可能在 HKCU，两边都清
        foreach (var hive in new[] { Microsoft.Win32.Registry.LocalMachine, Microsoft.Win32.Registry.CurrentUser })
        {
            try
            {
                hive.DeleteSubKeyTree(UninstallKey, false);
            }
            catch
            {
                // 没权限或本来就没有，忽略
            }
        }

        // 用户配置与记忆（按需求：卸载默认不保留）。
        // 注意：如果这台机器还装着 DSH 的 dsh-pet 插件，%USERPROFILE%\.dsh\dsh-pet 是两边共用的，
        // 删掉会连带清掉 DSH 里的桌宠设置 —— 所以交互式卸载会明确问一句，静默卸载则保守起见保留。
        try
        {
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string sharedConfig = Path.Combine(userProfile, @".dsh\dsh-pet");
            string dshPlugin = Path.Combine(userProfile, @".dsh\profiles\desktop\node_modules\dsh-pet");
            bool sharedWithDsh = Directory.Exists(dshPlugin);

            bool deleteShared;
            if (silent)
            {
                // 无人值守：只在没有 DSH 插件时删，避免误伤
                deleteShared = !sharedWithDsh;
            }
            else
            {
                var choice = MessageBox.Show(
                    "卸载时是否一并删除宠物配置？\n\n" +
                    sharedConfig + "\n\n" +
                    (sharedWithDsh
                        ? "注意：这台机器装了 DSH 的桌宠插件，这个目录是两边共用的 ——\n选择「是」会把 DSH 里的桌宠设置也一起删掉。\n\n"
                        : "") +
                    "「是」= 删除配置与记忆　「否」= 保留配置　「取消」= 不卸载",
                    AppName + " 卸载", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);

                if (choice == DialogResult.Cancel) return;
                deleteShared = choice == DialogResult.Yes;
            }

            if (deleteShared && Directory.Exists(sharedConfig))
            {
                Directory.Delete(sharedConfig, true);
            }

            // 本 App 自己的数据（统计、首次运行标记、Electron 缓存）总是删
            string appData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DSH Pet");
            if (Directory.Exists(appData)) Directory.Delete(appData, true);
        }
        catch
        {
            // 删不掉就留着
        }

        // 开机自启项（当前用户 Run 键）
        foreach (var hive in new[] { Microsoft.Win32.Registry.CurrentUser, Microsoft.Win32.Registry.LocalMachine })
        {
            try
            {
                using (var run = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (run != null) run.DeleteValue("DSHPet", false);
                }
            }
            catch
            {
                // 删不掉就留着，用户还能在任务管理器里关
            }
        }

        // 删掉除自己以外的全部文件
        foreach (var file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
        {
            if (string.Equals(file, Application.ExecutablePath, StringComparison.OrdinalIgnoreCase)) continue;
            TryDelete(file);
        }
        foreach (var sub in Directory.GetDirectories(dir))
        {
            TryDeleteDirectory(sub);
        }

        // 自己是删不掉自己的：交给 cmd 在进程退出后连目录一起删
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c ping -n 2 127.0.0.1 >nul & rmdir /s /q \"" + dir + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            });
        }
        catch
        {
            // 删不掉就留给用户手删
        }

        if (!silent)
        {
            MessageBox.Show("已卸载。\n\n配置与记忆已一并删除。",
                AppName + " 卸载", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    private static void TryDelete(string file)
    {
        try
        {
            if (File.Exists(file)) File.Delete(file);
        }
        catch
        {
            // 被占用就跳过
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        catch
        {
            // 被占用就跳过
        }
    }
}
