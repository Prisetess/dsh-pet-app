using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

/// <summary>
/// DSH Pet installer.
///
/// Payload layout (single file, no NSIS / Inno / electron-builder needed):
///   [ installer exe ][ payload.zip ][ 8-byte zip length ][ "DSHPETP1" ][ Authenticode cert ]
///
/// Every oddity below is a bug that was actually hit:
///  * Authenticode inserts alignment padding before the certificate table, so "file end - 8"
///    is not our trailer. We read the PE SecurityDirectory to find the payload end, then scan
///    backwards for the magic marker.
///  * ZipArchive resolves the central directory relative to stream position 0, so the payload is
///    exposed through SubStream (a 0-based window). Copying 197 MB into %TEMP% fails on machines
///    where TEMP is locked down ("对路径 …dsh-pet-payload-*.zip 的访问被拒绝").
///  * .NET Framework has no long-path support: a target dir that pushes any file past 260 chars
///    must be rejected before extraction, or you get a half-installed folder.
///  * Electron memory-maps its .pak files, so re-installing over a running copy fails with
///    "对路径 …chrome_100_percent.pak 的访问被拒绝". We detect processes under the target dir.
///
/// Silent install:  DSH-Pet-Setup.exe /S /D=C:\some\where
/// </summary>
internal static class Program
{
    private const string AppName = "DSH Pet";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DSH Pet";
    private static readonly byte[] Magic = System.Text.Encoding.ASCII.GetBytes("DSHPETP1");

    // ---------------------------------------------------------------- logging

    private static string _logPath;

    internal static void Log(string message)
    {
        // 依次尝试：上次成功的位置 → %TEMP%（可能被策略/杀软锁）→ %LOCALAPPDATA% → exe 同目录
        string[] candidates =
        {
            _logPath,
            Path.Combine(Path.GetTempPath(), "dsh-pet-setup.log"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-pet-setup.log"),
            Path.Combine(Path.GetDirectoryName(Application.ExecutablePath) ?? ".", "dsh-pet-setup.log"),
        };

        foreach (var path in candidates)
        {
            if (string.IsNullOrEmpty(path)) continue;
            try
            {
                File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + Environment.NewLine);
                _logPath = path;
                return;
            }
            catch
            {
                // 换下一个位置
            }
        }
    }

    internal static string DefaultDir
    {
        get
        {
            // 以管理员运行（安装器的默认姿态）：装到 Program Files，所有用户共享；
            // 未提权（脚本/静默调用）时退回当前用户目录，避免直接因权限失败。
            if (IsElevated())
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    AppName);
            }
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Programs\DSH Pet");
        }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        string joined = string.Join(" ", args);
        Log("args=[" + joined + "] user=" + Environment.UserName + " elevated=" + IsElevated());

        bool silent = false;
        foreach (var arg in args)
        {
            if (string.Equals(arg.Trim('"'), "/S", StringComparison.OrdinalIgnoreCase)) silent = true;
        }

        // /D= 取"剩下的整串"：路径可能带空格、可能没有引号（与 NSIS 约定一致）
        string target = null;
        int dIndex = joined.IndexOf("/D=", StringComparison.OrdinalIgnoreCase);
        if (dIndex >= 0) target = joined.Substring(dIndex + 3).Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(target)) target = DefaultDir;

        Log("silent=" + silent + " target=[" + target + "]");

        try
        {
            if (silent)
            {
                Install(target, null, true);
                Log("silent install finished");
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(target));
        }
        catch (Exception error)
        {
            Log("FATAL " + error.GetType().Name + ": " + error.Message);
            if (!silent)
            {
                MessageBox.Show("安装失败：\n\n" + error.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            Environment.Exit(1);
        }
    }

    // ---------------------------------------------------------------- install

    /// <summary>安装入口：失败时，如果目录是这次新建的，整体删掉（不留半个安装）</summary>
    internal static void Install(string targetDir, IProgress progress, bool silent)
    {
        bool existed = Directory.Exists(targetDir);
        try
        {
            InstallCore(targetDir, progress, silent);
        }
        catch
        {
            if (!existed) TryRemoveDirectory(targetDir);
            throw;
        }
    }

    private static void InstallCore(string targetDir, IProgress progress, bool silent)
    {
        string self = Application.ExecutablePath;
        long fileLength = new FileInfo(self).Length;
        Log("self=" + self + " length=" + fileLength);

        using (var fs = File.OpenRead(self))
        {
            long payloadEnd = GetUnsignedEnd(fs, fileLength);
            if (payloadEnd < 16) throw new InvalidDataException("安装包已损坏：负载区为空");

            long lengthField = FindLengthField(fs, payloadEnd);
            if (lengthField < 0) throw new InvalidDataException("安装包已损坏：找不到负载标记（DSHPETP1）");

            var lengthBuffer = new byte[8];
            fs.Seek(lengthField, SeekOrigin.Begin);
            if (fs.Read(lengthBuffer, 0, 8) != 8) throw new InvalidDataException("安装包已损坏：读不到负载长度");
            long zipLength = BitConverter.ToInt64(lengthBuffer, 0);
            long zipStart = lengthField - zipLength;
            Log("payloadEnd=" + payloadEnd + " zipLength=" + zipLength + " zipStart=" + zipStart);
            if (zipLength <= 0 || zipStart <= 0) throw new InvalidDataException("安装包已损坏：负载偏移非法");

            using (var payload = new SubStream(fs, zipStart, zipLength))
            using (var archive = new ZipArchive(payload, ZipArchiveMode.Read, true))
            {
                int total = archive.Entries.Count;
                int longestEntry = 0;
                foreach (var candidate in archive.Entries)
                {
                    if (candidate.FullName.Length > longestEntry) longestEntry = candidate.FullName.Length;
                }

                // 前置校验：全部挡在解压之前，失败时不会留下半个安装
                EnsurePathLength(targetDir, longestEntry);
                EnsureWritable(targetDir);
                EnsureNotRunning(targetDir, silent);

                Directory.CreateDirectory(targetDir);
                int done = 0;
                string current = string.Empty;
                Log("entries=" + total);
                try
                {
                    foreach (var entry in archive.Entries)
                    {
                        done++;
                        current = entry.FullName;
                        if (progress != null) progress.Report(done, total, entry.FullName);

                        string destination = Path.GetFullPath(Path.Combine(targetDir, entry.FullName));
                        if (!destination.StartsWith(Path.GetFullPath(targetDir), StringComparison.OrdinalIgnoreCase))
                            throw new InvalidDataException("安装包条目越界：" + entry.FullName);

                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(destination);
                            continue;
                        }

                        Directory.CreateDirectory(Path.GetDirectoryName(destination));
                        using (var source = entry.Open())
                        using (var output = File.Create(destination))
                        {
                            source.CopyTo(output);
                        }
                    }
                }
                catch (UnauthorizedAccessException error)
                {
                    throw new InvalidOperationException(
                        "写入失败（被拒绝）：" + Path.Combine(targetDir, current) + "\n\n" +
                        "常见原因：文件正被运行中的 DSH Pet 占用，或该目录/磁盘不允许写入。\n\n" +
                        "系统返回：" + error.Message);
                }
                catch (IOException error)
                {
                    throw new InvalidOperationException(
                        "写入失败：" + Path.Combine(targetDir, current) + "\n\n" +
                        "磁盘可能已满、被写保护，或文件正被其它程序占用。\n\n" +
                        "系统返回：" + error.Message);
                }
                Log("extracted=" + done);
            }
        }

        string launcher = Path.Combine(targetDir, "DSH Pet.exe");
        // 快捷方式/卸载项都用同一张多尺寸图标（payload 里的 ui/app.ico，随安装包一起解压出来）
        string appIcon = Path.Combine(targetDir, @"resources\app\ui\app.ico");
        if (!File.Exists(appIcon)) appIcon = launcher;
        WriteUninstallEntry(targetDir, appIcon);

        // 快捷方式直接指 electron.exe + resources\app：这是 windows 上"electron 应用"的标准启动方式，
        // 也能避开"我们自己编译的 45KB exe 首次运行被 SmartScreen 拦一次"的问题
        // （electron.exe 是官方二进制，信誉更好）。launcher 仍留在目录里当备用。
        string electron = Path.Combine(targetDir, "electron.exe");
        string appPayload = Path.Combine(targetDir, "resources", "app");
        string launchTarget = File.Exists(electron) ? electron : launcher;
        string launchArgs = File.Exists(electron) ? "\"" + appPayload + "\"" : string.Empty;

        CreateShortcut(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"),
            launchTarget, launchArgs, targetDir, appIcon);

        string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName);
        Directory.CreateDirectory(startMenu);
        CreateShortcut(Path.Combine(startMenu, AppName + ".lnk"), launchTarget, launchArgs, targetDir, appIcon);
        CreateShortcut(
            Path.Combine(startMenu, "卸载 " + AppName + ".lnk"),
            Path.Combine(targetDir, "uninstall.exe"), string.Empty, targetDir, appIcon);

        if (!silent)
        {
            if (MessageBox.Show("安装完成。现在启动 " + AppName + " 吗？", AppName,
                    MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
            {
                Process.Start(new ProcessStartInfo(launchTarget)
                {
                    Arguments = launchArgs,
                    WorkingDirectory = targetDir,
                    UseShellExecute = true,
                });
            }
        }
    }

    // ---------------------------------------------------------------- preflight

    /// <summary>路径总长校验：.NET Framework 没有 long path 支持，超过 260 字符必然装到一半失败。</summary>
    private static void EnsurePathLength(string targetDir, int longestEntryLength)
    {
        int total = targetDir.Length + 1 + longestEntryLength;
        if (total <= 255) return;
        throw new InvalidOperationException(
            "安装路径太长。\n\n" +
            "Windows 对路径有 260 字符限制，当前选择会让最长文件达到 " + total + " 字符。\n\n" +
            "请换一个更短的目录，例如 D:\\DSH Pet。");
    }

    /// <summary>可写性 + 空间预检：把"装到一半才报拒绝访问"变成安装前的一句明确提示。</summary>
    private static void EnsureWritable(string targetDir)
    {
        Directory.CreateDirectory(targetDir);

        // 真的写一个探针文件（覆盖只读目录、ACL 拒绝、只读盘、写保护 U 盘）。
        // 只试一次会被杀软/索引服务的瞬时占用误伤，所以最多重试三次。
        string probe = Path.Combine(targetDir, ".dsh-pet-write-test-" + Guid.NewGuid().ToString("N") + ".tmp");
        Exception lastError = null;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                File.WriteAllText(probe, "probe");
                File.Delete(probe);
                lastError = null;
                break;
            }
            catch (Exception error)
            {
                lastError = error;
                Thread.Sleep(250);
            }
        }

        if (lastError != null)
        {
            Log("probe failed: user=" + Environment.UserName +
                " elevated=" + IsElevated() +
                " error=" + lastError.GetType().Name + ": " + lastError.Message);

            string hint = DescribeDrive(targetDir);
            throw new InvalidOperationException(
                "这个目录不可写：" + targetDir + "\n\n" +
                (string.IsNullOrEmpty(hint) ? "" : hint + "\n\n") +
                "可以换一个位置，例如 D:\\DSH Pet，或选择你用户目录下的文件夹。\n\n" +
                "系统返回：" + lastError.Message);
        }

        // 空间检查（解压后约 410 MB，留 20 MB 余量）
        try
        {
            string root = Path.GetPathRoot(Path.GetFullPath(targetDir));
            var drive = new DriveInfo(root);
            if (drive.IsReady && drive.AvailableFreeSpace > 0 && drive.AvailableFreeSpace < 430L * 1024 * 1024)
            {
                throw new InvalidOperationException(
                    "磁盘空间不足：" + root + " 只剩 " +
                    (drive.AvailableFreeSpace / (1024 * 1024)) + " MB，安装需要约 410 MB。");
            }
        }
        catch (InvalidOperationException)
        {
            throw;
        }
        catch
        {
            // 读不到空间信息就继续
        }
    }

    /// <summary>目标目录里已有运行中的实例时，Electron 会映射 .pak 文件，覆盖写会被拒。</summary>
    private static void EnsureNotRunning(string targetDir, bool silent)
    {
        var running = ProcessesUnder(targetDir);
        if (running.Count == 0) return;

        string names = string.Join("、", running.Select(p => p.ProcessName).Distinct().ToArray());

        if (silent)
        {
            throw new InvalidOperationException(
                "目标目录里的 DSH Pet 正在运行（" + names + "）。\n\n请先从托盘退出，或换一个安装目录。");
        }

        var answer = MessageBox.Show(
            "检测到 DSH Pet 正在这个目录里运行（" + names + "）。\n\n" +
            "安装需要覆盖它正在使用的文件。是否关闭它并继续？\n\n" +
            "（选择「是」会结束这些进程）",
            "DSH Pet 安装程序", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);

        if (answer != DialogResult.Yes)
        {
            throw new InvalidOperationException("已取消安装：请先从托盘退出 DSH Pet，再重新运行安装程序。");
        }

        foreach (var process in running)
        {
            try { process.Kill(); } catch { }
        }

        for (int i = 0; i < 20; i++)
        {
            Thread.Sleep(150);
            if (ProcessesUnder(targetDir).Count == 0) break;
        }
    }

    private static List<Process> ProcessesUnder(string dir)
    {
        var found = new List<Process>();
        string prefix = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                string path = process.MainModule != null ? process.MainModule.FileName : null;
                if (!string.IsNullOrEmpty(path) && path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    found.Add(process);
                }
            }
            catch
            {
                // 权限不够 / 进程已退出：跳过
            }
        }
        return found;
    }

    internal static bool IsElevated()
    {
        try
        {
            var principal = new System.Security.Principal.WindowsPrincipal(
                System.Security.Principal.WindowsIdentity.GetCurrent());
            return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>以管理员身份重新拉起自己（带上目标目录），返回是否成功启动。</summary>
    internal static bool RelaunchElevated(string targetDir)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = Application.ExecutablePath,
                Arguments = "/D=\"" + targetDir + "\"",
                UseShellExecute = true,
                Verb = "runas",
            });
            return true;
        }
        catch (Exception error)
        {
            Log("relaunch elevated failed: " + error.Message);
            return false;
        }
    }

    /// <summary>给不可写路径补一句人话：盘类型 / 只读介质。</summary>
    private static string DescribeDrive(string targetDir)
    {
        try
        {
            string root = Path.GetPathRoot(Path.GetFullPath(targetDir));
            var drive = new DriveInfo(root);
            if (!drive.IsReady) return "盘符 " + root + " 未就绪（可能没插盘或没解锁）。";
            switch (drive.DriveType)
            {
                case DriveType.CDRom: return "盘符 " + root + " 是光驱，无法写入。";
                case DriveType.Removable: return "盘符 " + root + " 是可移动盘，可能处于写保护状态。";
                case DriveType.Network: return "盘符 " + root + " 是网络位置，可能没有写权限或已断开。";
                default: return "盘符 " + root + " 可用空间 " + (drive.AvailableFreeSpace / (1024 * 1024)) + " MB。";
            }
        }
        catch
        {
            return string.Empty;
        }
    }

    // ---------------------------------------------------------------- payload location

    /// <summary>负载结束位置：有签名时是证书表偏移，否则就是文件长度。</summary>
    private static long GetUnsignedEnd(FileStream fs, long fileLength)
    {
        try
        {
            var buffer = new byte[4];
            fs.Seek(0x3C, SeekOrigin.Begin);
            if (fs.Read(buffer, 0, 4) != 4) return fileLength;
            int peOffset = BitConverter.ToInt32(buffer, 0);
            if (peOffset <= 0 || peOffset + 24 > fileLength) return fileLength;

            fs.Seek(peOffset + 4, SeekOrigin.Begin);
            var coff = new byte[20];
            if (fs.Read(coff, 0, 20) != 20) return fileLength;
            int sizeOfOptionalHeader = BitConverter.ToUInt16(coff, 16);
            if (sizeOfOptionalHeader < 96) return fileLength;

            long optionalHeader = peOffset + 24;
            fs.Seek(optionalHeader, SeekOrigin.Begin);
            var magicBytes = new byte[2];
            if (fs.Read(magicBytes, 0, 2) != 2) return fileLength;
            ushort peMagic = BitConverter.ToUInt16(magicBytes, 0);
            int dataDirectories = peMagic == 0x20B ? 112 : 96; // PE32+ / PE32
            if (dataDirectories + 8 * 5 > sizeOfOptionalHeader) return fileLength;

            // 数据目录第 4 项 = Certificate Table
            fs.Seek(optionalHeader + dataDirectories + 4 * 8, SeekOrigin.Begin);
            var security = new byte[8];
            if (fs.Read(security, 0, 8) != 8) return fileLength;
            uint certificateOffset = BitConverter.ToUInt32(security, 0);
            uint certificateSize = BitConverter.ToUInt32(security, 4);
            if (certificateSize > 0 && certificateOffset > 0 && certificateOffset < fileLength)
            {
                return certificateOffset;
            }
        }
        catch
        {
            // 解析不了就当未签名
        }
        return fileLength;
    }

    /// <summary>从负载末尾往回扫魔数，返回长度字段（魔数前 8 字节）的位置。</summary>
    private static long FindLengthField(FileStream fs, long payloadEnd)
    {
        int window = (int)Math.Min(512, payloadEnd);
        var buffer = new byte[window];
        fs.Seek(payloadEnd - window, SeekOrigin.Begin);
        int read = 0;
        while (read < window)
        {
            int chunk = fs.Read(buffer, read, window - read);
            if (chunk <= 0) break;
            read += chunk;
        }

        for (int i = read - Magic.Length; i >= 0; i--)
        {
            bool match = true;
            for (int j = 0; j < Magic.Length; j++)
            {
                if (buffer[i + j] != Magic[j]) { match = false; break; }
            }
            if (!match) continue;
            long magicPosition = payloadEnd - window + i;
            return magicPosition >= 8 ? magicPosition - 8 : -1;
        }
        return -1;
    }

    // ---------------------------------------------------------------- shell integration

    private static void WriteUninstallEntry(string targetDir, string launcher)
    {
        // 提权时装到 Program Files，卸载项写 HKLM（所有用户可见）；否则写 HKCU。
        // 两边都尝试，失败忽略——装得下就行，卸载还有 uninstall.exe 兜底。
        foreach (var hive in new[] { Microsoft.Win32.Registry.LocalMachine, Microsoft.Win32.Registry.CurrentUser })
        {
            try
            {
                using (var key = hive.CreateSubKey(UninstallKey))
                {
                    if (key == null) continue;
                    key.SetValue("DisplayName", AppName);
                    key.SetValue("DisplayIcon", launcher);
                    key.SetValue("DisplayVersion", "0.1.0");
                    key.SetValue("Publisher", "DSH Pet");
                    key.SetValue("InstallLocation", targetDir);
                    key.SetValue("UninstallString", "\"" + Path.Combine(targetDir, "uninstall.exe") + "\"");
                    key.SetValue("QuietUninstallString", "\"" + Path.Combine(targetDir, "uninstall.exe") + "\" /S");
                    key.SetValue("NoModify", 1, Microsoft.Win32.RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, Microsoft.Win32.RegistryValueKind.DWord);
                    key.SetValue("EstimatedSize", 420000, Microsoft.Win32.RegistryValueKind.DWord);
                }
            }
            catch
            {
                // 没有该 hive 的写权限（通常是未提权时的 HKLM）就跳过
            }
        }
    }

    /// <summary>用 WScript.Shell COM 建快捷方式（不需要 COM 引用）。</summary>
    internal static void CreateShortcut(string linkPath, string targetPath, string arguments, string workDir, string iconPath)
    {
        try
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
            Type shortcutType = shortcut.GetType();
            shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
            shortcutType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { arguments });
            shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workDir });
            shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { iconPath + ",0" });
            shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        catch
        {
            // 快捷方式建不出来不该让安装失败
        }
    }

    private static void TryRemoveDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        catch
        {
            // 删不掉就留着，错误已经报过了
        }
    }
}

/// <summary>把 FileStream 的一段区间映射成"从 0 开始"的只读流（给 ZipArchive 用）。</summary>
internal sealed class SubStream : Stream
{
    private readonly Stream _base;
    private readonly long _start;
    private readonly long _length;
    private long _position;

    public SubStream(Stream baseStream, long start, long length)
    {
        _base = baseStream;
        _start = start;
        _length = length;
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return _length; } }

    public override long Position
    {
        get { return _position; }
        set
        {
            if (value < 0) throw new ArgumentOutOfRangeException("value");
            _position = value;
        }
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        long remaining = _length - _position;
        if (remaining <= 0) return 0;
        _base.Seek(_start + _position, SeekOrigin.Begin);
        int read = _base.Read(buffer, offset, (int)Math.Min(count, remaining));
        _position += read;
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        long next;
        switch (origin)
        {
            case SeekOrigin.Begin: next = offset; break;
            case SeekOrigin.Current: next = _position + offset; break;
            default: next = _length + offset; break;
        }
        if (next < 0) throw new IOException("越界定位");
        _position = next;
        return _position;
    }

    public override void Flush() { }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}

internal interface IProgress
{
    void Report(int done, int total, string current);
}

/// <summary>最小安装向导：选目录 → 安装 → 完成；失败时给出可操作的退路。</summary>
internal sealed class SetupForm : Form, IProgress
{
    private readonly TextBox _path;
    private readonly Button _browse;
    private readonly Button _install;
    private readonly Button _cancel;
    private readonly ProgressBar _bar;
    private readonly Label _status;

    public SetupForm(string defaultDir)
    {
        Text = "DSH Pet 安装程序";
        ClientSize = new Size(580, 250);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9f);

        var title = new Label
        {
            Text = "把桌宠安装到你的电脑",
            Font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(18, 16),
        };

        var description = new Label
        {
            Text = "选择安装目录（默认装到当前用户下，不需要管理员权限）：",
            AutoSize = true,
            Location = new Point(20, 52),
        };

        _path = new TextBox { Text = defaultDir, Location = new Point(20, 76), Width = 450 };
        _browse = new Button { Text = "浏览…", Location = new Point(476, 75), Width = 84 };
        _browse.Click += (s, e) =>
        {
            using (var dialog = new FolderBrowserDialog { SelectedPath = _path.Text, Description = "选择安装目录" })
            {
                if (dialog.ShowDialog(this) == DialogResult.OK) _path.Text = dialog.SelectedPath;
            }
        };

        _bar = new ProgressBar { Location = new Point(20, 116), Width = 540, Height = 16 };
        _status = new Label { Text = string.Empty, Location = new Point(20, 138), Width = 540, AutoEllipsis = true };

        _install = new Button { Text = "安装", Location = new Point(390, 190), Width = 80 };
        _cancel = new Button { Text = "退出", Location = new Point(480, 190), Width = 80 };
        _install.Click += (s, e) => StartInstall();
        _cancel.Click += (s, e) => Close();

        Controls.AddRange(new Control[] { title, description, _path, _browse, _bar, _status, _install, _cancel });
    }

    private void StartInstall()
    {
        string target = _path.Text.Trim();
        if (string.IsNullOrEmpty(target))
        {
            MessageBox.Show("请选择安装目录。", "DSH Pet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        _install.Enabled = false;
        _browse.Enabled = false;
        _path.Enabled = false;
        try
        {
            Program.Install(target, this, false);
            _status.Text = "安装完成";
            Close();
        }
        catch (Exception error)
        {
            Program.Log("FATAL (gui) " + error.GetType().Name + ": " + error.Message);
            HandleFailure(error, target);
        }
    }

    /// <summary>失败时给三条退路：管理员重试 / 换默认目录 / 放弃。</summary>
    private void HandleFailure(Exception error, string target)
    {
        string extra = Program.IsElevated() ? "（当前已是管理员权限）" : "";

        var answer = MessageBox.Show(
            "安装失败：\n\n" + error.Message + "\n\n" +
            "——————————————————\n" +
            "要怎么办？" + extra + "\n\n" +
            "「是」  = 以管理员身份重试（需要 UAC 确认）\n" +
            "「否」  = 改装到默认目录：\n         " + Program.DefaultDir + "\n" +
            "「取消」= 关闭安装程序",
            "DSH Pet 安装失败", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);

        if (answer == DialogResult.Yes)
        {
            if (Program.RelaunchElevated(target))
            {
                Close();
                return;
            }
            MessageBox.Show("无法以管理员身份启动（可能在 UAC 处取消了）。", "DSH Pet",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        else if (answer == DialogResult.No)
        {
            _path.Text = Program.DefaultDir;
            _status.Text = string.Empty;
            StartInstall();
            return;
        }

        _install.Enabled = true;
        _browse.Enabled = true;
        _path.Enabled = true;
    }

    public void Report(int done, int total, string current)
    {
        if (IsDisposed) return;
        _bar.Maximum = Math.Max(total, 1);
        _bar.Value = Math.Min(done, _bar.Maximum);
        _status.Text = string.Format("{0}/{1}  {2}", done, total, current);
        Application.DoEvents();
    }
}
