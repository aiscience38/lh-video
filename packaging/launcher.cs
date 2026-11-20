using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace LHVideo
{
    static class Program
    {
        static string BaseDir;
        public static string DataDir;
        static string EncryptionKey;
        static int Port;
        static Process Server;

        [STAThread]
        static int Main(string[] args)
        {
            BaseDir = AppDomain.CurrentDomain.BaseDirectory;
            bool smoke = Array.IndexOf(args, "--smoke") >= 0;
            string forcedDataDir = GetArgValue(args, "--data-dir");

            if (smoke)
            {
                try { return RunSmoke(forcedDataDir); }
                catch (Exception ex) { Console.Error.WriteLine("SMOKE FAIL: " + ex.Message); return 2; }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            LoadConfig();
            if (forcedDataDir != null) DataDir = forcedDataDir;
            if (string.IsNullOrEmpty(DataDir))
            {
                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "Choose the folder where LH Video stores generated files and its library.";
                    dialog.ShowNewFolderButton = true;
                    dialog.SelectedPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "LH Video Data");
                    if (dialog.ShowDialog() != DialogResult.OK) return 0;
                    DataDir = dialog.SelectedPath;
                }
            }
            Directory.CreateDirectory(DataDir);
            if (string.IsNullOrEmpty(EncryptionKey)) EncryptionKey = NewKey();
            SaveConfig();

            var form = new MainForm();
            Application.Run(form);
            return 0;
        }

        public static string Url { get { return "http://127.0.0.1:" + Port; } }

        public static string StartServer()
        {
            Port = FreePort();
            var psi = new ProcessStartInfo();
            psi.FileName = Path.Combine(BaseDir, "node.exe");
            psi.Arguments = "\"" + Path.Combine(BaseDir, "app", "server.js") + "\"";
            psi.WorkingDirectory = Path.Combine(BaseDir, "app");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["PORT"] = Port.ToString();
            psi.EnvironmentVariables["HOSTNAME"] = "127.0.0.1";
            psi.EnvironmentVariables["DEPLOYMENT_PROFILE"] = "single-process";
            psi.EnvironmentVariables["TASK_WORKER_MODE"] = "local";
            psi.EnvironmentVariables["ASSET_STORAGE_MODE"] = "local";
            psi.EnvironmentVariables["OPEN_HIGGSFIELD_STORAGE_DIR"] = DataDir;
            psi.EnvironmentVariables["APP_ORIGIN"] = Url;
            psi.EnvironmentVariables["LH_VIDEO_LOCAL"] = "true";
            psi.EnvironmentVariables["GENERATION_ENABLED"] = "true";
            psi.EnvironmentVariables["PROVIDER_CONFIG_ENCRYPTION_KEY"] = EncryptionKey;
            Server = Process.Start(psi);

            for (int i = 0; i < 240; i++)
            {
                if (Server.HasExited) throw new Exception("server exited with code " + Server.ExitCode);
                if (HttpGet(Url + "/api/ready") == 200) return Url;
                Thread.Sleep(500);
            }
            throw new Exception("server did not become ready within 120s");
        }

        public static void StopServer()
        {
            try { if (Server != null && !Server.HasExited) Server.Kill(); } catch { }
        }

        static int RunSmoke(string forcedDataDir)
        {
            LoadConfig();
            DataDir = forcedDataDir ?? DataDir;
            if (string.IsNullOrEmpty(DataDir)) DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "LH Video Data");
            Directory.CreateDirectory(DataDir);
            if (string.IsNullOrEmpty(EncryptionKey)) EncryptionKey = NewKey();
            SaveConfig();

            StartServer();
            int ready = HttpGet(Url + "/api/ready");
            int en = HttpGet(Url + "/en");
            int es = HttpGet(Url + "/es");
            int settings = HttpGet(Url + "/en/settings");
            Console.WriteLine("{\"url\":\"" + Url + "\",\"dataDir\":\"" + DataDir.Replace("\\", "\\\\") + "\",\"ready\":" + ready + ",\"en\":" + en + ",\"es\":" + es + ",\"settings\":" + settings + "}");
            StopServer();
            bool ok = ready == 200 && en == 200 && es == 200 && settings == 200;
            Console.WriteLine(ok ? "SMOKE PASS" : "SMOKE FAIL");
            return ok ? 0 : 1;
        }

        static int HttpGet(string url)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Timeout = 3000;
                request.AllowAutoRedirect = false;
                using (var response = (HttpWebResponse)request.GetResponse())
                    return (int)response.StatusCode;
            }
            catch (WebException ex)
            {
                if (ex.Response is HttpWebResponse) return (int)((HttpWebResponse)ex.Response).StatusCode;
                return -1;
            }
        }

        static int FreePort()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        static string NewKey()
        {
            var bytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            var sb = new StringBuilder();
            foreach (byte b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        static string ConfigPath()
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LH Video");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "config.ini");
        }

        static void LoadConfig()
        {
            string path = ConfigPath();
            if (!File.Exists(path)) return;
            foreach (string line in File.ReadAllLines(path))
            {
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim();
                string value = line.Substring(eq + 1).Trim();
                if (key == "dataDir") DataDir = value;
                else if (key == "encryptionKey") EncryptionKey = value;
            }
        }

        static void SaveConfig()
        {
            File.WriteAllText(ConfigPath(), "dataDir=" + DataDir + Environment.NewLine + "encryptionKey=" + EncryptionKey + Environment.NewLine);
        }

        static string GetArgValue(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }
    }

    public class MainForm : Form
    {
        Label status;
        Button open;
        Button data;
        Button quit;

        public MainForm()
        {
            Text = "LH Video";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            Width = 420;
            Height = 210;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            status = new Label();
            status.Text = "Starting LH Video...";
            status.AutoSize = false;
            status.Dock = DockStyle.Top;
            status.Height = 70;
            status.TextAlign = ContentAlignment.MiddleCenter;
            Controls.Add(status);

            var panel = new FlowLayoutPanel();
            panel.Dock = DockStyle.Fill;
            panel.FlowDirection = FlowDirection.LeftToRight;
            panel.Padding = new Padding(10);
            Controls.Add(panel);

            open = new Button(); open.Text = "Open LH Video"; open.Width = 120; open.Enabled = false;
            data = new Button(); data.Text = "Open data folder"; data.Width = 130;
            quit = new Button(); quit.Text = "Quit"; quit.Width = 80;
            panel.Controls.Add(open);
            panel.Controls.Add(data);
            panel.Controls.Add(quit);

            open.Click += delegate { Process.Start(Program.Url); };
            data.Click += delegate { Process.Start("explorer.exe", "\"" + Program.DataDir + "\""); };
            quit.Click += delegate { Close(); };
            FormClosing += delegate { Program.StopServer(); };

            var worker = new Thread(delegate ()
            {
                try
                {
                    string url = Program.StartServer();
                    BeginInvoke((Action)delegate
                    {
                        status.Text = "LH Video is running at " + url;
                        open.Enabled = true;
                        Process.Start(url);
                    });
                }
                catch (Exception ex)
                {
                    BeginInvoke((Action)delegate
                    {
                        status.Text = "Failed to start: " + ex.Message;
                    });
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }
    }
}
