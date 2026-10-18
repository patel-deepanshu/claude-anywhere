# Claude Anywhere - persistent Windows desktop host (JSON lines over stdio).
#
# Protocol: one request per line on stdin  {"id":1,"cmd":"click","args":{...}}
#           one response per line on stdout {"id":1,"ok":true,"result":{...}}
#                                       or {"id":1,"ok":false,"error":{"message":"...","code":"...","hint":"..."}}
#           a successful result may carry "warnings": ["..."] (e.g. input that Windows may have dropped).
# The host exits when stdin closes. Runs on Windows PowerShell 5.1 and PowerShell 7+.
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
#
# Exit codes: 0 stdin closed, 2 self-test compile failure, 3 restricted language mode, 4 stdio setup failure.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

$HostProtocol = 1

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  # Restricted modes block .NET method calls, so report with cmdlets only and respect the policy.
  $ErrorActionPreference = 'Continue'
  Write-Error -Message ('ANYWHERE_HOST_ERROR: PowerShell runs in ' + $ExecutionContext.SessionState.LanguageMode +
    ' mode (AppLocker/WDAC policy). Desktop control needs FullLanguage mode.')
  exit 3
}

$Utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::InputEncoding = $Utf8 } catch { }
try { [Console]::OutputEncoding = $Utf8 } catch { }

$script:IsWin = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

# ---------------------------------------------------------------- native bridge (C# 5, mscorlib types only)

$NativeSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AnywhereNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public int mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    // The union is as large as its largest member (MOUSEINPUT) and IntPtr-aligned, so
    // Marshal.SizeOf(INPUT) is 28 on 32-bit and 40 on 64-bit, matching sizeof(INPUT).
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    public class WinInfo
    {
        public long Hwnd;
        public string Title;
        public string ClassName;
        public uint Pid;
        public string ExePath;
        public string Process;
        public int X;
        public int Y;
        public int Width;
        public int Height;
        public bool Minimized;
        public bool Focused;
        public int Elevation;   // ELEVATION_NO, ELEVATION_YES or ELEVATION_UNKNOWN
    }

    /// A window whose input Windows' UIPI may drop (see CheckTarget).
    public class InputTarget
    {
        public int Elevation;   // ELEVATION_YES, or ELEVATION_UNKNOWN for a process this host may not inspect
        public string Name;
    }

    public class MonitorInfo
    {
        public string Device;
        public int X;
        public int Y;
        public int Width;
        public int Height;
        public bool Primary;
        public double DpiScale;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprcMonitor, IntPtr dwData);

    // ---- user32
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextLengthW")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);

    // ---- kernel32 / advapi32 / dwmapi / shcore
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW", SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder buffer, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetIntAttribute(IntPtr h, int attr, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetRectAttribute(IntPtr h, int attr, out RECT value, int size);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);

    // ---- clipboard (raw Win32: see ClipboardSetText)
    [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetClipboardData(uint format, IntPtr mem);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetOpenClipboardWindow();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalLock(IntPtr mem);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GlobalUnlock(IntPtr mem);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GlobalFree(IntPtr mem);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr mem);

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_XDOWN = 0x0080;
    const uint MOUSEEVENTF_XUP = 0x0100;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_HWHEEL = 0x1000;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const int WHEEL_DELTA = 120;
    const int SM_SWAPBUTTON = 23;
    const int SM_XVIRTUALSCREEN = 76;
    const int SM_YVIRTUALSCREEN = 77;
    const int SM_CXVIRTUALSCREEN = 78;
    const int SM_CYVIRTUALSCREEN = 79;
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_APPWINDOW = 0x00040000;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const uint GA_ROOT = 2;
    const uint GW_OWNER = 4;
    const int SW_MINIMIZE = 6;
    const int SW_RESTORE = 9;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOACTIVATE = 0x0010;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int DWMWA_CLOAKED = 14;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TOKEN_QUERY = 0x0008;
    const int TOKEN_ELEVATION_CLASS = 20;
    const int ERROR_ACCESS_DENIED = 5;
    public const int ELEVATION_NO = 0;
    public const int ELEVATION_YES = 1;
    public const int ELEVATION_UNKNOWN = 2;
    const byte VK_MENU = 0x12;
    const byte VK_UNASSIGNED = 0xE8;
    const ushort VK_RETURN = 0x0D;
    const ushort VK_TAB = 0x09;
    const uint CF_UNICODETEXT = 13;
    const uint GMEM_MOVEABLE = 0x0002;
    const int CLIPBOARD_OPEN_MS = 3000;

    public static string DpiMode = "unaware";

    static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));
    static readonly Dictionary<uint, string> PathCache = new Dictionary<uint, string>();
    static readonly Dictionary<uint, int> ElevationCache = new Dictionary<uint, int>();
    static readonly Dictionary<int, bool> ExtendedVk = BuildExtended();

    static Dictionary<int, bool> BuildExtended()
    {
        int[] codes = new int[] {
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D,
            0x6F, 0x90, 0xA3, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF,
            0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7 };
        Dictionary<int, bool> d = new Dictionary<int, bool>();
        foreach (int c in codes) d[c] = true;
        return d;
    }

    public static int InputStructSize() { return InputSize; }

    static InvalidOperationException Fail(string message, string code, string hint)
    {
        InvalidOperationException ex = new InvalidOperationException(message);
        if (code != null) ex.Data["anywhereCode"] = code;
        if (hint != null) ex.Data["anywhereHint"] = hint;
        return ex;
    }

    // ---------------------------------------------------------------- DPI

    /// Must run before System.Drawing / System.Windows.Forms load and before any screen query.
    public static string InitDpi()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { DpiMode = "permonitorv2"; return DpiMode; } } catch (Exception) { }
        try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) { DpiMode = "permonitorv2-thread"; return DpiMode; } } catch (Exception) { }
        try { if (SetProcessDpiAwareness(2) == 0) { DpiMode = "permonitor"; return DpiMode; } } catch (Exception) { }
        try { if (SetProcessDPIAware()) { DpiMode = "system"; return DpiMode; } } catch (Exception) { }
        return DpiMode;
    }

    static bool PerMonitorAware() { return DpiMode.StartsWith("permonitor", StringComparison.Ordinal); }

    // ---------------------------------------------------------------- input primitives

    static INPUT MouseInput(uint flags, int dx, int dy, int data)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.U.mi.dx = dx;
        i.U.mi.dy = dy;
        i.U.mi.mouseData = data;
        i.U.mi.dwFlags = flags;
        return i;
    }

    static INPUT KeyInput(ushort vk, ushort scan, uint flags)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk;
        i.U.ki.wScan = scan;
        i.U.ki.dwFlags = flags;
        return i;
    }

    static INPUT VkInput(int vk, bool up)
    {
        uint flags = up ? KEYEVENTF_KEYUP : 0;
        if (ExtendedVk.ContainsKey(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        ushort scan = (ushort)(MapVirtualKey((uint)vk, 0) & 0xFF);
        return KeyInput((ushort)vk, scan, flags);
    }

    static INPUT UnicodeInput(char c, bool up)
    {
        return KeyInput(0, (ushort)c, KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0));
    }

    static void Send(List<INPUT> list)
    {
        if (list.Count == 0) return;
        INPUT[] arr = list.ToArray();
        uint sent = SendInput((uint)arr.Length, arr, InputSize);
        if (sent != (uint)arr.Length)
        {
            int err = Marshal.GetLastWin32Error();
            throw Fail("SendInput injected " + sent + " of " + arr.Length + " input events (Win32 error " + err + ").",
                "INPUT_BLOCKED",
                "Input is blocked while a secure desktop is showing (UAC prompt, lock screen or Ctrl+Alt+Del screen). Ask the user to dismiss it.");
        }
    }

    static void SendOne(INPUT input)
    {
        List<INPUT> l = new List<INPUT>(1);
        l.Add(input);
        Send(l);
    }

    // ---------------------------------------------------------------- mouse

    public static int[] CursorPos()
    {
        POINT p;
        if (!GetCursorPos(out p)) throw Fail("GetCursorPos failed (Win32 error " + Marshal.GetLastWin32Error() + ").", "CURSOR_FAILED",
            "The cursor cannot be read while a secure desktop (UAC prompt or lock screen) is active.");
        return new int[] { p.X, p.Y };
    }

    public static void MoveTo(int x, int y)
    {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (vw > 1 && vh > 1)
        {
            // A real input event (so hover and raw-input listeners notice), then an exact SetCursorPos
            // to undo rounding in the 0..65535 normalized space.
            int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
            int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
            nx = Math.Max(0, Math.Min(65535, nx));
            ny = Math.Max(0, Math.Min(65535, ny));
            try { SendOne(MouseInput(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0)); } catch (Exception) { }
        }
        if (!SetCursorPos(x, y))
            throw Fail("SetCursorPos(" + x + ", " + y + ") failed (Win32 error " + Marshal.GetLastWin32Error() + ").", "INPUT_BLOCKED",
                "The mouse cannot be moved while a secure desktop (UAC prompt or lock screen) is active.");
    }

    static void ButtonFlags(string button, out uint down, out uint up, out int data)
    {
        string b = (button ?? "left").Trim().ToLowerInvariant();
        data = 0;
        // SendInput buttons are physical; honour the "swap primary and secondary buttons" setting so
        // "left" always means the primary button.
        bool swapped = GetSystemMetrics(SM_SWAPBUTTON) != 0;
        if (b == "left" || b == "primary") b = swapped ? "phys-right" : "phys-left";
        else if (b == "right" || b == "secondary") b = swapped ? "phys-left" : "phys-right";
        switch (b)
        {
            case "phys-left": down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; return;
            case "phys-right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; return;
            case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; return;
            case "x1": case "back": down = MOUSEEVENTF_XDOWN; up = MOUSEEVENTF_XUP; data = 1; return;
            case "x2": case "forward": down = MOUSEEVENTF_XDOWN; up = MOUSEEVENTF_XUP; data = 2; return;
        }
        throw Fail("Unknown mouse button '" + button + "'.", "BAD_ARGS", "Use left, right, middle, x1 or x2.");
    }

    public static void Button(string button, bool up)
    {
        uint d, u; int data;
        ButtonFlags(button, out d, out u, out data);
        SendOne(MouseInput(up ? u : d, 0, 0, data));
    }

    static void PressVks(int[] vks, bool up)
    {
        if (vks == null) return;
        List<INPUT> l = new List<INPUT>();
        if (up) { for (int i = vks.Length - 1; i >= 0; i--) l.Add(VkInput(vks[i], true)); }
        else { for (int i = 0; i < vks.Length; i++) l.Add(VkInput(vks[i], false)); }
        Send(l);
    }

    public static void Click(string button, int clicks, int[] modifiers)
    {
        uint d, u; int data;
        ButtonFlags(button, out d, out u, out data);
        if (clicks < 1) clicks = 1;
        if (clicks > 10) clicks = 10;
        ValidateVks(modifiers);
        bool pressed = false;
        try
        {
            if (modifiers != null && modifiers.Length > 0) { PressVks(modifiers, false); pressed = true; Thread.Sleep(15); }
            for (int i = 0; i < clicks; i++)
            {
                List<INPUT> l = new List<INPUT>(2);
                l.Add(MouseInput(d, 0, 0, data));
                l.Add(MouseInput(u, 0, 0, data));
                Send(l);
                if (i < clicks - 1) Thread.Sleep(40);
            }
        }
        finally
        {
            if (pressed) { Thread.Sleep(15); PressVks(modifiers, true); }
        }
    }

    public static void Drag(int x1, int y1, int x2, int y2, string button, int steps)
    {
        uint d, u; int data;
        ButtonFlags(button, out d, out u, out data);
        if (steps < 2) steps = 2;
        if (steps > 200) steps = 200;
        MoveTo(x1, y1);
        Thread.Sleep(40);
        SendOne(MouseInput(d, 0, 0, data));
        try
        {
            Thread.Sleep(60);
            for (int i = 1; i <= steps; i++)
            {
                int x = x1 + (int)Math.Round((x2 - x1) * (double)i / steps);
                int y = y1 + (int)Math.Round((y2 - y1) * (double)i / steps);
                MoveTo(x, y);
                Thread.Sleep(12);
            }
            Thread.Sleep(60);
        }
        finally
        {
            SendOne(MouseInput(u, 0, 0, data));
        }
    }

    /// dy > 0 scrolls down, dx > 0 scrolls right; one event per notch.
    public static void Scroll(int dx, int dy)
    {
        int ny = Math.Min(Math.Abs(dy), 200);
        int nx = Math.Min(Math.Abs(dx), 200);
        for (int i = 0; i < ny; i++)
        {
            SendOne(MouseInput(MOUSEEVENTF_WHEEL, 0, 0, dy > 0 ? -WHEEL_DELTA : WHEEL_DELTA));
            Thread.Sleep(15);
        }
        for (int i = 0; i < nx; i++)
        {
            SendOne(MouseInput(MOUSEEVENTF_HWHEEL, 0, 0, dx > 0 ? WHEEL_DELTA : -WHEEL_DELTA));
            Thread.Sleep(15);
        }
    }

    // ---------------------------------------------------------------- keyboard

    static void ValidateVks(int[] vks)
    {
        if (vks == null) return;
        foreach (int vk in vks)
            if (vk < 1 || vk > 254) throw Fail("Invalid virtual-key code " + vk + ".", "BAD_ARGS", "Virtual-key codes are 1..254.");
    }

    /// Press the keys in order and release them in reverse order.
    public static void Keys(int[] vks)
    {
        if (vks == null || vks.Length == 0) throw Fail("No keys given.", "BAD_ARGS", null);
        ValidateVks(vks);
        try
        {
            PressVks(vks, false);
            Thread.Sleep(20);
        }
        finally
        {
            PressVks(vks, true);
        }
    }

    /// Type literal text with KEYEVENTF_UNICODE. Newlines become Enter and tabs become Tab; surrogate
    /// pairs are sent back to back and never split across batches.
    public static int TypeText(string text, int batchChars, int delayMs)
    {
        if (string.IsNullOrEmpty(text)) return 0;
        if (batchChars < 1) batchChars = 1;
        List<INPUT> batch = new List<INPUT>();
        int units = 0;
        int typed = 0;
        int i = 0;
        while (i < text.Length)
        {
            char c = text[i];
            if (c == '\r' || c == '\n')
            {
                batch.Add(VkInput(VK_RETURN, false));
                batch.Add(VkInput(VK_RETURN, true));
                i += (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') ? 2 : 1;
            }
            else if (c == '\t')
            {
                batch.Add(VkInput(VK_TAB, false));
                batch.Add(VkInput(VK_TAB, true));
                i++;
            }
            else if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                char lo = text[i + 1];
                batch.Add(UnicodeInput(c, false));
                batch.Add(UnicodeInput(lo, false));
                batch.Add(UnicodeInput(c, true));
                batch.Add(UnicodeInput(lo, true));
                i += 2;
            }
            else
            {
                batch.Add(UnicodeInput(c, false));
                batch.Add(UnicodeInput(c, true));
                i++;
            }
            units++;
            typed++;
            if (units >= batchChars)
            {
                Send(batch);
                batch.Clear();
                units = 0;
                if (delayMs > 0) Thread.Sleep(delayMs);
            }
        }
        Send(batch);
        return typed;
    }

    // ---------------------------------------------------------------- windows

    static string WindowTitle(IntPtr h)
    {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        if (len > 4096) len = 4096;
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string WindowClass(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static bool IsCloaked(IntPtr h)
    {
        try
        {
            int cloaked;
            return DwmGetIntAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
        }
        catch (Exception) { return false; }
    }

    public static string ProcessPath(uint pid)
    {
        if (pid == 0) return "";
        string cached;
        if (PathCache.TryGetValue(pid, out cached)) return cached;
        string path = "";
        IntPtr hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (hp != IntPtr.Zero)
        {
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                uint size = (uint)sb.Capacity;
                if (QueryFullProcessImageName(hp, 0, sb, ref size)) path = sb.ToString();
            }
            finally { CloseHandle(hp); }
        }
        if (PathCache.Count > 2048) PathCache.Clear();
        PathCache[pid] = path;
        return path;
    }

    /// ELEVATION_YES or ELEVATION_NO when the process token can be read. ELEVATION_UNKNOWN when Windows
    /// denies access to the process or its token: typically a process of another account (an installer
    /// started with an administrator's credentials at the UAC prompt, or "Run as different user"), which
    /// may or may not be elevated. Only definite answers are cached.
    public static int ElevationState(uint pid)
    {
        if (pid == 0) return ELEVATION_NO;
        int cached;
        if (ElevationCache.TryGetValue(pid, out cached)) return cached;
        int state = -1;
        bool denied = false;
        IntPtr hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (hp == IntPtr.Zero) denied = Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED;
        else
        {
            try
            {
                IntPtr token;
                if (!OpenProcessToken(hp, TOKEN_QUERY, out token)) denied = Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED;
                else
                {
                    try
                    {
                        int value, returned;
                        if (GetTokenInformation(token, TOKEN_ELEVATION_CLASS, out value, 4, out returned)) state = value != 0 ? ELEVATION_YES : ELEVATION_NO;
                        else denied = Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED;
                    }
                    finally { CloseHandle(token); }
                }
            }
            finally { CloseHandle(hp); }
        }
        if (state < 0) return denied ? ELEVATION_UNKNOWN : ELEVATION_NO;
        if (ElevationCache.Count > 2048) ElevationCache.Clear();
        ElevationCache[pid] = state;
        return state;
    }

    public static bool HostElevated()
    {
        try { return ElevationState(GetCurrentProcessId()) == ELEVATION_YES; } catch (Exception) { return false; }
    }

    // UWP apps live in an ApplicationFrameHost frame; the real app owns a CoreWindow child.
    static uint UwpChildPid(IntPtr frame, uint framePid)
    {
        uint found = 0;
        EnumWindowsProc cb = delegate(IntPtr child, IntPtr lp)
        {
            uint pid;
            GetWindowThreadProcessId(child, out pid);
            if (pid != 0 && pid != framePid) { found = pid; return false; }
            return true;
        };
        try { EnumChildWindows(frame, cb, IntPtr.Zero); } catch (Exception) { }
        GC.KeepAlive(cb);
        return found;
    }

    static WinInfo Describe(IntPtr h, IntPtr fg, bool filter)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return null;
        string cls = WindowClass(h);
        if (filter)
        {
            if (!IsWindowVisible(h)) return null;
            if (GetAncestor(h, GA_ROOT) != h) return null;
            int ex = GetWindowLong(h, GWL_EXSTYLE);
            bool appWindow = (ex & WS_EX_APPWINDOW) != 0;
            if ((ex & WS_EX_TOOLWINDOW) != 0 && !appWindow) return null;
            if ((ex & WS_EX_NOACTIVATE) != 0 && !appWindow) return null;
            if (IsCloaked(h)) return null;
            if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return null;
            // Owned windows (dialogs) are kept only when they have a caption of their own.
            IntPtr owner = GetWindow(h, GW_OWNER);
            if (owner != IntPtr.Zero && !appWindow && GetWindowTextLength(h) <= 0) return null;
        }
        WinInfo w = new WinInfo();
        w.Hwnd = h.ToInt64();
        w.Title = WindowTitle(h);
        if (filter && w.Title.Length == 0) return null;
        w.ClassName = cls;
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (cls == "ApplicationFrameWindow")
        {
            uint real = UwpChildPid(h, pid);
            if (real != 0) pid = real;
        }
        w.Pid = pid;
        w.ExePath = ProcessPath(pid);
        w.Process = w.ExePath.Length > 0 ? Path.GetFileName(w.ExePath) : "";
        w.Minimized = IsIconic(h);
        w.Focused = h == fg;
        w.Elevation = ElevationState(pid);
        RECT r = new RECT();
        bool haveRect = false;
        if (w.Minimized)
        {
            WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
            wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
            if (GetWindowPlacement(h, ref wp)) { r = wp.rcNormalPosition; haveRect = true; }
        }
        else if (PerMonitorAware())
        {
            // The visible frame, without the invisible resize borders GetWindowRect includes.
            try { haveRect = DwmGetRectAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0; } catch (Exception) { haveRect = false; }
        }
        if (!haveRect) GetWindowRect(h, out r);
        w.X = r.Left;
        w.Y = r.Top;
        w.Width = Math.Max(0, r.Right - r.Left);
        w.Height = Math.Max(0, r.Bottom - r.Top);
        if (filter && !w.Minimized && (w.Width == 0 || w.Height == 0)) return null;
        return w;
    }

    public static WinInfo[] ListWindows()
    {
        List<WinInfo> result = new List<WinInfo>();
        IntPtr fg = GetForegroundWindow();
        EnumWindowsProc cb = delegate(IntPtr h, IntPtr lp)
        {
            try
            {
                WinInfo w = Describe(h, fg, true);
                if (w != null) result.Add(w);
            }
            catch (Exception) { }
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return result.ToArray();
    }

    public static WinInfo Active()
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return null;
        return Describe(fg, fg, false);
    }

    static bool WaitForeground(IntPtr h, int ms)
    {
        int waited = 0;
        while (true)
        {
            if (GetForegroundWindow() == h) return true;
            if (waited >= ms) return false;
            Thread.Sleep(20);
            waited += 20;
        }
    }

    // Tap Alt with an unassigned key in between so no menu bar activates; any keyboard input
    // satisfies the foreground-lock rule that otherwise makes SetForegroundWindow fail.
    static void AltTap()
    {
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_UNASSIGNED, 0, 0, UIntPtr.Zero);
        keybd_event(VK_UNASSIGNED, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static bool Focus(IntPtr h)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return false;
        if (IsIconic(h))
        {
            ShowWindow(h, SW_RESTORE);
            Thread.Sleep(60);
        }
        if (GetForegroundWindow() == h) return true;
        if (SetForegroundWindow(h) && WaitForeground(h, 250)) return true;
        for (int attempt = 0; attempt < 2; attempt++)
        {
            uint current = GetCurrentThreadId();
            IntPtr fg = GetForegroundWindow();
            uint ignored;
            uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out ignored);
            bool attached = false;
            try
            {
                if (fgThread != 0 && fgThread != current) attached = AttachThreadInput(current, fgThread, true);
                AltTap();
                BringWindowToTop(h);
                SetForegroundWindow(h);
            }
            finally
            {
                if (attached) AttachThreadInput(current, fgThread, false);
            }
            if (WaitForeground(h, 400)) return true;
        }
        return false;
    }

    public static bool Minimize(IntPtr h)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return false;
        ShowWindow(h, SW_MINIMIZE);
        for (int i = 0; i < 15 && !IsIconic(h); i++) Thread.Sleep(20);
        return IsIconic(h);
    }

    public static bool Topmost(IntPtr h, bool on)
    {
        if (h == IntPtr.Zero || !IsWindow(h)) return false;
        IntPtr after = new IntPtr(on ? -1 : -2);
        return SetWindowPos(h, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    /// Non-null when Windows' UIPI may silently drop injected input (SendInput still reports success):
    /// this host is not elevated and the target window (under the point, or the foreground window)
    /// belongs to an elevated process (ELEVATION_YES) or to a process it may not inspect, typically
    /// another account's (ELEVATION_UNKNOWN). Such a process may run unelevated and accept the input.
    public static InputTarget CheckTarget(int x, int y, bool foreground, bool hostElevated)
    {
        if (hostElevated) return null;
        IntPtr h;
        if (foreground) h = GetForegroundWindow();
        else
        {
            POINT p = new POINT();
            p.X = x;
            p.Y = y;
            h = WindowFromPoint(p);
        }
        if (h == IntPtr.Zero) return null;
        IntPtr root = GetAncestor(h, GA_ROOT);
        if (root != IntPtr.Zero) h = root;
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (pid == 0) return null;
        int state = ElevationState(pid);
        if (state == ELEVATION_NO) return null;
        string exe = ProcessPath(pid);
        string name = exe.Length > 0 ? Path.GetFileName(exe) : ("pid " + pid);
        string title = WindowTitle(h);
        InputTarget t = new InputTarget();
        t.Elevation = state;
        t.Name = title.Length > 0 ? (title + " (" + name + ")") : name;
        return t;
    }

    // ---------------------------------------------------------------- clipboard

    // The clipboard is opened with no owner window. Whoever empties the clipboard becomes its owner,
    // and Windows sends the owner WM_DESTROYCLIPBOARD (synchronously) when another program empties
    // it on its next copy. This host's thread waits on stdin and never pumps messages, so with an
    // owner window here (Set-Clipboard / WinForms make OLE's window the owner) every later Ctrl+C in
    // any app blocked inside EmptyClipboard, holding the clipboard open, until this host happened to
    // touch the clipboard again. With no owner nothing is sent to this process.

    static string ClipboardHolder()
    {
        IntPtr h = GetOpenClipboardWindow();
        if (h == IntPtr.Zero) return "";
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        string exe = ProcessPath(pid);
        return " (held open by " + (exe.Length > 0 ? Path.GetFileName(exe) : "pid " + pid) + ")";
    }

    static void OpenClip()
    {
        int waited = 0;
        while (!OpenClipboard(IntPtr.Zero))
        {
            if (waited >= CLIPBOARD_OPEN_MS)
                throw Fail("The clipboard is in use by another program" + ClipboardHolder() + ".", "CLIPBOARD_BUSY",
                    "Try again in a moment. A clipboard manager or a hung app can keep the clipboard open.");
            Thread.Sleep(20);
            waited += 20;
        }
    }

    /// The clipboard's Unicode text, or "" when it holds no text.
    public static string ClipboardGetText()
    {
        OpenClip();
        try
        {
            if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return "";
            IntPtr h = GetClipboardData(CF_UNICODETEXT);
            if (h == IntPtr.Zero) return "";
            IntPtr p = GlobalLock(h);
            if (p == IntPtr.Zero) return "";
            try
            {
                long chars = (long)(GlobalSize(h).ToUInt64() / 2);
                if (chars <= 0) return "";
                string s = Marshal.PtrToStringUni(p, (int)Math.Min(chars, int.MaxValue));
                // The text ends at the first NUL; the memory block may be larger than the string.
                int nul = s.IndexOf('\0');
                return nul >= 0 ? s.Substring(0, nul) : s;
            }
            finally { GlobalUnlock(h); }
        }
        finally { CloseClipboard(); }
    }

    /// Replace the clipboard with text ("" empties it). Windows adds CF_TEXT, CF_OEMTEXT and CF_LOCALE.
    public static void ClipboardSetText(string text)
    {
        OpenClip();
        try
        {
            if (!EmptyClipboard())
                throw Fail("EmptyClipboard failed (Win32 error " + Marshal.GetLastWin32Error() + ").", "CLIPBOARD_FAILED", null);
            if (string.IsNullOrEmpty(text)) return;
            IntPtr mem = GlobalAlloc(GMEM_MOVEABLE, new UIntPtr((ulong)(text.Length + 1) * 2));
            if (mem == IntPtr.Zero) throw Fail("GlobalAlloc failed for the clipboard text.", "CLIPBOARD_FAILED", null);
            bool handedOver = false;
            try
            {
                IntPtr p = GlobalLock(mem);
                if (p == IntPtr.Zero) throw Fail("GlobalLock failed for the clipboard text.", "CLIPBOARD_FAILED", null);
                try
                {
                    Marshal.Copy(text.ToCharArray(), 0, p, text.Length);
                    Marshal.WriteInt16(p, text.Length * 2, 0);
                }
                finally { GlobalUnlock(mem); }
                if (SetClipboardData(CF_UNICODETEXT, mem) == IntPtr.Zero)
                    throw Fail("SetClipboardData failed (Win32 error " + Marshal.GetLastWin32Error() + ").", "CLIPBOARD_FAILED", null);
                handedOver = true; // the system owns the memory now
            }
            finally { if (!handedOver) GlobalFree(mem); }
        }
        finally { CloseClipboard(); }
    }

    // ---------------------------------------------------------------- monitors

    public static MonitorInfo[] Monitors()
    {
        List<MonitorInfo> list = new List<MonitorInfo>();
        MonitorEnumProc cb = delegate(IntPtr hm, IntPtr hdc, IntPtr rc, IntPtr data)
        {
            MONITORINFOEX mi = new MONITORINFOEX();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(hm, ref mi))
            {
                MonitorInfo m = new MonitorInfo();
                m.Device = mi.szDevice ?? "";
                m.X = mi.rcMonitor.Left;
                m.Y = mi.rcMonitor.Top;
                m.Width = mi.rcMonitor.Right - mi.rcMonitor.Left;
                m.Height = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
                m.Primary = (mi.dwFlags & 1) != 0;
                m.DpiScale = 1.0;
                try
                {
                    uint dx, dy;
                    if (GetDpiForMonitor(hm, 0, out dx, out dy) == 0 && dx > 0) m.DpiScale = dx / 96.0;
                }
                catch (Exception) { }
                list.Add(m);
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        list.Sort(delegate(MonitorInfo a, MonitorInfo b)
        {
            if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
            if (a.X != b.X) return a.X.CompareTo(b.X);
            return a.Y.CompareTo(b.Y);
        });
        return list.ToArray();
    }
}
'@

$script:NativeOk = $false
$script:NativeError = $null
$script:NativeTriedAt = [DateTime]::MinValue
$script:HostElevated = $false

function Import-Native {
  if (-not ('AnywhereNative' -as [type])) {
    Add-Type -TypeDefinition $NativeSource -Language CSharp
  }
}

if ($env:ANYWHERE_HOST_SELFTEST -eq 'compile') {
  try {
    Import-Native
    if (-not ('AnywhereNative' -as [type])) { throw 'AnywhereNative type missing after Add-Type' }
    $Host.UI.WriteErrorLine('selftest ok: INPUT size ' + [AnywhereNative]::InputStructSize())
    exit 0
  } catch {
    $Host.UI.WriteErrorLine('selftest failed: ' + $_.Exception.Message)
    exit 2
  }
}

# Compile the Win32 bridge. Called at startup and again by Assert-Native (at most every 5 s) while
# it has not succeeded: a transient Add-Type failure, such as CS0016 while an antivirus scanner
# holds the temp DLL, must not disable the host for the rest of its life. A failed Add-Type
# registers no type, so a retry is safe.
function Initialize-Native {
  $script:NativeTriedAt = [DateTime]::UtcNow
  try {
    Import-Native
    [void][AnywhereNative]::InitDpi()
    $script:NativeOk = $true
    $script:NativeError = $null
    if ($script:IsWin) { $script:HostElevated = [AnywhereNative]::HostElevated() }
  } catch {
    $script:NativeError = $_.Exception.Message
  }
}

Initialize-Native

# ---------------------------------------------------------------- helpers

function New-HostError([string]$Message, [string]$Code, [string]$Hint) {
  $ex = New-Object System.InvalidOperationException -ArgumentList $Message
  if ($Code) { $ex.Data['anywhereCode'] = $Code }
  if ($Hint) { $ex.Data['anywhereHint'] = $Hint }
  return $ex
}

function Assert-Windows {
  if (-not $script:IsWin) {
    throw (New-HostError 'This command needs Windows; the host is running on a different OS.' 'UNSUPPORTED' 'Run Claude Anywhere on Windows or WSL to control the Windows desktop.')
  }
}

function Assert-Native {
  Assert-Windows
  if (-not $script:NativeOk -and ([DateTime]::UtcNow - $script:NativeTriedAt).TotalSeconds -ge 5) { Initialize-Native }
  if (-not $script:NativeOk) {
    throw (New-HostError ('The Windows API bridge failed to compile: ' + $script:NativeError) 'NATIVE_UNAVAILABLE' 'Check that PowerShell can run Add-Type (it needs the .NET C# compiler and a writable TEMP folder).')
  }
}

function Get-Arg($A, [string]$Name, $Default = $null) {
  if ($null -eq $A) { return $Default }
  $p = $A.PSObject.Properties[$Name]
  if ($null -eq $p -or $null -eq $p.Value) { return $Default }
  return $p.Value
}

function Get-IntArg($A, [string]$Name, $Default = $null) {
  $v = Get-Arg $A $Name $Default
  if ($null -eq $v) { throw (New-HostError ("Missing numeric argument '" + $Name + "'.") 'BAD_ARGS' $null) }
  try { return [int][Math]::Round([double]$v) } catch { throw (New-HostError ("Argument '" + $Name + "' must be a number.") 'BAD_ARGS' $null) }
}

function Get-IntList($A, [string]$Name) {
  $raw = @(Get-Arg $A $Name @())
  $list = New-Object 'System.Collections.Generic.List[int]'
  foreach ($v in $raw) { $list.Add([int]$v) }
  return ,($list.ToArray())
}

function Get-Hwnd($A) {
  $s = [string](Get-Arg $A 'hwnd' '')
  if ($s -notmatch '^-?\d{1,20}$') { throw (New-HostError ("Invalid window id '" + $s + "'.") 'BAD_ARGS' 'Use an id returned by the windows command.') }
  return New-Object System.IntPtr -ArgumentList ([long]$s)
}

$script:DrawingLoaded = $false
$script:FormsLoaded = $false

function Use-Drawing {
  if (-not $script:DrawingLoaded) {
    Add-Type -AssemblyName System.Drawing
    $script:DrawingLoaded = $true
  }
}

function Use-Forms {
  if (-not $script:FormsLoaded) {
    Use-Drawing
    Add-Type -AssemblyName System.Windows.Forms
    $script:FormsLoaded = $true
  }
}

function Test-Sta {
  return [System.Threading.Thread]::CurrentThread.GetApartmentState() -eq [System.Threading.ApartmentState]::STA
}

$script:AppCache = @{}

function Get-AppName([string]$Path, [string]$Fallback) {
  if (-not $Path) { return $Fallback }
  if ($script:AppCache.ContainsKey($Path)) { return $script:AppCache[$Path] }
  $name = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $desc = $null
  try {
    $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    $desc = [string]$vi.FileDescription
    if (-not $desc.Trim()) { $desc = [string]$vi.ProductName }
  } catch { $desc = $null }
  if ($desc -and $desc.Trim()) { $app = $desc.Trim() } else { $app = $name }
  if ($script:AppCache.Count -gt 1024) { $script:AppCache.Clear() }
  $script:AppCache[$Path] = $app
  return $app
}

function ConvertTo-WindowRecord($W) {
  $proc = [string]$W.Process
  $fallback = if ($proc) { [System.IO.Path]::GetFileNameWithoutExtension($proc) } else { '' }
  # null: the process belongs to another account and Windows does not say whether it is elevated.
  $elevated = $null
  if ([int]$W.Elevation -ne 2) { $elevated = [bool]([int]$W.Elevation -eq 1) }
  return [ordered]@{
    hwnd = [string]$W.Hwnd
    app = [string](Get-AppName ([string]$W.ExePath) $fallback)
    process = $proc
    title = [string]$W.Title
    pid = [long]$W.Pid
    x = [int]$W.X
    y = [int]$W.Y
    width = [int]$W.Width
    height = [int]$W.Height
    focused = [bool]$W.Focused
    minimized = [bool]$W.Minimized
    elevated = $elevated
    className = [string]$W.ClassName
  }
}

# Warnings for the current request; the main loop clears them and adds them to the result.
$script:Warnings = New-Object 'System.Collections.Generic.List[string]'

function Add-HostWarning([string]$Text) {
  if ($Text -and -not $script:Warnings.Contains($Text)) { [void]$script:Warnings.Add($Text) }
}

function Add-ResultWarnings($Result) {
  if ($script:Warnings.Count -gt 0 -and $Result -is [System.Collections.IDictionary]) {
    $Result['warnings'] = $script:Warnings.ToArray()
  }
}

# $Target is an [AnywhereNative+InputTarget] (or $null): Elevation 1 = elevated, 2 = unknown.
function Confirm-InputTarget($Target) {
  if ($null -eq $Target) { return }
  if ([int]$Target.Elevation -eq 1) {
    throw (New-HostError ("Windows blocks input to '" + $Target.Name + "' because it runs as administrator and Claude Anywhere does not.") 'UIPI_BLOCKED' 'Interact with that window yourself, or restart your terminal and Claude Code with "Run as administrator" if you want Claude to control elevated apps.')
  }
  # Another account's process (UAC prompt answered with an administrator's credentials, or "Run as
  # different user"): it may be unelevated and accept input, so warn instead of refusing.
  Add-HostWarning ("'" + $Target.Name + "' belongs to another user account, so Claude Anywhere cannot tell whether it runs as administrator. " +
    'If nothing happened, it probably does and Windows (UIPI) silently dropped the input: ask the user to do this step in that window themselves.')
}

function Assert-InputAllowed([bool]$Foreground, [int]$X, [int]$Y) {
  Confirm-InputTarget ([AnywhereNative]::CheckTarget($X, $Y, $Foreground, $script:HostElevated))
}

# ---------------------------------------------------------------- notifications (background runspace)

$script:NotifyPool = $null
$script:NotifyJobs = New-Object System.Collections.ArrayList

$NotifyScript = @'
param($Title, $Body, $Ms)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$icon = New-Object System.Windows.Forms.NotifyIcon
try {
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Text = 'Claude Anywhere'
  $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $icon.BalloonTipTitle = $Title
  $icon.BalloonTipText = $Body
  $icon.Visible = $true
  $icon.ShowBalloonTip($Ms)
  Start-Sleep -Milliseconds $Ms
} finally {
  $icon.Visible = $false
  $icon.Dispose()
}
'@

function Clear-NotifyJobs([bool]$All) {
  for ($i = $script:NotifyJobs.Count - 1; $i -ge 0; $i--) {
    $job = $script:NotifyJobs[$i]
    if ($All -or $job.Handle.IsCompleted) {
      if ($All -and -not $job.Handle.IsCompleted) { [void]$job.Handle.AsyncWaitHandle.WaitOne(1500) }
      try { [void]$job.PS.EndInvoke($job.Handle) } catch { }
      try { $job.PS.Dispose() } catch { }
      $script:NotifyJobs.RemoveAt($i)
    }
  }
}

function Show-Notification([string]$Title, [string]$Body) {
  Assert-Windows
  Use-Forms
  if (-not $Title) { $Title = 'Claude Anywhere' }
  if (-not $Body) { $Body = $Title }
  if ($Title.Length -gt 63) { $Title = $Title.Substring(0, 62) + '.' }
  if ($Body.Length -gt 255) { $Body = $Body.Substring(0, 254) + '.' }
  if ($null -eq $script:NotifyPool) {
    $pool = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, 4)
    $pool.ApartmentState = [System.Threading.ApartmentState]::STA
    $pool.Open()
    $script:NotifyPool = $pool
  }
  $ps = [System.Management.Automation.PowerShell]::Create()
  $ps.RunspacePool = $script:NotifyPool
  [void]$ps.AddScript($NotifyScript).AddArgument($Title).AddArgument($Body).AddArgument(6000)
  $handle = $ps.BeginInvoke()
  [void]$script:NotifyJobs.Add(@{ PS = $ps; Handle = $handle })
  return @{ shown = $true }
}

# ---------------------------------------------------------------- clipboard

# The clipboard goes through the native bridge (no owner window, see AnywhereNative.ClipboardSetText):
# Get-Clipboard / Set-Clipboard and WinForms make this non-pumping thread the clipboard owner, which
# stalls other apps' copies, and they report a clipboard held open by another app as empty. The
# cmdlets remain only as a fallback while the bridge has not compiled.
function Test-NativeClipboard {
  if (-not $script:NativeOk -and ([DateTime]::UtcNow - $script:NativeTriedAt).TotalSeconds -ge 5) { Initialize-Native }
  return [bool]$script:NativeOk
}

function Get-ClipText {
  Assert-Windows
  if (Test-NativeClipboard) { return [string][AnywhereNative]::ClipboardGetText() }
  $last = $null
  if (Get-Command Get-Clipboard -ErrorAction SilentlyContinue) {
    for ($i = 0; $i -lt 3; $i++) {
      try {
        $t = Get-Clipboard -Raw
        if ($null -eq $t) { return '' }
        return [string]$t
      } catch { $last = $_.Exception.Message; Start-Sleep -Milliseconds 80 }
    }
  }
  if (Test-Sta) {
    Use-Forms
    for ($i = 0; $i -lt 5; $i++) {
      try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
          return [string][System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
        }
        return ''
      } catch { $last = $_.Exception.Message; Start-Sleep -Milliseconds 80 }
    }
  }
  throw (New-HostError ('Could not read the clipboard: ' + $last) 'CLIPBOARD_FAILED' 'Another application may be holding the clipboard open; try again.')
}

function Set-ClipText([string]$Text) {
  Assert-Windows
  if (Test-NativeClipboard) {
    [AnywhereNative]::ClipboardSetText($Text)
    return @{ ok = $true }
  }
  $last = $null
  if (Get-Command Set-Clipboard -ErrorAction SilentlyContinue) {
    for ($i = 0; $i -lt 3; $i++) {
      try {
        if ($Text.Length -eq 0) {
          if (Test-Sta) { Use-Forms; [System.Windows.Forms.Clipboard]::Clear() } else { Set-Clipboard -Value $null }
        } else {
          Set-Clipboard -Value $Text
        }
        return @{ ok = $true }
      } catch { $last = $_.Exception.Message; Start-Sleep -Milliseconds 80 }
    }
  }
  if (Test-Sta) {
    Use-Forms
    try {
      if ($Text.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() }
      else { [System.Windows.Forms.Clipboard]::SetDataObject($Text, $true, 10, 100) }
      return @{ ok = $true }
    } catch { $last = $_.Exception.Message }
  }
  throw (New-HostError ('Could not set the clipboard: ' + $last) 'CLIPBOARD_FAILED' 'Another application may be holding the clipboard open; try again.')
}

# ---------------------------------------------------------------- screen

function Get-Displays {
  Assert-Native
  $list = New-Object System.Collections.ArrayList
  $mons = @([AnywhereNative]::Monitors())
  if ($mons.Count -eq 0) {
    Use-Forms
    $screens = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object -Property @{ Expression = { -not $_.Primary } }, @{ Expression = { $_.Bounds.X } }, @{ Expression = { $_.Bounds.Y } })
    foreach ($s in $screens) {
      $mons += New-Object PSObject -Property @{ Device = $s.DeviceName; X = $s.Bounds.X; Y = $s.Bounds.Y; Width = $s.Bounds.Width; Height = $s.Bounds.Height; Primary = $s.Primary; DpiScale = 1.0 }
    }
  }
  $i = 0
  foreach ($m in $mons) {
    [void]$list.Add([ordered]@{
      index = $i
      id = [string]$m.Device
      x = [int]$m.X
      y = [int]$m.Y
      width = [int]$m.Width
      height = [int]$m.Height
      scale = 1
      dpiScale = [double]$m.DpiScale
      primary = [bool]$m.Primary
    })
    $i++
  }
  # The leading comma stops PowerShell from unrolling the list (one display must stay an array).
  return ,$list
}

function Get-Capture($A) {
  $displays = Get-Displays
  $index = Get-IntArg $A 'index' 0
  if ($index -lt 0 -or $index -ge $displays.Count) {
    throw (New-HostError ('Display ' + $index + ' does not exist (' + $displays.Count + ' connected).') 'BAD_DISPLAY' 'Call displays to list the connected screens.')
  }
  $d = $displays[$index]
  $x = [int]$d.x; $y = [int]$d.y; $w = [int]$d.width; $h = [int]$d.height
  Use-Drawing
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size -ArgumentList $w, $h), [System.Drawing.CopyPixelOperation]::SourceCopy)
    } catch {
      throw (New-HostError ('Screen capture failed: ' + $_.Exception.Message) 'CAPTURE_FAILED' 'The screen cannot be captured while the workstation is locked or a UAC prompt is showing.')
    } finally {
      $g.Dispose()
    }
    $ms = New-Object System.IO.MemoryStream
    try {
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $b64 = [Convert]::ToBase64String($ms.GetBuffer(), 0, [int]$ms.Length)
    } finally {
      $ms.Dispose()
    }
  } finally {
    $bmp.Dispose()
  }
  return @{ width = $w; height = $h; png = $b64 }
}

# ---------------------------------------------------------------- browser address bar (UI Automation)

# Loaded on first use only: most sessions never read a browser tab.
$script:UiaLoaded = $false

function Use-Uia {
  if (-not $script:UiaLoaded) {
    try {
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
    } catch {
      throw (New-HostError ('UI Automation is not available in this PowerShell: ' + $_.Exception.Message) 'UNSUPPORTED' 'The address is read with the keyboard instead.')
    }
    $script:UiaLoaded = $true
  }
}

# Accessible names of the address bar in common locales ("Address and search bar", "Search with
# Google or enter address", "Adress- und Suchleiste", ...). Without a match the first Edit outside
# the page wins: the address bar comes first in the toolbar of Chromium browsers and Firefox.
$script:AddressBarName = '(?i)address|adress|adresse|direcci|indirizzo|endere|search|suche|recherche|busca|cerca|url|location'

# Breadth-first walk of the window's control view, skipping page content (Document subtrees), for
# an Edit control with a ValuePattern. Bounded by time and node count: a slow browser never stalls the host.
function Find-AddressBar($Root, [int]$BudgetMs, [int]$MaxNodes) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $editId = [System.Windows.Automation.ControlType]::Edit.Id
  $docId = [System.Windows.Automation.ControlType]::Document.Id
  $valuePattern = [System.Windows.Automation.ValuePattern]::Pattern
  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $queue.Enqueue([object[]]@($Root, 0))
  $first = $null
  $seen = 0
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($queue.Count -gt 0 -and $sw.ElapsedMilliseconds -lt $BudgetMs -and $seen -lt $MaxNodes) {
    $item = $queue.Dequeue()
    $depth = [int]$item[1]
    $child = $null
    try { $child = $walker.GetFirstChild($item[0]) } catch { $child = $null }
    while ($null -ne $child -and $seen -lt $MaxNodes) {
      $seen++
      $typeId = -1
      try { $typeId = [int]$child.Current.ControlType.Id } catch { $typeId = -1 }
      if ($typeId -eq $editId) {
        $pattern = $null
        $hasValue = $false
        try { $hasValue = $child.TryGetCurrentPattern($valuePattern, [ref]$pattern) } catch { $hasValue = $false }
        if ($hasValue) {
          $name = ''
          try { $name = [string]$child.Current.Name } catch { $name = '' }
          $found = @{ element = $child; pattern = $pattern; name = $name }
          if ($name -match $script:AddressBarName) { return $found }
          if ($null -eq $first) { $first = $found }
        }
      } elseif ($typeId -ne $docId -and $typeId -ne -1 -and $depth -lt 16) {
        $queue.Enqueue([object[]]@($child, ($depth + 1)))
      }
      try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
    }
  }
  return $first
}

# The address bar text of a browser window: {found, url, title, name, editing}. url is the raw
# ValuePattern value (browsers may hide the scheme; the driver adds it). editing: the address bar
# has keyboard focus, so the text may be something the user is typing.
function Get-BrowserTab($A) {
  Assert-Native
  $hwnd = Get-Hwnd $A
  Use-Uia
  $root = $null
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  } catch {
    throw (New-HostError ('UI Automation cannot read window ' + $hwnd + ': ' + $_.Exception.Message) 'NOT_FOUND' 'The window may have closed; list the windows again.')
  }
  $title = ''
  try { $title = [string]$root.Current.Name } catch { $title = '' }
  $bar = Find-AddressBar $root (Get-IntArg $A 'budgetMs' 4000) (Get-IntArg $A 'maxNodes' 4000)
  if ($null -eq $bar) {
    return [ordered]@{ found = $false; url = $null; title = $title; name = $null; editing = $false }
  }
  $value = ''
  try { $value = [string]$bar.pattern.Current.Value } catch { $value = '' }
  $editing = $false
  try { $editing = [bool]$bar.element.Current.HasKeyboardFocus } catch { $editing = $false }
  return [ordered]@{ found = $true; url = $value; title = $title; name = [string]$bar.name; editing = $editing }
}

# ---------------------------------------------------------------- call audio and notifications (docs/CALLS-DESIGN.md 5.2, 4.1B, 8.1)

# Default audio endpoints through the Core Audio API (MMDeviceEnumerator) and the undocumented but
# widely used IPolicyConfig (the same approach as AudioDeviceCmdlets and EarTrumpet). Compiled on
# first use only, separately from the input bridge, so a failure here never affects desktop control.
$AudioSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AnywhereAudio
{
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr p;
        [FieldOffset(16)] public IntPtr p2;
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        [PreserveSig] int Commit();
    }

    // Windows 7+ IPolicyConfig: only SetDefaultEndpoint is called; the slots before it keep the vtable order.
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr format);
        [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int useDefault, IntPtr format);
        [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr endpointFormat, IntPtr mixFormat);
        [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int useDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
        [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr period);
        [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
        [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
        [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, int fxStore, IntPtr key, IntPtr value);
        [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, int fxStore, IntPtr key, IntPtr value);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
        [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    class PolicyConfigClientCom { }

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PROPVARIANT value);

    public class Endpoint
    {
        public string Id;
        public string Name;
        public int State;
    }

    const int DEVICE_STATE_ACTIVE = 1;
    const ushort VT_LPWSTR = 31;

    static PROPERTYKEY FriendlyNameKey()
    {
        PROPERTYKEY k = new PROPERTYKEY();
        k.fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");
        k.pid = 14;
        return k;
    }

    static void Check(int hr, string what)
    {
        if (hr != 0) throw new InvalidOperationException(what + " failed (HRESULT 0x" + hr.ToString("X8") + ")");
    }

    static IMMDeviceEnumerator NewEnumerator()
    {
        return (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorCom();
    }

    static string NameOf(IMMDevice dev)
    {
        IPropertyStore store = null;
        if (dev.OpenPropertyStore(0, out store) != 0 || store == null) return "";
        try
        {
            PROPERTYKEY key = FriendlyNameKey();
            PROPVARIANT v;
            if (store.GetValue(ref key, out v) != 0) return "";
            try
            {
                if (v.vt != VT_LPWSTR || v.p == IntPtr.Zero) return "";
                return Marshal.PtrToStringUni(v.p) ?? "";
            }
            finally { PropVariantClear(ref v); }
        }
        finally { Marshal.ReleaseComObject(store); }
    }

    static Endpoint Describe(IMMDevice dev)
    {
        string id;
        int state;
        Check(dev.GetId(out id), "IMMDevice.GetId");
        if (dev.GetState(out state) != 0) state = 0;
        Endpoint e = new Endpoint();
        e.Id = id;
        e.Name = NameOf(dev);
        e.State = state;
        return e;
    }

    // flow: 0 render (playback), 1 capture (recording). Active endpoints only.
    public static Endpoint[] List(int flow)
    {
        IMMDeviceEnumerator en = NewEnumerator();
        IMMDeviceCollection col = null;
        List<Endpoint> list = new List<Endpoint>();
        try
        {
            Check(en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, out col), "EnumAudioEndpoints");
            int n;
            Check(col.GetCount(out n), "IMMDeviceCollection.GetCount");
            for (int i = 0; i < n; i++)
            {
                IMMDevice d = null;
                if (col.Item(i, out d) != 0 || d == null) continue;
                try { list.Add(Describe(d)); }
                finally { Marshal.ReleaseComObject(d); }
            }
        }
        finally
        {
            if (col != null) Marshal.ReleaseComObject(col);
            Marshal.ReleaseComObject(en);
        }
        return list.ToArray();
    }

    // role: 0 eConsole, 1 eMultimedia, 2 eCommunications. Null when there is no such device.
    public static Endpoint Default(int flow, int role)
    {
        IMMDeviceEnumerator en = NewEnumerator();
        IMMDevice d = null;
        try
        {
            int hr = en.GetDefaultAudioEndpoint(flow, role, out d);
            if (hr != 0 || d == null) return null;
            return Describe(d);
        }
        finally
        {
            if (d != null) Marshal.ReleaseComObject(d);
            Marshal.ReleaseComObject(en);
        }
    }

    public static void SetDefault(string id, int role)
    {
        IPolicyConfig pc = (IPolicyConfig)(object)new PolicyConfigClientCom();
        try { Check(pc.SetDefaultEndpoint(id, role), "IPolicyConfig.SetDefaultEndpoint"); }
        finally { Marshal.ReleaseComObject(pc); }
    }
}
'@

$script:AudioRoles = [ordered]@{ console = 0; multimedia = 1; communications = 2 }

function Use-Audio {
  Assert-Windows
  if (-not ('AnywhereAudio' -as [type])) {
    try {
      Add-Type -TypeDefinition $AudioSource -Language CSharp
    } catch {
      throw (New-HostError ('The Windows audio bridge failed to compile: ' + $_.Exception.Message) 'NATIVE_UNAVAILABLE' 'Check that PowerShell can run Add-Type (it needs the .NET C# compiler and a writable TEMP folder).')
    }
  }
}

function Get-AudioFlowNumber([string]$Flow) {
  if ($Flow -eq 'capture' -or $Flow -eq 'recording' -or $Flow -eq 'input') { return 1 }
  if ($Flow -eq 'render' -or $Flow -eq 'playback' -or $Flow -eq 'output') { return 0 }
  throw (New-HostError ("Unknown audio flow '" + $Flow + "' (capture or render).") 'BAD_ARGS' $null)
}

function ConvertTo-EndpointRecord($E) {
  if ($null -eq $E) { return $null }
  return [ordered]@{ id = [string]$E.Id; name = [string]$E.Name }
}

function Get-AudioFlow([int]$FlowNumber) {
  $devices = New-Object System.Collections.ArrayList
  foreach ($e in [AnywhereAudio]::List($FlowNumber)) { [void]$devices.Add((ConvertTo-EndpointRecord $e)) }
  $flowName = 'render'
  if ($FlowNumber -eq 1) { $flowName = 'capture' }
  $r = [ordered]@{ flow = $flowName }
  foreach ($role in $script:AudioRoles.Keys) {
    $r[$role] = (ConvertTo-EndpointRecord ([AnywhereAudio]::Default($FlowNumber, [int]$script:AudioRoles[$role])))
  }
  $r['devices'] = $devices
  return $r
}

# {flow:'capture'|'render'|'all'} -> {flow, console, multimedia, communications, devices:[{id, name}]}
# ('all': {capture:{...}, render:{...}})
function Get-AudioDefaults($A) {
  Use-Audio
  $flow = [string](Get-Arg $A 'flow' 'capture')
  if ($flow -eq 'all') { return [ordered]@{ capture = (Get-AudioFlow 1); render = (Get-AudioFlow 0) } }
  return (Get-AudioFlow (Get-AudioFlowNumber $flow))
}

# {flow, id | name, roles:['console','multimedia','communications'], onlyIf?:<id>} -> {ok, id, name, roles, skipped}
# onlyIf: change a role only while its current default is that device (crash restore after the user
# picked another microphone must not undo the user's choice).
function Set-AudioDefault($A) {
  Use-Audio
  $flowName = [string](Get-Arg $A 'flow' 'capture')
  $flow = Get-AudioFlowNumber $flowName
  $id = [string](Get-Arg $A 'id' '')
  $name = [string](Get-Arg $A 'name' '')
  if ($id.Length -gt 512 -or $name.Length -gt 256) { throw (New-HostError 'Device id or name is too long.' 'BAD_ARGS' $null) }
  if (-not $id -and -not $name) { throw (New-HostError 'Pass the device id or name.' 'BAD_ARGS' $null) }
  $list = [AnywhereAudio]::List($flow)
  $target = $null
  if ($id) {
    foreach ($e in $list) { if ($e.Id -eq $id) { $target = $e; break } }
  } else {
    foreach ($e in $list) { if ($e.Name -eq $name) { $target = $e; break } }
    if ($null -eq $target) { foreach ($e in $list) { if ($e.Name.StartsWith($name, [StringComparison]::OrdinalIgnoreCase)) { $target = $e; break } } }
    if ($null -eq $target) { foreach ($e in $list) { if ($e.Name.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $target = $e; break } } }
  }
  if ($null -eq $target) {
    $what = $id
    if (-not $what) { $what = $name }
    throw (New-HostError ('No active ' + $flowName + ' device ' + $what + '.') 'DEVICE_NOT_FOUND' 'Check Sound settings; a virtual cable needs VB-CABLE installed and a reboot.')
  }
  $roles = @(Get-Arg $A 'roles' @('console', 'multimedia', 'communications'))
  $onlyIf = [string](Get-Arg $A 'onlyIf' '')
  $changed = New-Object System.Collections.ArrayList
  $skipped = New-Object System.Collections.ArrayList
  foreach ($role in $roles) {
    $roleName = [string]$role
    if (-not $script:AudioRoles.Contains($roleName)) { throw (New-HostError ("Unknown audio role '" + $roleName + "'.") 'BAD_ARGS' $null) }
    $ri = [int]$script:AudioRoles[$roleName]
    if ($onlyIf) {
      $cur = [AnywhereAudio]::Default($flow, $ri)
      if ($null -eq $cur -or $cur.Id -ne $onlyIf) { [void]$skipped.Add($roleName); continue }
    }
    [AnywhereAudio]::SetDefault($target.Id, $ri)
    [void]$changed.Add($roleName)
  }
  return [ordered]@{ ok = $true; id = [string]$target.Id; name = [string]$target.Name; flow = $flowName; roles = $changed; skipped = $skipped }
}

# Texts of the toast notifications on screen: top-level CoreWindow elements of the toast host
# process (ShellExperienceHost), matched by class and process rather than by the localized title.
# Every descendant's Name is read, bounded by time and node count.
function Get-ToastTexts($A) {
  Assert-Windows
  Use-Uia
  $budget = Get-IntArg $A 'budgetMs' 1500
  $maxNodes = Get-IntArg $A 'maxNodes' 400
  $procNames = @(Get-Arg $A 'processes' @('ShellExperienceHost'))
  $classNames = @(Get-Arg $A 'classes' @('Windows.UI.Core.CoreWindow'))
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $toasts = New-Object System.Collections.ArrayList
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $top = $null
  try { $top = $walker.GetFirstChild($root) } catch { $top = $null }
  $procCache = @{}
  while ($null -ne $top -and $sw.ElapsedMilliseconds -lt $budget) {
    $cls = ''
    $procId = 0
    try { $cls = [string]$top.Current.ClassName } catch { $cls = '' }
    try { $procId = [int]$top.Current.ProcessId } catch { $procId = 0 }
    if ($classNames -contains $cls -and $procId -gt 0) {
      if (-not $procCache.ContainsKey($procId)) {
        $pn = ''
        try { $pn = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $pn = '' }
        $procCache[$procId] = $pn
      }
      $procName = [string]$procCache[$procId]
      if ($procNames -contains $procName) {
        $texts = New-Object System.Collections.ArrayList
        $queue = New-Object 'System.Collections.Generic.Queue[object]'
        $queue.Enqueue($top)
        $seen = 0
        while ($queue.Count -gt 0 -and $seen -lt $maxNodes -and $sw.ElapsedMilliseconds -lt $budget) {
          $node = $queue.Dequeue()
          $child = $null
          try { $child = $walker.GetFirstChild($node) } catch { $child = $null }
          while ($null -ne $child -and $seen -lt $maxNodes) {
            $seen++
            $nm = ''
            try { $nm = [string]$child.Current.Name } catch { $nm = '' }
            if ($nm -and $nm.Trim().Length -gt 0 -and $texts.Count -lt 64) {
              $t = $nm.Trim()
              if ($t.Length -gt 500) { $t = $t.Substring(0, 500) }
              if ($texts.Count -eq 0 -or [string]$texts[$texts.Count - 1] -ne $t) { [void]$texts.Add($t) }
            }
            $queue.Enqueue($child)
            try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
          }
        }
        $name = ''
        try { $name = [string]$top.Current.Name } catch { $name = '' }
        $b = $null
        try {
          $rc = $top.Current.BoundingRectangle
          if (-not $rc.IsEmpty) { $b = [ordered]@{ x = [int]$rc.X; y = [int]$rc.Y; width = [int]$rc.Width; height = [int]$rc.Height } }
        } catch { $b = $null }
        [void]$toasts.Add([ordered]@{ process = $procName; pid = $procId; className = $cls; name = $name; texts = $texts; bounds = $b })
      }
    }
    try { $top = $walker.GetNextSibling($top) } catch { $top = $null }
  }
  return [ordered]@{ toasts = $toasts; ms = [int]$sw.ElapsedMilliseconds }
}

# The Desktop folder as Explorer resolves it (follows OneDrive Known Folder Move and GPO redirection),
# with the registry value and the environment as fallbacks for the notes writer.
function Get-DesktopPath {
  $p = ''
  try { $p = [string][Environment]::GetFolderPath('Desktop') } catch { $p = '' }
  $reg = $null
  if ($script:IsWin) {
    try {
      $v = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -Name 'Desktop' -ErrorAction Stop).Desktop
      if ($v) { $reg = [Environment]::ExpandEnvironmentVariables([string]$v) }
    } catch { $reg = $null }
  }
  $exists = $false
  if ($p) { try { $exists = [bool](Test-Path -LiteralPath $p -PathType Container) } catch { $exists = $false } }
  return [ordered]@{ path = $p; exists = $exists; registry = $reg; oneDrive = $env:OneDrive; userProfile = $env:USERPROFILE }
}

# ---------------------------------------------------------------- dispatcher

function Invoke-HostCommand([string]$Cmd, $A) {
  switch ($Cmd) {
    'ping' {
      $edition = 'Desktop'
      if ($PSVersionTable.ContainsKey('PSEdition')) { $edition = [string]$PSVersionTable.PSEdition }
      $dpi = 'unaware'
      if ($script:NativeOk) { $dpi = [string][AnywhereNative]::DpiMode }
      return [ordered]@{
        pong = $true
        protocol = $HostProtocol
        ps = $PSVersionTable.PSVersion.ToString()
        edition = $edition
        windows = [bool]$script:IsWin
        native = [bool]$script:NativeOk
        nativeError = $script:NativeError
        dpi = $dpi
        elevated = [bool]$script:HostElevated
        sta = [bool](Test-Sta)
        is64 = [Environment]::Is64BitProcess
        pid = $PID
        os = [Environment]::OSVersion.VersionString
      }
    }
    'echo' { return @{ args = $A } }
    'displays' { return @{ displays = (Get-Displays) } }
    'capture' { return (Get-Capture $A) }
    'cursor' {
      Assert-Native
      $p = [AnywhereNative]::CursorPos()
      return @{ x = $p[0]; y = $p[1] }
    }
    'move' {
      Assert-Native
      [AnywhereNative]::MoveTo((Get-IntArg $A 'x'), (Get-IntArg $A 'y'))
      $p = [AnywhereNative]::CursorPos()
      return @{ x = $p[0]; y = $p[1] }
    }
    'click' {
      Assert-Native
      if ($null -ne (Get-Arg $A 'x') -and $null -ne (Get-Arg $A 'y')) {
        [AnywhereNative]::MoveTo((Get-IntArg $A 'x'), (Get-IntArg $A 'y'))
        Start-Sleep -Milliseconds 30
      }
      $p = [AnywhereNative]::CursorPos()
      Assert-InputAllowed $false $p[0] $p[1]
      [AnywhereNative]::Click([string](Get-Arg $A 'button' 'left'), (Get-IntArg $A 'clicks' 1), (Get-IntList $A 'modifiers'))
      return @{ x = $p[0]; y = $p[1] }
    }
    'down' {
      Assert-Native
      $p = [AnywhereNative]::CursorPos()
      Assert-InputAllowed $false $p[0] $p[1]
      [AnywhereNative]::Button([string](Get-Arg $A 'button' 'left'), $false)
      return @{ ok = $true }
    }
    'up' {
      Assert-Native
      [AnywhereNative]::Button([string](Get-Arg $A 'button' 'left'), $true)
      return @{ ok = $true }
    }
    'drag' {
      Assert-Native
      $x1 = Get-IntArg $A 'x1'; $y1 = Get-IntArg $A 'y1'
      Assert-InputAllowed $false $x1 $y1
      [AnywhereNative]::Drag($x1, $y1, (Get-IntArg $A 'x2'), (Get-IntArg $A 'y2'), [string](Get-Arg $A 'button' 'left'), (Get-IntArg $A 'steps' 20))
      return @{ ok = $true }
    }
    'scroll' {
      Assert-Native
      if ($null -ne (Get-Arg $A 'x') -and $null -ne (Get-Arg $A 'y')) {
        [AnywhereNative]::MoveTo((Get-IntArg $A 'x'), (Get-IntArg $A 'y'))
        Start-Sleep -Milliseconds 30
      }
      $p = [AnywhereNative]::CursorPos()
      Assert-InputAllowed $false $p[0] $p[1]
      [AnywhereNative]::Scroll((Get-IntArg $A 'dx' 0), (Get-IntArg $A 'dy' 0))
      return @{ ok = $true }
    }
    'type' {
      Assert-Native
      Assert-InputAllowed $true 0 0
      $n = [AnywhereNative]::TypeText([string](Get-Arg $A 'text' ''), 64, 8)
      return @{ typed = $n }
    }
    'keys' {
      Assert-Native
      Assert-InputAllowed $true 0 0
      [AnywhereNative]::Keys((Get-IntList $A 'vks'))
      return @{ ok = $true }
    }
    'windows' {
      Assert-Native
      $list = New-Object System.Collections.ArrayList
      foreach ($w in [AnywhereNative]::ListWindows()) { [void]$list.Add((ConvertTo-WindowRecord $w)) }
      return @{ windows = $list }
    }
    'active' {
      Assert-Native
      $w = [AnywhereNative]::Active()
      if ($null -eq $w) { return @{ window = $null } }
      return @{ window = (ConvertTo-WindowRecord $w) }
    }
    'focus' {
      Assert-Native
      return @{ ok = [bool][AnywhereNative]::Focus((Get-Hwnd $A)) }
    }
    'minimize' {
      Assert-Native
      return @{ ok = [bool][AnywhereNative]::Minimize((Get-Hwnd $A)) }
    }
    'topmost' {
      Assert-Native
      $on = [bool](Get-Arg $A 'on' $true)
      return @{ ok = [bool][AnywhereNative]::Topmost((Get-Hwnd $A), $on) }
    }
    'browsertab' { return (Get-BrowserTab $A) }
    'clipget' { return @{ text = (Get-ClipText) } }
    'clipset' { return (Set-ClipText ([string](Get-Arg $A 'text' ''))) }
    'notify' { return (Show-Notification ([string](Get-Arg $A 'title' '')) ([string](Get-Arg $A 'body' ''))) }
    'audioDefaultGet' { return (Get-AudioDefaults $A) }
    'audioDefaultSet' { return (Set-AudioDefault $A) }
    'toastTexts' { return (Get-ToastTexts $A) }
    'desktopPath' { return (Get-DesktopPath) }
    default {
      throw (New-HostError ("Unknown command '" + $Cmd + "'.") 'UNKNOWN_COMMAND' 'Update Claude Anywhere so the driver and host versions match.')
    }
  }
}

function Get-ErrorRecordInfo($Err) {
  $ex = $Err.Exception
  while ($null -ne $ex.InnerException -and ($ex -is [System.Management.Automation.MethodInvocationException] -or $ex -is [System.Reflection.TargetInvocationException])) {
    $ex = $ex.InnerException
  }
  $code = 'HOST_ERROR'
  $hint = $null
  if ($null -ne $ex.Data) {
    if ($ex.Data.Contains('anywhereCode')) { $code = [string]$ex.Data['anywhereCode'] }
    if ($ex.Data.Contains('anywhereHint')) { $hint = [string]$ex.Data['anywhereHint'] }
  }
  return [ordered]@{ message = [string]$ex.Message; code = $code; hint = $hint; type = $ex.GetType().FullName }
}

function ConvertTo-ResponseLine($Id, [bool]$Ok, $Payload) {
  # Base64 PNGs can be tens of MB: splice them in after serializing the small envelope.
  $png = $null
  if ($Ok -and $Payload -is [hashtable] -and $Payload.ContainsKey('png')) {
    $png = [string]$Payload['png']
    $Payload['png'] = '@@ANYWHERE_PNG@@'
  }
  $o = [ordered]@{ id = $Id; ok = $Ok }
  if ($Ok) { $o['result'] = $Payload } else { $o['error'] = $Payload }
  $json = ConvertTo-Json -InputObject $o -Compress -Depth 8
  if ($null -ne $png) { $json = $json.Replace('"@@ANYWHERE_PNG@@"', '"' + $png + '"') }
  return $json
}

# ---------------------------------------------------------------- main loop

try {
  $script:In = New-Object System.IO.StreamReader -ArgumentList ([Console]::OpenStandardInput()), $Utf8, $false, 65536
  $script:Out = New-Object System.IO.StreamWriter -ArgumentList ([Console]::OpenStandardOutput()), $Utf8, 65536
  $script:Out.AutoFlush = $false
} catch {
  $Host.UI.WriteErrorLine('ANYWHERE_HOST_ERROR: cannot open stdio: ' + $_.Exception.Message)
  exit 4
}

while ($true) {
  $line = $script:In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = $null
  $response = $null
  $script:Warnings.Clear()
  try {
    if ($script:NotifyJobs.Count -gt 0) { Clear-NotifyJobs $false }
    $req = ConvertFrom-Json -InputObject $line
    $id = $req.id
    $result = Invoke-HostCommand ([string]$req.cmd) $req.args
    Add-ResultWarnings $result
    $response = ConvertTo-ResponseLine $id $true $result
  } catch {
    try {
      $response = ConvertTo-ResponseLine $id $false (Get-ErrorRecordInfo $_)
    } catch {
      $response = '{"id":null,"ok":false,"error":{"message":"host failed to serialize an error","code":"HOST_ERROR"}}'
    }
  }
  try {
    $script:Out.Write($response)
    $script:Out.Write("`n")
    $script:Out.Flush()
  } catch {
    break
  }
}

try { Clear-NotifyJobs $true } catch { }
try { if ($null -ne $script:NotifyPool) { $script:NotifyPool.Dispose() } } catch { }
exit 0
