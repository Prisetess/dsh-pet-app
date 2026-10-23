using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

/// <summary>
/// DSH Pet launcher (project edition) -- same command as `npm run start`, no npm / node / terminal.
///
/// It starts the Electron runtime that DSH already downloaded, with this project folder as the
/// app path. That exact invocation is verified working on this machine; nothing is renamed or
/// copied here.
///
/// Overrides: DSH_PET_APP_DIR (project folder), DSH_PET_ELECTRON_EXE (electron path).
/// </summary>
internal static class Program
{
    private const string DefaultAppDir = @"__APP_DIR__";

    [STAThread]
    private static void Main()
    {
        string appDir = Environment.GetEnvironmentVariable("DSH_PET_APP_DIR");
        if (string.IsNullOrWhiteSpace(appDir)) appDir = DefaultAppDir;

        string electron = Environment.GetEnvironmentVariable("DSH_PET_ELECTRON_EXE");
        if (string.IsNullOrWhiteSpace(electron))
        {
            electron = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                @".dsh\electron\electron.exe");
        }

        if (!Directory.Exists(appDir))
        {
            MessageBox.Show(
                "App folder not found:\n" + appDir + "\n\nSet DSH_PET_APP_DIR to the project folder.",
                "DSH Pet", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        if (!File.Exists(electron))
        {
            MessageBox.Show(
                "Electron runtime not found:\n" + electron +
                "\n\nLet DSH download Electron first, or set DSH_PET_ELECTRON_EXE to an electron.exe.",
                "DSH Pet", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var psi = new ProcessStartInfo(electron)
        {
            UseShellExecute = false,
            WorkingDirectory = appDir,
            Arguments = "\"" + appDir + "\"",
        };

        // If this variable exists Electron degrades to plain node (no window, immediate exit).
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");

        try
        {
            Process.Start(psi);
        }
        catch (Exception error)
        {
            MessageBox.Show("Start failed:\n\n" + error.Message, "DSH Pet", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
