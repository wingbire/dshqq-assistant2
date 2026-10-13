using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

// DSH-QQ 群小助手 · 托盘启动器（N26）
// 自己找 node、自己起 app/main.js、把控制台输出写进日志文件，并提供开机自启。
static class Program
{
    const string AppName = "DSH-QQ 群小助手";
    const string RunKey = "DSHQQTray";
    static NotifyIcon tray;
    static Process child;
    static string root, entry, nodeExe, dataDir, logDir, logFile, configFile;
    static ToolStripMenuItem miStart, miStop, miWeb, miAuto, miStatus;
    static Timer timer;
    static readonly object logLock = new object();

    [STAThread]
    static void Main()
    {
        root = FindRoot();
        entry = Path.Combine(root, "app", "main.js");
        dataDir = Path.Combine(root, "app", "dsh-data");
        logDir = Path.Combine(dataDir, "logs");
        logFile = Path.Combine(logDir, "bot.log");
        configFile = Path.Combine(dataDir, "config", "app.json");
        nodeExe = FindNode();

        var menu = new ContextMenuStrip();
        miStatus = new ToolStripMenuItem("● 未运行") { Enabled = false };
        menu.Items.Add(miStatus);
        menu.Items.Add(new ToolStripSeparator());
        miStart = new ToolStripMenuItem("启动", null, delegate { StartBot(); });
        miStop = new ToolStripMenuItem("停止", null, delegate { StopBot(); });
        menu.Items.Add(miStart);
        menu.Items.Add(miStop);
        menu.Items.Add(new ToolStripMenuItem("重启", null, delegate { StopBot(); StartBot(); }));
        menu.Items.Add(new ToolStripSeparator());
        miWeb = new ToolStripMenuItem("打开配置端", null, delegate { OpenWeb(); });
        menu.Items.Add(miWeb);
        menu.Items.Add(new ToolStripMenuItem("打开数据目录", null, delegate { Shell(dataDir); }));
        menu.Items.Add(new ToolStripMenuItem("查看日志", null, delegate { Shell(logFile); }));
        menu.Items.Add(new ToolStripSeparator());
        miAuto = new ToolStripMenuItem("开机自启", null, delegate { ToggleAutoStart(); });
        miAuto.CheckOnClick = true;
        miAuto.Checked = IsAutoStart();
        menu.Items.Add(miAuto);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("退出", null, delegate { StopBot(); tray.Visible = false; Application.Exit(); }));

        tray = new NotifyIcon();
        tray.Icon = SystemIcons.Application;
        tray.Text = AppName + " · 已停止";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate { OpenWeb(); };

        timer = new Timer();
        timer.Interval = 3000;
        timer.Tick += delegate { Refresh(); };
        timer.Start();

        Refresh();
        if (child == null && File.Exists(entry)) StartBot();   // 双击就启动
        Application.Run();
    }

    static string FindRoot()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string p = Path.GetFullPath(baseDir);
        // exe 放在 <工作区>/launcher/ 时，工作区是上一层
        for (int i = 0; i < 3 && p != null; i++)
        {
            if (File.Exists(Path.Combine(p, "app", "main.js"))) return p;
            p = Path.GetDirectoryName(p);
        }
        return Path.GetFullPath(Path.Combine(baseDir, ".."));
    }

    static string FindNode()
    {
        string bundled = Path.Combine(root, "runtime", "node", "node.exe");
        if (File.Exists(bundled)) return bundled;
        string[] names = { "node.exe", "node" };
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathVar.Split(Path.PathSeparator))
        {
            if (dir.Length == 0) continue;
            foreach (string n in names)
            {
                try { string c = Path.Combine(dir, n); if (File.Exists(c)) return c; } catch (Exception) { }
            }
        }
        return "node";   // 交给 PATH 去解析
    }

    static int ReadPort()
    {
        try
        {
            string txt = File.ReadAllText(configFile, Encoding.UTF8);
            int at = txt.IndexOf("webui");
            if (at < 0) return 8799;
            int pt = txt.IndexOf("port", at);
            if (pt < 0) return 8799;
            int colon = txt.IndexOf(':', pt);
            if (colon < 0) return 8799;
            int i = colon + 1;
            while (i < txt.Length && !char.IsDigit(txt[i])) i++;
            int j = i;
            while (j < txt.Length && char.IsDigit(txt[j])) j++;
            if (j > i) return int.Parse(txt.Substring(i, j - i));
        }
        catch (Exception) { }
        return 8799;
    }

    static void StartBot()
    {
        if (child != null && !child.HasExited) return;
        if (!File.Exists(entry)) { MessageBox.Show("找不到 " + entry, AppName); return; }
        Directory.CreateDirectory(logDir);
        AppendLog("=== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " 启动 ===");
        var psi = new ProcessStartInfo(nodeExe, Quote(entry));
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        child = new Process();
        child.StartInfo = psi;
        child.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog(e.Data); };
        child.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) AppendLog("[err] " + e.Data); };
        child.EnableRaisingEvents = true;
        child.Exited += delegate { AppendLog("=== 进程结束 ==="); };
        try
        {
            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            AppendLog("[启动失败] " + ex.Message);
            MessageBox.Show("启动失败：" + ex.Message, AppName);
            child = null;
        }
        Refresh();
    }

    static void StopBot()
    {
        if (child == null || child.HasExited) { Refresh(); return; }
        try
        {
            var kill = new ProcessStartInfo("taskkill", "/PID " + child.Id + " /T /F");
            kill.UseShellExecute = false;
            kill.CreateNoWindow = true;
            Process.Start(kill).WaitForExit(4000);
        }
        catch (Exception) { try { child.Kill(); } catch (Exception) { } }
        child = null;
        Refresh();
    }

    static void OpenWeb()
    {
        if (child == null || child.HasExited) StartBot();
        string url = "http://127.0.0.1:" + ReadPort();
        Shell(url);
    }

    static void Shell(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch (Exception ex) { MessageBox.Show(ex.Message, AppName); }
    }

    static bool IsAutoStart()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false))
            {
                return k != null && k.GetValue(RunKey) != null;
            }
        }
        catch (Exception) { return false; }
    }

    static void ToggleAutoStart()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            {
                if (k == null) return;
                if (k.GetValue(RunKey) == null) k.SetValue(RunKey, Quote(Application.ExecutablePath));
                else k.DeleteValue(RunKey, false);
            }
        }
        catch (Exception ex) { MessageBox.Show(ex.Message, AppName); }
        miAuto.Checked = IsAutoStart();
    }

    static void Refresh()
    {
        bool alive = child != null && !child.HasExited;
        miStart.Enabled = !alive;
        miStop.Enabled = alive;
        miStatus.Text = alive ? ("● 运行中  PID " + child.Id) : "○ 未运行";
        tray.Text = AppName + (alive ? " · 运行中" : " · 已停止");
    }

    static string Quote(string s) { return "\"" + s + "\""; }

    static void AppendLog(string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            try { Directory.CreateDirectory(logDir); File.AppendAllText(logFile, line + Environment.NewLine, Encoding.UTF8); }
            catch (Exception) { }
        }
    }
}
