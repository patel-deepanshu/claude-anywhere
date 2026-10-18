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
using System.Reflection;
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
        return TargetOf(h);
    }

    /// CheckTarget for a given window (UI Automation actions name their window, not a point).
    public static InputTarget CheckWindow(IntPtr h, bool hostElevated)
    {
        if (hostElevated || h == IntPtr.Zero || !IsWindow(h)) return null;
        return TargetOf(h);
    }

    static InputTarget TargetOf(IntPtr h)
    {
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

    // ---------------------------------------------------------------- window bounds and state

    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);

    const int SW_MAXIMIZE = 3;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOOWNERZORDER = 0x0200;
    const int GWL_STYLE = -16;
    const int WS_POPUP = unchecked((int)0x80000000);

    /// The Win32 error of the last SetWindowBounds that failed (5 = access denied: an elevated window).
    public static int LastBoundsError;

    public static bool IsWindowHandle(IntPtr h) { return h != IntPtr.Zero && IsWindow(h); }

    /// The window as the windows command describes it, without filtering; null when it is gone.
    public static WinInfo WindowInfo(IntPtr h)
    {
        if (!IsWindowHandle(h)) return null;
        return Describe(h, GetForegroundWindow(), false);
    }

    // GetWindowRect includes the invisible resize borders; the windows command reports the visible
    // frame (DWM extended frame bounds), so SetWindowBounds converts between the two.
    static void FrameRects(IntPtr h, out RECT outer, out RECT frame)
    {
        if (!GetWindowRect(h, out outer)) outer = new RECT();
        frame = outer;
        if (!PerMonitorAware()) return;
        try
        {
            RECT f;
            if (DwmGetRectAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out f, Marshal.SizeOf(typeof(RECT))) == 0 && f.Right > f.Left) frame = f;
        }
        catch (Exception) { }
    }

    static int Border(int v) { return v < 0 ? 0 : (v > 64 ? 64 : v); }

    /// {x, y, width, height, state} of the visible frame (state 0 normal, 1 minimized, 2 maximized);
    /// a minimized window reports where it will be restored. Null when the window is gone.
    public static int[] WindowBounds(IntPtr h)
    {
        if (!IsWindowHandle(h)) return null;
        WinInfo w = Describe(h, IntPtr.Zero, false);
        if (w == null) return null;
        int state = IsIconic(h) ? 1 : (IsZoomed(h) ? 2 : 0);
        return new int[] { w.X, w.Y, w.Width, w.Height, state };
    }

    static bool InState(IntPtr h, int cmd)
    {
        if (cmd == SW_MAXIMIZE) return IsZoomed(h);
        if (cmd == SW_MINIMIZE) return IsIconic(h);
        return !IsIconic(h) && !IsZoomed(h);
    }

    /// maximize (fullscreen is the same: Win32 has no generic full-screen mode), minimize or restore.
    /// True when the window ends up in that state.
    public static bool SetWindowState(IntPtr h, string state)
    {
        string s = (state ?? "").Trim().ToLowerInvariant();
        int cmd;
        if (s == "maximize" || s == "maximized" || s == "fullscreen") cmd = SW_MAXIMIZE;
        else if (s == "minimize" || s == "minimized") cmd = SW_MINIMIZE;
        else if (s == "restore" || s == "restored" || s == "normal") cmd = SW_RESTORE;
        else throw Fail("Unknown window state '" + state + "'.", "BAD_ARGS", "Use maximize, minimize, restore or fullscreen.");
        if (!IsWindowHandle(h)) return false;
        ShowWindow(h, cmd);
        for (int i = 0; i < 25; i++)
        {
            if (InState(h, cmd)) return true;
            // A window minimized from the maximized state is restored to maximized: restore again.
            if (i == 5 && cmd == SW_RESTORE && IsZoomed(h)) ShowWindow(h, SW_RESTORE);
            Thread.Sleep(20);
        }
        return InState(h, cmd);
    }

    /// Move and/or resize the visible frame. mask: 1 x, 2 y, 4 width, 8 height (others keep their
    /// current value). A minimized or maximized window is restored first. False when Windows refuses
    /// (LastBoundsError); an app may still enforce its own minimum or maximum size.
    public static bool SetWindowBounds(IntPtr h, int x, int y, int width, int height, int mask)
    {
        LastBoundsError = 0;
        if (((mask & 4) != 0 && width < 1) || ((mask & 8) != 0 && height < 1))
            throw Fail("Window width and height must be at least 1.", "BAD_ARGS", null);
        if (!IsWindowHandle(h)) return false;
        if ((mask & 15) == 0) return true;
        if (IsIconic(h) || IsZoomed(h))
        {
            ShowWindow(h, SW_RESTORE);
            for (int i = 0; i < 25 && (IsIconic(h) || IsZoomed(h)); i++)
            {
                if (i == 5 && IsZoomed(h)) ShowWindow(h, SW_RESTORE);
                Thread.Sleep(20);
            }
        }
        for (int attempt = 0; attempt < 2; attempt++)
        {
            RECT outer, frame;
            FrameRects(h, out outer, out frame);
            int bl = Border(frame.Left - outer.Left);
            int bt = Border(frame.Top - outer.Top);
            int br = Border(outer.Right - frame.Right);
            int bb = Border(outer.Bottom - frame.Bottom);
            int nx = (mask & 1) != 0 ? x : frame.Left;
            int ny = (mask & 2) != 0 ? y : frame.Top;
            int nw = (mask & 4) != 0 ? width : frame.Right - frame.Left;
            int nh = (mask & 8) != 0 ? height : frame.Bottom - frame.Top;
            uint flags = SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE;
            if ((mask & 3) == 0) flags |= SWP_NOMOVE;
            if ((mask & 12) == 0) flags |= SWP_NOSIZE;
            if (!SetWindowPos(h, IntPtr.Zero, nx - bl, ny - bt, nw + bl + br, nh + bt + bb, flags))
            {
                LastBoundsError = Marshal.GetLastWin32Error();
                return false;
            }
            // On a monitor with another DPI a per-monitor aware app rescales itself (WM_DPICHANGED)
            // and its borders change: check the result and apply the request once more.
            Thread.Sleep(50);
            FrameRects(h, out outer, out frame);
            if (Math.Abs(frame.Left - nx) <= 2 && Math.Abs(frame.Top - ny) <= 2 &&
                Math.Abs(frame.Right - frame.Left - nw) <= 2 && Math.Abs(frame.Bottom - frame.Top - nh) <= 2) break;
        }
        return true;
    }

    /// Bring the top-level window of h to the foreground for keyboard focus, except an open menu or
    /// another popup (activating it would close it). True when it is in front or needs no activation.
    public static bool ActivateForUi(IntPtr h)
    {
        if (!IsWindowHandle(h)) return false;
        IntPtr root = GetAncestor(h, GA_ROOT);
        if (root != IntPtr.Zero) h = root;
        IntPtr fg = GetForegroundWindow();
        if (fg == h) return true;
        if (WindowClass(h) == "#32768" || Describe(h, fg, true) == null) return true;
        return Focus(h);
    }

    /// Visible popup windows of main's process stacked above it, front to back: open menus (#32768),
    /// drop-down lists and other popups the windows command leaves out. At most max of them.
    public static long[] PopupWindows(IntPtr main, int max)
    {
        List<long> result = new List<long>();
        if (!IsWindowHandle(main) || max < 1) return result.ToArray();
        uint mainPid;
        GetWindowThreadProcessId(main, out mainPid);
        IntPtr fg = GetForegroundWindow();
        EnumWindowsProc cb = delegate(IntPtr h, IntPtr lp)
        {
            if (h == main || result.Count >= max) return false;
            try
            {
                if (!IsWindowVisible(h) || IsIconic(h) || IsCloaked(h)) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pid != mainPid) return true;
                if (WindowClass(h) != "#32768")
                {
                    if ((GetWindowLong(h, GWL_STYLE) & WS_POPUP) == 0) return true;
                    if (Describe(h, fg, true) != null) return true; // an ordinary window of the app
                }
                RECT r;
                if (!GetWindowRect(h, out r) || r.Right - r.Left < 2 || r.Bottom - r.Top < 2) return true;
                result.Add(h.ToInt64());
            }
            catch (Exception) { }
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return result.ToArray();
    }

    // ---------------------------------------------------------------- UI Automation helpers
    //
    // The bridge must compile with mscorlib alone, so UIAutomationClient is not referenced: the host
    // passes UI Automation objects in and these helpers reach them through reflection.

    public class UiInfo
    {
        public string Role;
        public int TypeId;
        public string Name;
        public string LocalType;
        public bool HasRect;
        public int X;
        public int Y;
        public int Width;
        public int Height;
        public bool Enabled;
        public bool Focused;
        public bool Offscreen;
        public bool Password;
        public string Help;
        public bool CanInvoke;
        public bool CanToggle;
        public bool CanSelect;
        public bool CanExpand;
        public bool HasValue;
        public bool ReadOnly;
        public string Value;        // null without a ValuePattern, and for passwords
        public bool ValueClipped;
        public int Toggle;          // -1 not toggleable, 0 off, 1 on, 2 indeterminate
        public int Selected;        // -1 not selectable, 0 or 1
        public int Expand;          // -1 no ExpandCollapse, 0 collapsed, 1 expanded, 2 partially, 3 leaf
        public bool HasRange;
        public double Range;
    }

    // Order of the property array the host passes to ReadUi (Get-UiaRefs in win32-host.ps1).
    const int UP_NAME = 0, UP_TYPE = 1, UP_LOCALTYPE = 2, UP_RECT = 3, UP_ENABLED = 4, UP_FOCUSED = 5,
        UP_OFFSCREEN = 6, UP_HELP = 7, UP_PASSWORD = 8, UP_CAN_INVOKE = 9, UP_CAN_TOGGLE = 10,
        UP_CAN_SELECT = 11, UP_CAN_EXPAND = 12, UP_HAS_VALUE = 13, UP_VALUE = 14, UP_READONLY = 15,
        UP_TOGGLE = 16, UP_SELECTED = 17, UP_EXPAND = 18, UP_HAS_RANGE = 19, UP_RANGE = 20;
    public const int UiPropCount = 21;

    const int UI_NAME_MAX = 300;
    const int UI_VALUE_MAX = 400;
    const int UIA_DOCUMENT = 50030;
    const int UIA_SEPARATOR = 50038;

    static MethodInfo uiCachedGetter;
    static Type uiCachedGetterOwner;
    static readonly Dictionary<Type, PropertyInfo[]> RectMembers = new Dictionary<Type, PropertyInfo[]>();
    static readonly Dictionary<Type, PropertyInfo> IdMembers = new Dictionary<Type, PropertyInfo>();

    static bool AsBool(object v, bool dflt) { return v is bool ? (bool)v : dflt; }

    static int AsInt(object v, int dflt)
    {
        if (v == null) return dflt;
        try { return Convert.ToInt32(v, System.Globalization.CultureInfo.InvariantCulture); } catch (Exception) { return dflt; }
    }

    static int ClampInt(double v)
    {
        if (v > 1e9) return 1000000000;
        if (v < -1e9) return -1000000000;
        return (int)Math.Round(v);
    }

    /// Whitespace runs (and control characters) become one space, then the text is trimmed and cut
    /// to max characters (0 = no limit) without splitting a surrogate pair.
    public static string Squash(string s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        StringBuilder sb = new StringBuilder(Math.Min(s.Length, max > 0 ? max : s.Length));
        bool space = false;
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (char.IsWhiteSpace(c) || char.IsControl(c)) { space = sb.Length > 0; continue; }
            if (space) { sb.Append(' '); space = false; }
            sb.Append(c);
            if (max > 0 && sb.Length >= max) break;
        }
        if (max > 0 && sb.Length > max) sb.Length = max;
        if (sb.Length > 0 && char.IsHighSurrogate(sb[sb.Length - 1])) sb.Length = sb.Length - 1;
        return sb.ToString();
    }

    static string Clip(string s, int max, out bool clipped)
    {
        clipped = false;
        if (s == null || s.Length <= max) return s;
        int n = max;
        if (char.IsHighSurrogate(s[n - 1])) n--;
        clipped = true;
        return s.Substring(0, n);
    }

    static MethodInfo CachedGetter(Type t)
    {
        if (uiCachedGetter != null && uiCachedGetterOwner == t) return uiCachedGetter;
        MethodInfo found = null;
        foreach (MethodInfo m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            if (m.Name != "GetCachedPropertyValue") continue;
            ParameterInfo[] ps = m.GetParameters();
            if (ps.Length == 2 && ps[1].ParameterType == typeof(bool)) { found = m; break; }
        }
        if (found == null)
            throw Fail("The UI Automation element type " + t.FullName + " has no GetCachedPropertyValue(property, bool).", "UIA_FAILED", null);
        uiCachedGetter = found;
        uiCachedGetterOwner = t;
        return found;
    }

    static int TypeIdOf(object controlType)
    {
        if (controlType == null) return -1;
        Type t = controlType.GetType();
        PropertyInfo p;
        if (!IdMembers.TryGetValue(t, out p))
        {
            p = t.GetProperty("Id");
            IdMembers[t] = p;
        }
        return p == null ? -1 : AsInt(p.GetValue(controlType, null), -1);
    }

    static void ReadRect(object rect, UiInfo u)
    {
        u.HasRect = false;
        if (rect == null) return;
        Type t = rect.GetType();
        PropertyInfo[] p;
        if (!RectMembers.TryGetValue(t, out p))
        {
            p = new PropertyInfo[] { t.GetProperty("X"), t.GetProperty("Y"), t.GetProperty("Width"), t.GetProperty("Height"), t.GetProperty("IsEmpty") };
            RectMembers[t] = p;
        }
        if (p[0] == null || p[1] == null || p[2] == null || p[3] == null) return;
        if (p[4] != null && AsBool(p[4].GetValue(rect, null), false)) return;
        double x = Convert.ToDouble(p[0].GetValue(rect, null), System.Globalization.CultureInfo.InvariantCulture);
        double y = Convert.ToDouble(p[1].GetValue(rect, null), System.Globalization.CultureInfo.InvariantCulture);
        double w = Convert.ToDouble(p[2].GetValue(rect, null), System.Globalization.CultureInfo.InvariantCulture);
        double h = Convert.ToDouble(p[3].GetValue(rect, null), System.Globalization.CultureInfo.InvariantCulture);
        if (double.IsNaN(x) || double.IsNaN(y) || double.IsNaN(w) || double.IsNaN(h)) return;
        if (double.IsInfinity(x) || double.IsInfinity(y) || double.IsInfinity(w) || double.IsInfinity(h)) return;
        u.X = ClampInt(x);
        u.Y = ClampInt(y);
        u.Width = Math.Max(0, ClampInt(w));
        u.Height = Math.Max(0, ClampInt(h));
        u.HasRect = true;
    }

    /// The shared role vocabulary for a UI Automation ControlType id (UIA_*ControlTypeId).
    static string RoleForType(int id)
    {
        switch (id)
        {
            case 50000: case 50031: return "button";      // Button, SplitButton
            case 50002: return "checkbox";
            case 50003: return "combobox";
            case 50004: return "textbox";                 // Edit
            case 50005: return "link";                    // Hyperlink
            case 50006: return "image";
            case 50007: return "listitem";
            case 50009: case 50010: return "menu";        // Menu, MenuBar
            case 50011: return "menuitem";
            case 50013: return "radio";                   // RadioButton
            case 50015: case 50016: return "slider";      // Slider, Spinner
            case 50018: return "tablist";                 // Tab
            case 50019: return "tab";                     // TabItem
            case 50020: case 50022: return "text";        // Text, ToolTip
            case 50021: case 50040: return "toolbar";     // ToolBar, AppBar
            case 50024: return "treeitem";
            case 50028: case 50036: return "table";       // DataGrid, Table
            case 50029: case 50034: return "row";         // DataItem, Header
            case 50035: return "cell";                    // HeaderItem
            case 50032: return "window";
            case 50001: case 50008: case 50017: case 50023: case 50026: case 50030: case 50033: case 50039:
                return "group";                           // Calendar, List, StatusBar, Tree, Group, Document, Pane, SemanticZoom
            default: return "other";                      // ProgressBar, ScrollBar, Custom, Thumb, TitleBar, Separator
        }
    }

    static string RoleFor(UiInfo u)
    {
        string role = RoleForType(u.TypeId);
        // An editable document (a rich-text editor's text area) takes text like an edit box.
        if (u.TypeId == UIA_DOCUMENT && u.HasValue && !u.ReadOnly) return "textbox";
        // UI Automation has no heading type: Chromium and others say so in the localized type.
        if ((role == "text" || role == "group") && u.LocalType.IndexOf("heading", StringComparison.OrdinalIgnoreCase) >= 0) return "heading";
        return role;
    }

    /// Read an element's cached properties (from GetUpdatedCache with Get-UiaRefs' request).
    /// props must be in the UP_* order; notSupported is AutomationElement.NotSupported.
    public static UiInfo ReadUi(object element, object[] props, object notSupported)
    {
        if (element == null) throw new ArgumentNullException("element");
        if (props == null || props.Length != UiPropCount) throw new ArgumentException("ReadUi needs " + UiPropCount + " properties.");
        MethodInfo get = CachedGetter(element.GetType());
        object[] v = new object[props.Length];
        for (int i = 0; i < props.Length; i++)
        {
            try
            {
                object x = get.Invoke(element, new object[] { props[i], true });
                v[i] = (x == null || ReferenceEquals(x, notSupported)) ? null : x;
            }
            catch (Exception) { v[i] = null; }
        }
        UiInfo u = new UiInfo();
        u.Name = Squash(v[UP_NAME] as string, UI_NAME_MAX);
        u.TypeId = TypeIdOf(v[UP_TYPE]);
        u.LocalType = Squash(v[UP_LOCALTYPE] as string, 64);
        ReadRect(v[UP_RECT], u);
        u.Enabled = AsBool(v[UP_ENABLED], true);
        u.Focused = AsBool(v[UP_FOCUSED], false);
        u.Offscreen = AsBool(v[UP_OFFSCREEN], false) || !u.HasRect;
        u.Help = Squash(v[UP_HELP] as string, UI_NAME_MAX);
        u.Password = AsBool(v[UP_PASSWORD], false);
        u.CanInvoke = AsBool(v[UP_CAN_INVOKE], false);
        u.CanToggle = AsBool(v[UP_CAN_TOGGLE], false);
        u.CanSelect = AsBool(v[UP_CAN_SELECT], false);
        u.CanExpand = AsBool(v[UP_CAN_EXPAND], false);
        u.HasValue = AsBool(v[UP_HAS_VALUE], false);
        u.ReadOnly = AsBool(v[UP_READONLY], false);
        if (u.HasValue && !u.Password)
        {
            bool clipped;
            u.Value = Clip(v[UP_VALUE] as string ?? "", UI_VALUE_MAX, out clipped);
            u.ValueClipped = clipped;
        }
        u.Toggle = (u.CanToggle && v[UP_TOGGLE] != null) ? AsInt(v[UP_TOGGLE], -1) : -1;
        u.Selected = (u.CanSelect && v[UP_SELECTED] != null) ? (AsBool(v[UP_SELECTED], false) ? 1 : 0) : -1;
        u.Expand = (u.CanExpand && v[UP_EXPAND] != null) ? AsInt(v[UP_EXPAND], -1) : -1;
        u.HasRange = AsBool(v[UP_HAS_RANGE], false) && v[UP_RANGE] != null;
        if (u.HasRange)
        {
            try { u.Range = Convert.ToDouble(v[UP_RANGE], System.Globalization.CultureInfo.InvariantCulture); }
            catch (Exception) { u.HasRange = false; }
        }
        u.Role = RoleFor(u);
        return u;
    }

    /// True for elements a compact tree walks through without listing: unnamed containers, unnamed
    /// images and text, separators, and text that repeats the name of the element it belongs to.
    /// Focused, interactive and window elements are always kept.
    public static bool IsUiWrapper(UiInfo u, string ownerName)
    {
        if (u == null) return true;
        if (u.Focused || u.Role == "window") return false;
        if (u.CanInvoke || u.CanToggle || u.CanSelect || u.CanExpand || u.HasRange || (u.HasValue && !u.ReadOnly)) return false;
        if (u.TypeId == UIA_SEPARATOR) return true;
        bool named = u.Name.Length > 0;
        bool valued = !string.IsNullOrEmpty(u.Value);
        if (u.Role == "text") return !named || (!valued && ownerName != null && string.Equals(u.Name, ownerName, StringComparison.OrdinalIgnoreCase));
        if (u.Role == "image") return !named;
        if (u.Role == "group" || u.Role == "other") return !named && !valued;
        return false;
    }

    /// 3 equal, 2 starts with, 1 contains (case-insensitive, whitespace squashed), 0 no match.
    /// With exact only equality counts. needle must already be squashed.
    public static int UiMatch(string hay, string needle, bool exact)
    {
        if (string.IsNullOrEmpty(hay) || string.IsNullOrEmpty(needle)) return 0;
        string h = Squash(hay, 0);
        if (string.Equals(h, needle, StringComparison.OrdinalIgnoreCase)) return 3;
        if (exact) return 0;
        if (h.StartsWith(needle, StringComparison.OrdinalIgnoreCase)) return 2;
        return h.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0 ? 1 : 0;
    }

    /// The weakest UiMatch over the given criteria (0 = no match): name looks at the name, text at
    /// the name, the value and the help text. Neither given: 3.
    public static int UiScore(UiInfo u, string name, string text, bool exact)
    {
        int score = 3;
        if (!string.IsNullOrEmpty(name))
        {
            int s = UiMatch(u.Name, name, exact);
            if (s == 0) return 0;
            score = Math.Min(score, s);
        }
        if (!string.IsNullOrEmpty(text))
        {
            int s = UiMatch(u.Name, text, exact);
            if (u.Value != null) s = Math.Max(s, UiMatch(u.Value, text, exact));
            s = Math.Max(s, UiMatch(u.Help, text, exact));
            if (s == 0) return 0;
            score = Math.Min(score, s);
        }
        return score;
    }

    /// Two base-36 characters of an FNV-1a hash of the role and the lowercased name: an element id
    /// carries it so resolving the id by its path can tell a different element took the place.
    public static string UiTag(string role, string name)
    {
        string s = (role ?? "") + "\n" + (name ?? "").ToLowerInvariant();
        uint h = 2166136261;
        unchecked
        {
            for (int i = 0; i < s.Length; i++)
            {
                h ^= s[i];
                h *= 16777619;
            }
        }
        const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        uint n = h % 1296;
        return new string(new char[] { digits[(int)(n / 36)], digits[(int)(n % 36)] });
    }

    public const int CALL_DONE = 0;
    public const int CALL_PENDING = 1;

    sealed class UiCall
    {
        public object Target;
        public string Method;
        public object[] Args;
        public Exception Error;
        public readonly ManualResetEvent Done = new ManualResetEvent(false);

        public void Run()
        {
            try
            {
                Target.GetType().InvokeMember(Method, BindingFlags.InvokeMethod | BindingFlags.Public | BindingFlags.Instance, null, Target, Args);
            }
            catch (TargetInvocationException ex) { Error = ex.InnerException ?? ex; }
            catch (Exception ex) { Error = ex; }
            finally { Done.Set(); }
        }
    }

    /// Call target.method(args) on a worker thread and wait up to timeoutMs: CALL_DONE, or
    /// CALL_PENDING while it still runs. Some providers only return from Invoke when the modal
    /// dialog the click opened closes; the host must not hang on them. The call's own exception
    /// is rethrown.
    public static int CallWithTimeout(object target, string method, object[] args, int timeoutMs)
    {
        if (target == null) throw new ArgumentNullException("target");
        UiCall call = new UiCall();
        call.Target = target;
        call.Method = method;
        call.Args = args ?? new object[0];
        Thread t = new Thread(call.Run);
        t.IsBackground = true;
        t.Start();
        if (!call.Done.WaitOne(Math.Max(50, timeoutMs))) return CALL_PENDING;
        ((IDisposable)call.Done).Dispose();
        if (call.Error != null) throw call.Error;
        return CALL_DONE;
    }

    // ---- MSAA (LegacyIAccessible) default action: the managed UI Automation client has no
    // LegacyIAccessiblePattern, so ask oleacc for the accessible object at the element's centre.

    [DllImport("oleacc.dll")]
    static extern int AccessibleObjectFromPoint(POINT pt, [MarshalAs(UnmanagedType.IUnknown)] out object acc, out object child);

    public const int ACC_DONE = 0;
    public const int ACC_PENDING = 1;
    public const int ACC_NONE = -1;
    public const int ACC_MISMATCH = -2;
    public const int ACC_NO_ACTION = -3;
    public const int ACC_FAILED = -4;

    sealed class AccCall
    {
        public int X;
        public int Y;
        public string Expect;
        public int Result = ACC_FAILED;
        public volatile bool Acting;
        public readonly ManualResetEvent Done = new ManualResetEvent(false);

        public void Run()
        {
            try { Result = AccDefaultActionNow(this); }
            catch (Exception) { Result = ACC_FAILED; }
            finally { Done.Set(); }
        }
    }

    static object AccInvoke(object acc, string member, BindingFlags kind, object child)
    {
        return acc.GetType().InvokeMember(member, kind, null, acc, new object[] { child });
    }

    static bool NamesAgree(string a, string b)
    {
        string x = Squash(a, 0);
        string y = Squash(b, 0);
        if (string.Equals(x, y, StringComparison.OrdinalIgnoreCase)) return true;
        if (x.Length < 3 || y.Length < 3) return false;
        return x.IndexOf(y, StringComparison.OrdinalIgnoreCase) >= 0 || y.IndexOf(x, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    static int AccDefaultActionNow(AccCall call)
    {
        POINT p;
        p.X = call.X;
        p.Y = call.Y;
        object acc;
        object child;
        if (AccessibleObjectFromPoint(p, out acc, out child) != 0 || acc == null) return ACC_NONE;
        try
        {
            string name = null;
            try { name = AccInvoke(acc, "accName", BindingFlags.GetProperty, child) as string; } catch (Exception) { name = null; }
            if (!string.IsNullOrEmpty(call.Expect) && !NamesAgree(name, call.Expect)) return ACC_MISMATCH;
            string action = null;
            try { action = AccInvoke(acc, "accDefaultAction", BindingFlags.GetProperty, child) as string; } catch (Exception) { action = null; }
            if (string.IsNullOrEmpty(action)) return ACC_NO_ACTION;
            call.Acting = true;
            AccInvoke(acc, "accDoDefaultAction", BindingFlags.InvokeMethod, child);
            return ACC_DONE;
        }
        finally
        {
            try { if (Marshal.IsComObject(acc)) Marshal.ReleaseComObject(acc); } catch (Exception) { }
        }
    }

    /// Run the MSAA default action of the accessible object at (x, y) when its name agrees with
    /// expectName (empty: any). ACC_DONE, ACC_PENDING (still acting after timeoutMs), ACC_NONE,
    /// ACC_MISMATCH (another object is at that point), ACC_NO_ACTION or ACC_FAILED.
    public static int AccDefaultAction(int x, int y, string expectName, int timeoutMs)
    {
        AccCall call = new AccCall();
        call.X = x;
        call.Y = y;
        call.Expect = expectName;
        Thread t = new Thread(call.Run);
        t.IsBackground = true;
        try { t.TrySetApartmentState(ApartmentState.STA); } catch (Exception) { }
        t.Start();
        if (!call.Done.WaitOne(Math.Max(50, timeoutMs))) return call.Acting ? ACC_PENDING : ACC_FAILED;
        ((IDisposable)call.Done).Dispose();
        return call.Result;
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

# ---------------------------------------------------------------- UI Automation: controls by name and role
#
# uitree / uifind read a window's control view; uiaction acts on an element with its UI Automation
# patterns (no mouse). Element ids are "<hwnd>.<i>.<j>...~<tag>": the window, the control-view child
# index at each level, and AnywhereNative.UiTag of the role and name. The element objects are cached
# for $script:UiCacheTtlSec; after that, or after a host restart, an id is resolved again by walking
# its indices, and the tag must still match. Bounds are physical pixels (the host is DPI aware).

$script:Uia = $null
$script:UiCache = @{}
$script:UiCacheTtlSec = 30
$script:UiCacheMax = 6000
# How long an action may run before it is reported as pending (a modal dialog the click opened).
$script:UiActionWaitMs = 2000
# Hard limit on the raw depth of a walk, whatever the compact depth.
$script:UiRawDepthMax = 64
$script:UiActions = @('press', 'focus', 'setValue', 'select', 'expand', 'collapse', 'scrollIntoView', 'showMenu')
# Roles an item of a list, menu or tab strip can have (select with a value).
$script:UiItemRoles = @('listitem', 'menuitem', 'treeitem', 'tab', 'row', 'cell', 'radio', 'checkbox')
$script:UiSparseWarning = 'This Chromium/Electron window exposed almost no controls. If it should have more, try again in a moment; if it stays empty, restart the app with --force-renderer-accessibility.'

function Limit-Int([int]$Value, [int]$Min, [int]$Max) {
  if ($Value -lt $Min) { return $Min }
  if ($Value -gt $Max) { return $Max }
  return $Value
}

# The innermost exception of an error record or exception, classified: Kind 'gone' (the element
# vanished), 'disabled' (ElementNotEnabledException) or 'failed'.
function Get-UiFault($Err) {
  $ex = $Err
  if ($Err -is [System.Management.Automation.ErrorRecord]) { $ex = $Err.Exception }
  while ($null -ne $ex.InnerException -and ($ex -is [System.Management.Automation.MethodInvocationException] -or $ex -is [System.Reflection.TargetInvocationException])) {
    $ex = $ex.InnerException
  }
  $name = $ex.GetType().Name
  $kind = 'failed'
  if ($name -eq 'ElementNotAvailableException') { $kind = 'gone' }
  elseif ($name -eq 'ElementNotEnabledException') { $kind = 'disabled' }
  return @{ Kind = $kind; Message = [string]$ex.Message }
}

# Loads UI Automation and builds the property list (in AnywhereNative.ReadUi's UP_* order), the
# cache requests and the pattern ids, once.
function Get-UiaRefs {
  if ($null -ne $script:Uia) { return $script:Uia }
  try { Use-Uia } catch {
    throw (New-HostError ('UI Automation is not available in this PowerShell: ' + (Get-UiFault $_).Message) 'UIA_UNAVAILABLE' 'Work from screenshots and coordinates instead.')
  }
  $AE = [System.Windows.Automation.AutomationElement]
  $props = [object[]]@(
    $AE::NameProperty,
    $AE::ControlTypeProperty,
    $AE::LocalizedControlTypeProperty,
    $AE::BoundingRectangleProperty,
    $AE::IsEnabledProperty,
    $AE::HasKeyboardFocusProperty,
    $AE::IsOffscreenProperty,
    $AE::HelpTextProperty,
    $AE::IsPasswordProperty,
    $AE::IsInvokePatternAvailableProperty,
    $AE::IsTogglePatternAvailableProperty,
    $AE::IsSelectionItemPatternAvailableProperty,
    $AE::IsExpandCollapsePatternAvailableProperty,
    $AE::IsValuePatternAvailableProperty,
    [System.Windows.Automation.ValuePattern]::ValueProperty,
    [System.Windows.Automation.ValuePattern]::IsReadOnlyProperty,
    [System.Windows.Automation.TogglePattern]::ToggleStateProperty,
    [System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty,
    [System.Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty,
    $AE::IsRangeValuePatternAvailableProperty,
    [System.Windows.Automation.RangeValuePattern]::ValueProperty
  )
  if ($props.Count -ne [AnywhereNative]::UiPropCount) { throw (New-HostError 'UI Automation property list mismatch.' 'UIA_FAILED' $null) }
  # Tree: the element and its control-view children, all with every property, in one round trip.
  $tree = New-Object System.Windows.Automation.CacheRequest
  $one = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in $props) { $tree.Add($p); $one.Add($p) }
  $tree.TreeScope = [System.Windows.Automation.TreeScope]::Element -bor [System.Windows.Automation.TreeScope]::Children
  $one.TreeScope = [System.Windows.Automation.TreeScope]::Element
  $tree.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
  $one.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
  $tree.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
  $one.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
  $script:Uia = @{
    Props = $props
    Tree = $tree
    One = $one
    NotSupported = $AE::NotSupported
    InvokeP = [System.Windows.Automation.InvokePattern]::Pattern
    ToggleP = [System.Windows.Automation.TogglePattern]::Pattern
    SelectP = [System.Windows.Automation.SelectionItemPattern]::Pattern
    ExpandP = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
    ScrollP = [System.Windows.Automation.ScrollItemPattern]::Pattern
    ValueP = [System.Windows.Automation.ValuePattern]::Pattern
    RangeP = [System.Windows.Automation.RangeValuePattern]::Pattern
  }
  return $script:Uia
}

function Read-UiInfo($El) {
  return [AnywhereNative]::ReadUi($El, $script:Uia.Props, $script:Uia.NotSupported)
}

function Clear-UiCache([bool]$All) {
  if ($All) { $script:UiCache.Clear(); return }
  $now = [DateTime]::UtcNow
  $old = New-Object 'System.Collections.Generic.List[string]'
  foreach ($k in $script:UiCache.Keys) {
    if (($now - $script:UiCache[$k].At).TotalSeconds -gt $script:UiCacheTtlSec) { $old.Add([string]$k) }
  }
  foreach ($k in $old) { $script:UiCache.Remove($k) }
}

function Save-UiElement([string]$Id, $El) {
  if ($script:UiCache.Count -ge $script:UiCacheMax) {
    Clear-UiCache $false
    if ($script:UiCache.Count -ge $script:UiCacheMax) { Clear-UiCache $true }
  }
  $script:UiCache[$Id] = @{ El = $El; At = [DateTime]::UtcNow }
}

function New-UiId([string]$Hwnd, [string]$Path, $Info) {
  $id = $Hwnd
  if ($Path) { $id += '.' + $Path }
  return $id + '~' + [AnywhereNative]::UiTag($Info.Role, $Info.Name)
}

# The window to read: args.hwnd, else the foreground window. @{ Handle; Id; Record }
function Resolve-UiWindow($A) {
  $h = $null
  if ([string](Get-Arg $A 'hwnd' '')) {
    $h = Get-Hwnd $A
  } else {
    $active = [AnywhereNative]::Active()
    if ($null -eq $active) { throw (New-HostError 'No window is active.' 'NOT_FOUND' 'Pass a window id from the window list.') }
    $h = New-Object System.IntPtr -ArgumentList ([long]$active.Hwnd)
  }
  $w = [AnywhereNative]::WindowInfo($h)
  if ($null -eq $w) { throw (New-HostError ('Window ' + $h.ToInt64() + ' does not exist.') 'NOT_FOUND' 'The window may have closed; list the windows again.') }
  $target = [AnywhereNative]::CheckWindow($h, $script:HostElevated)
  if ($null -ne $target -and [int]$target.Elevation -eq 1) {
    Add-HostWarning ("'" + $target.Name + "' runs as administrator, so Windows lets UI Automation read little or nothing of it and blocks actions on it.")
  }
  return @{ Handle = $h; Id = [string]$h.ToInt64(); Record = (ConvertTo-WindowRecord $w) }
}

function Get-UiRoot($Handle) {
  try {
    return [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  } catch {
    throw (New-HostError ('UI Automation cannot read window ' + $Handle.ToInt64() + ': ' + (Get-UiFault $_).Message) 'NOT_FOUND' 'The window may have closed; list the windows again.')
  }
}

# Open menus and drop-down lists of the window's app (separate popup windows), front to back.
function Get-UiPopups($Handle) {
  return [AnywhereNative]::PopupWindows($Handle, 4)
}

function Test-UiChromium($Record) {
  return ([string]$Record.className) -like 'Chrome_WidgetWin*'
}

# Breadth-first walk of the control view under $Root with one UI Automation round trip per expanded
# element (GetUpdatedCache with the Element|Children request brings the children with every
# property). $O: MaxLevel (levels of kept elements), MaxScan, MaxEmit (tree mode), Deadline (ms on
# $Sw), Compact, Find (find mode criteria or $null). Scroll bars are not entered.
# With Compact, wrappers (AnywhereNative.IsUiWrapper) are walked through but not kept: their
# children belong to the nearest kept ancestor. Find mode matches every scanned element except Root.
# Returns @{ Root; Kept (BFS order); Found; Scanned; Truncated }; each record is
# @{ El; Info; Path; Up (nearest kept ancestor); Level; Raw; Keep; Kids }.
function Invoke-UiWalk($Root, [string]$Hwnd, [string]$BasePath, $O, $Sw) {
  $U = $script:Uia
  $fresh = $Root.GetUpdatedCache($U.Tree)
  $rootRec = @{ El = $fresh; Info = (Read-UiInfo $fresh); Path = $BasePath; Key = ''; Up = $null; Level = 0; Raw = 0; Keep = $true; Fresh = $true; Mixed = $false; Kids = (New-Object 'System.Collections.Generic.List[object]') }
  $kept = New-Object 'System.Collections.Generic.List[object]'
  $kept.Add($rootRec)
  $found = New-Object 'System.Collections.Generic.List[object]'
  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $queue.Enqueue($rootRec)
  $F = $O.Find
  $scanned = 1
  $exact = 0
  $truncated = $false
  $stop = $false
  while ($queue.Count -gt 0 -and -not $stop) {
    if ($Sw.ElapsedMilliseconds -ge $O.Deadline) { $truncated = $true; break }
    $rec = $queue.Dequeue()
    $kids = $null
    try {
      if ($rec.Fresh) { $kids = $rec.El.CachedChildren } else { $kids = $rec.El.GetUpdatedCache($U.Tree).CachedChildren }
    } catch { $kids = $null }
    if ($null -eq $kids) { continue }
    $owner = $rec
    if (-not $rec.Keep) { $owner = $rec.Up }
    $count = $kids.Count
    for ($i = 0; $i -lt $count; $i++) {
      if ($scanned -ge $O.MaxScan) { $truncated = $true; $stop = $true; break }
      $c = $kids[$i]
      $info = $null
      try { $info = Read-UiInfo $c } catch { continue }
      $scanned++
      if ($info.TypeId -eq 50014 -or $info.TypeId -eq 50027) { continue }
      $path = [string]$i
      if ($rec.Path) { $path = $rec.Path + '.' + $i }
      $keep = $true
      if ($O.Compact) { $keep = -not [AnywhereNative]::IsUiWrapper($info, $owner.Info.Name) }
      $level = $owner.Level
      if ($keep) { $level++ }
      $r = @{ El = $c; Info = $info; Path = $path; Key = $rec.Key + '.' + $i.ToString('D5'); Up = $owner; Level = $level; Raw = $rec.Raw + 1; Keep = $keep; Fresh = $false; Mixed = $false; Kids = $null }
      if ($keep) {
        if ($null -eq $F -and $kept.Count -ge $O.MaxEmit) { $truncated = $true; $stop = $true; break }
        $r.Kids = New-Object 'System.Collections.Generic.List[object]'
        $kept.Add($r)
        $owner.Kids.Add($r)
        # Attached through a wrapper, so later than its siblings in breadth-first order.
        if (-not $rec.Keep) { $owner.Mixed = $true }
      }
      if ($null -ne $F) {
        $score = 0
        if ($null -eq $F.Roles -or $F.Roles.Contains($info.Role)) { $score = [AnywhereNative]::UiScore($info, $F.Name, $F.Text, $F.Exact) }
        if ($score -gt 0) {
          $found.Add(@{ Rec = $r; Score = $score })
          if ($score -ge 3) { $exact++ }
          if ($exact -ge $F.Limit -or $found.Count -ge ($F.Limit + 40)) { $stop = $true; break }
        }
      }
      if ($level -lt $O.MaxLevel -and $r.Raw -lt $script:UiRawDepthMax) { $queue.Enqueue($r) }
    }
  }
  return @{ Root = $rootRec; Kept = $kept; Found = $found; Scanned = $scanned; Truncated = $truncated }
}

function ConvertTo-UiBounds($Info) {
  return [ordered]@{ x = [int]$Info.X; y = [int]$Info.Y; width = [int]$Info.Width; height = [int]$Info.Height }
}

# Value, description and state fields shared by tree nodes and search results.
function Add-UiState($Node, $Info) {
  if ($null -ne $Info.Value) {
    $Node['value'] = [string]$Info.Value
    if ($Info.ValueClipped) { $Node['valueTruncated'] = $true }
  } elseif ($Info.HasRange) {
    $Node['value'] = $Info.Range.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($Info.Help) { $Node['description'] = [string]$Info.Help }
  $Node['bounds'] = ConvertTo-UiBounds $Info
  $Node['enabled'] = [bool]$Info.Enabled
  $Node['focused'] = [bool]$Info.Focused
  if ($Info.Selected -ge 0) { $Node['selected'] = ($Info.Selected -eq 1) }
  elseif ($Info.Toggle -ge 0) { $Node['selected'] = ($Info.Toggle -eq 1) }
  if ($Info.Toggle -eq 2) { $Node['checked'] = 'mixed' }
  elseif ($Info.Toggle -ge 0) { $Node['checked'] = ($Info.Toggle -eq 1) }
  if ($Info.Expand -ge 0 -and $Info.Expand -le 2) { $Node['expanded'] = ($Info.Expand -ne 0) }
  if ($Info.Offscreen) { $Node['offscreen'] = $true }
}

function Format-UiLabel($Info) {
  $label = [string]$Info.Role
  if ($Info.Name) {
    $n = [string]$Info.Name
    if ($n.Length -gt 40) { $n = $n.Substring(0, 39) + '...' }
    $label += ' "' + $n + '"'
  }
  return $label
}

# Where an element sits, for people: its kept ancestors from the window down, as role "name".
function Get-UiCrumb($Rec) {
  $parts = New-Object 'System.Collections.Generic.List[string]'
  $r = $Rec.Up
  while ($null -ne $r) {
    $parts.Insert(0, (Format-UiLabel $r.Info))
    $r = $r.Up
  }
  if ($parts.Count -gt 5) {
    $short = New-Object 'System.Collections.Generic.List[string]'
    $short.Add($parts[0])
    $short.Add('...')
    for ($i = $parts.Count - 3; $i -lt $parts.Count; $i++) { $short.Add($parts[$i]) }
    $parts = $short
  }
  return [string]::Join(' > ', $parts.ToArray())
}

# Next to nothing exposed: what a Chromium window shows before its accessibility tree exists.
function Test-UiSparse($Walk) {
  return $Walk.Kept.Count -le 3 -and $Walk.Scanned -le 8
}

# Children that came through wrappers were attached late: restore the window's order.
function Restore-UiOrder($Kept) {
  foreach ($r in $Kept) {
    if ($r.Mixed -and $r.Kids.Count -gt 1) {
      $sorted = @($r.Kids | Sort-Object -Property @{ Expression = { $_.Key } })
      $r.Kids.Clear()
      foreach ($k in $sorted) { $r.Kids.Add($k) }
    }
  }
}

# uitree {hwnd?, depth=6, maxNodes=400, budgetMs=3000, compact=true}
# -> {window:{id, app, title}, nodes (pre-order), truncated, scanned, elapsedMs, popups?}
function Get-UiTree($A) {
  Assert-Native
  [void](Get-UiaRefs)
  Clear-UiCache $false
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $win = Resolve-UiWindow $A
  $root = Get-UiRoot $win.Handle
  $o = @{
    MaxLevel = Limit-Int (Get-IntArg $A 'depth' 6) 1 60
    MaxEmit = Limit-Int (Get-IntArg $A 'maxNodes' 400) 1 5000
    Deadline = Limit-Int (Get-IntArg $A 'budgetMs' 3000) 100 30000
    Compact = [bool](Get-Arg $A 'compact' $true)
    Find = $null
  }
  $o.MaxScan = [Math]::Min(20000, [Math]::Max(2000, $o.MaxEmit * 10))
  $walk = Invoke-UiWalk $root $win.Id '' $o $sw
  # Chromium and Electron build their accessibility tree when a client first asks: look again.
  if ((Test-UiSparse $walk) -and (Test-UiChromium $win.Record) -and $sw.ElapsedMilliseconds -lt ($o.Deadline / 2)) {
    Start-Sleep -Milliseconds 500
    $walk = Invoke-UiWalk $root $win.Id '' $o $sw
  }
  if ((Test-UiSparse $walk) -and (Test-UiChromium $win.Record)) {
    Add-HostWarning $script:UiSparseWarning
  }
  Restore-UiOrder $walk.Kept
  foreach ($r in $walk.Kept) {
    $r.Id = New-UiId $win.Id $r.Path $r.Info
    Save-UiElement $r.Id $r.El
  }
  $nodes = New-Object System.Collections.ArrayList
  $stack = New-Object 'System.Collections.Generic.Stack[object]'
  $stack.Push($walk.Root)
  while ($stack.Count -gt 0) {
    $r = $stack.Pop()
    $n = [ordered]@{ id = $r.Id; role = [string]$r.Info.Role; name = [string]$r.Info.Name }
    Add-UiState $n $r.Info
    $parent = $null
    if ($null -ne $r.Up) { $parent = $r.Up.Id }
    $n['parent'] = $parent
    $ids = New-Object 'System.Collections.Generic.List[string]'
    foreach ($k in $r.Kids) { $ids.Add([string]$k.Id) }
    $n['children'] = $ids.ToArray()
    $n['depth'] = [int]$r.Level
    [void]$nodes.Add($n)
    for ($k = $r.Kids.Count - 1; $k -ge 0; $k--) { $stack.Push($r.Kids[$k]) }
  }
  $res = [ordered]@{
    window = [ordered]@{ id = $win.Id; app = [string]$win.Record.app; title = [string]$win.Record.title }
    nodes = $nodes
    truncated = [bool]$walk.Truncated
    scanned = [int]$walk.Scanned
    elapsedMs = [int]$sw.ElapsedMilliseconds
  }
  $popups = @(Get-UiPopups $win.Handle)
  if ($popups.Count -gt 0) {
    $ids = New-Object 'System.Collections.Generic.List[string]'
    foreach ($p in $popups) { $ids.Add([string]$p) }
    $res['popups'] = $ids.ToArray()
  }
  return $res
}

function New-UiFindCriteria([string]$Name, [string]$Text, $Roles, [bool]$Exact, [int]$Limit) {
  $set = $null
  foreach ($x in @($Roles)) {
    if ($null -eq $x) { continue }
    $s = ([string]$x).Trim().ToLowerInvariant()
    if (-not $s) { continue }
    if ($null -eq $set) { $set = New-Object 'System.Collections.Generic.HashSet[string]' }
    [void]$set.Add($s)
  }
  return @{
    Name = [AnywhereNative]::Squash($Name, 300)
    Text = [AnywhereNative]::Squash($Text, 300)
    Roles = $set
    Exact = $Exact
    Limit = $Limit
  }
}

# Best matches first: higher score, on screen, enabled, then in the order they were found.
function Sort-UiFound($Found) {
  $seq = 0
  foreach ($m in $Found) { $m.Seq = $seq; $seq++ }
  return @($Found | Sort-Object -Property @{ Expression = { $_.Score }; Descending = $true },
    @{ Expression = { [int][bool]$_.Rec.Info.Offscreen }; Descending = $false },
    @{ Expression = { [int](-not $_.Rec.Info.Enabled) }; Descending = $false },
    @{ Expression = { $_.Seq }; Descending = $false })
}

# Walk the window's open popups (menus, drop-downs) first, then the window itself.
function Invoke-UiSearch($Win, $O, $Sw) {
  $all = New-Object 'System.Collections.Generic.List[object]'
  $scanned = 0
  $truncated = $false
  $sparse = $false
  foreach ($p in @(Get-UiPopups $Win.Handle)) {
    if ($Sw.ElapsedMilliseconds -ge $O.Deadline) { $truncated = $true; break }
    $walk = $null
    try {
      $proot = [System.Windows.Automation.AutomationElement]::FromHandle((New-Object System.IntPtr -ArgumentList ([long]$p)))
      $walk = Invoke-UiWalk $proot ([string]$p) '' $O $Sw
    } catch { $walk = $null }
    if ($null -eq $walk) { continue }
    foreach ($m in $walk.Found) { $m.Hwnd = [string]$p; $all.Add($m) }
    $scanned += $walk.Scanned
    if ($walk.Truncated) { $truncated = $true }
  }
  if ($Sw.ElapsedMilliseconds -lt $O.Deadline) {
    $root = Get-UiRoot $Win.Handle
    $walk = Invoke-UiWalk $root $Win.Id '' $O $Sw
    if ($walk.Found.Count -eq 0 -and (Test-UiSparse $walk) -and (Test-UiChromium $Win.Record) -and $Sw.ElapsedMilliseconds -lt ($O.Deadline / 2)) {
      Start-Sleep -Milliseconds 500
      $walk = Invoke-UiWalk $root $Win.Id '' $O $Sw
    }
    foreach ($m in $walk.Found) { $m.Hwnd = $Win.Id; $all.Add($m) }
    $scanned += $walk.Scanned
    if ($walk.Truncated) { $truncated = $true }
    $sparse = (Test-UiSparse $walk) -and (Test-UiChromium $Win.Record)
  } else {
    $truncated = $true
  }
  return @{ Found = $all; Scanned = $scanned; Truncated = $truncated; Sparse = $sparse }
}

function ConvertTo-UiMatch($M) {
  $r = $M.Rec
  $info = $r.Info
  if (-not $r.Id) { $r.Id = New-UiId $M.Hwnd $r.Path $info }
  Save-UiElement $r.Id $r.El
  $n = [ordered]@{ id = $r.Id; role = [string]$info.Role; name = [string]$info.Name; value = $null }
  Add-UiState $n $info
  $n['windowId'] = [string]$M.Hwnd
  $n['path'] = Get-UiCrumb $r
  return $n
}

# uifind {hwnd?, name?, text?, role? (string or list), exact=false, limit=20, depth=60,
#   maxNodes=5000, budgetMs=3000} -> {matches, scanned, truncated, elapsedMs, window}
function Find-UiElements($A) {
  Assert-Native
  [void](Get-UiaRefs)
  Clear-UiCache $false
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $limit = Limit-Int (Get-IntArg $A 'limit' 20) 1 200
  $F = New-UiFindCriteria ([string](Get-Arg $A 'name' '')) ([string](Get-Arg $A 'text' '')) (Get-Arg $A 'role' $null) ([bool](Get-Arg $A 'exact' $false)) $limit
  if (-not $F.Name -and -not $F.Text -and $null -eq $F.Roles) {
    throw (New-HostError 'Give a name, text or role to look for.' 'BAD_ARGS' $null)
  }
  $win = Resolve-UiWindow $A
  $o = @{
    MaxLevel = Limit-Int (Get-IntArg $A 'depth' 60) 1 100
    MaxScan = Limit-Int (Get-IntArg $A 'maxNodes' 5000) 1 20000
    MaxEmit = 0
    Deadline = Limit-Int (Get-IntArg $A 'budgetMs' 3000) 100 30000
    Compact = $true
    Find = $F
  }
  $search = Invoke-UiSearch $win $o $sw
  if ($search.Found.Count -eq 0 -and $search.Sparse) { Add-HostWarning $script:UiSparseWarning }
  $list = New-Object System.Collections.ArrayList
  foreach ($m in (Sort-UiFound $search.Found)) {
    if ($list.Count -ge $limit) { break }
    [void]$list.Add((ConvertTo-UiMatch $m))
  }
  return [ordered]@{
    matches = $list
    scanned = [int]$search.Scanned
    truncated = [bool]$search.Truncated
    elapsedMs = [int]$sw.ElapsedMilliseconds
    window = [ordered]@{ id = $win.Id; app = [string]$win.Record.app; title = [string]$win.Record.title }
  }
}

function New-UiStaleError([string]$Id) {
  return (New-HostError ('UI element ' + $Id + ' is no longer there: the window changed since it was found.') 'STALE_ELEMENT' 'Look the element up again (ui_find or ui_tree) and use the new id.')
}

# An element id -> @{ El (fresh cache); Info; Handle; Hwnd; Path; Id }: the cached element while it
# is alive, else the element at the id's path, which must still have the id's role and name.
function Resolve-UiElement([string]$Id) {
  $U = $script:Uia
  $m = [regex]::Match($Id.Trim(), '^(-?\d{1,20})((?:\.\d{1,6})*)(?:~([0-9a-z]{2}))?$')
  if (-not $m.Success) {
    throw (New-HostError ("Invalid UI element id '" + $Id + "'.") 'BAD_ARGS' 'Use an id returned by ui_find or ui_tree.')
  }
  $id = $m.Value
  $hwnd = $m.Groups[1].Value
  $path = $m.Groups[2].Value.TrimStart('.')
  $tag = $m.Groups[3].Value
  $handle = New-Object System.IntPtr -ArgumentList ([long]$hwnd)
  $entry = $script:UiCache[$id]
  if ($null -ne $entry) {
    try {
      $fresh = $entry.El.GetUpdatedCache($U.One)
      $entry.At = [DateTime]::UtcNow
      return @{ El = $fresh; Info = (Read-UiInfo $fresh); Handle = $handle; Hwnd = $hwnd; Path = $path; Id = $id }
    } catch {
      $script:UiCache.Remove($id)
    }
  }
  $cur = Get-UiRoot $handle
  if ($path) {
    foreach ($seg in $path.Split('.')) {
      $index = [int]$seg
      $kids = $null
      try { $kids = $cur.GetUpdatedCache($U.Tree).CachedChildren } catch { $kids = $null }
      if ($null -eq $kids -or $index -ge $kids.Count) { throw (New-UiStaleError $id) }
      $cur = $kids[$index]
    }
  }
  $fresh = $null
  try { $fresh = $cur.GetUpdatedCache($U.One) } catch { throw (New-UiStaleError $id) }
  $info = Read-UiInfo $fresh
  if ($tag -and [AnywhereNative]::UiTag($info.Role, $info.Name) -ne $tag) { throw (New-UiStaleError $id) }
  Save-UiElement $id $fresh
  return @{ El = $fresh; Info = $info; Handle = $handle; Hwnd = $hwnd; Path = $path; Id = $id }
}

# UIPI: refuse elevated windows, warn about other accounts' windows (as for mouse and keyboard).
function Confirm-UiWindowInput($Handle) {
  Confirm-InputTarget ([AnywhereNative]::CheckWindow($Handle, $script:HostElevated))
}

function Enter-UiWindow($Handle) {
  return [bool][AnywhereNative]::ActivateForUi($Handle)
}

# Shift+F10 opens the context menu of the focused element.
function Send-UiMenuKey {
  Assert-InputAllowed $true 0 0
  [AnywhereNative]::Keys([int[]]@(0x10, 0x79))
}

# MSAA default action at the element's centre: 'done', 'pending', or why it could not be used.
function Invoke-UiLegacyAction($Info) {
  if (-not $Info.HasRect -or $Info.Offscreen -or $Info.Width -le 0 -or $Info.Height -le 0) { return 'the element is not on screen' }
  $x = $Info.X + [int][Math]::Floor($Info.Width / 2)
  $y = $Info.Y + [int][Math]::Floor($Info.Height / 2)
  $s = [AnywhereNative]::AccDefaultAction($x, $y, [string]$Info.Name, $script:UiActionWaitMs)
  if ($s -eq 0) { return 'done' }
  if ($s -eq 1) { return 'pending' }
  if ($s -eq -2) { return 'another element is at its centre' }
  if ($s -eq -3) { return 'it has no default action' }
  return 'not available'
}

function Get-UiPattern($El, $Pattern) {
  $p = $null
  try {
    if ($El.TryGetCurrentPattern($Pattern, [ref]$p)) { return $p }
  } catch { }
  return $null
}

function New-UiResult([bool]$Ok, [string]$Method, [string]$Reason) {
  $r = [ordered]@{ ok = $Ok; method = $Method }
  if ($Reason) { $r['reason'] = $Reason }
  return $r
}

function New-UiDisabledResult {
  $r = New-UiResult $false 'none' 'The element is disabled.'
  $r['disabled'] = $true
  return $r
}

# One pattern call (or SetFocus on the element itself when $Pattern is $null) with the action wait.
# Returns a result; throws STALE_ELEMENT when the element vanished.
function Invoke-UiCall($T, $Pattern, [string]$Call, $CallArgs, [string]$Method) {
  $target = $T.El
  if ($null -ne $Pattern) {
    $target = Get-UiPattern $T.El $Pattern
    if ($null -eq $target) { return $null }
  }
  try {
    $state = [AnywhereNative]::CallWithTimeout($target, $Call, $CallArgs, $script:UiActionWaitMs)
  } catch {
    $f = Get-UiFault $_
    if ($f.Kind -eq 'gone') { throw (New-UiStaleError $T.Id) }
    if ($f.Kind -eq 'disabled') { return (New-UiDisabledResult) }
    return (New-UiResult $false $Method ($Method + ' failed: ' + $f.Message))
  }
  $r = New-UiResult $true $Method $null
  if ($state -eq [AnywhereNative]::CALL_PENDING) {
    $r['pending'] = $true
    $r['reason'] = 'The app is still handling the action (it may have opened a dialog).'
  }
  return $r
}

# Try the steps in order; the first that works wins. Steps: invoke, toggle, select, expand,
# collapse, expandToggle (expand when collapsed, else collapse), scroll, legacy (MSAA).
function Invoke-UiSteps($T, [string[]]$Steps) {
  $U = $script:Uia
  $info = $T.Info
  if (-not $info.Enabled) { return (New-UiDisabledResult) }
  $reasons = New-Object 'System.Collections.Generic.List[string]'
  foreach ($step in $Steps) {
    $r = $null
    if ($step -eq 'invoke') { $r = Invoke-UiCall $T $U.InvokeP 'Invoke' $null 'invoke' }
    elseif ($step -eq 'toggle') { $r = Invoke-UiCall $T $U.ToggleP 'Toggle' $null 'toggle' }
    elseif ($step -eq 'select') { $r = Invoke-UiCall $T $U.SelectP 'Select' $null 'select' }
    elseif ($step -eq 'expand') { $r = Invoke-UiCall $T $U.ExpandP 'Expand' $null 'expand' }
    elseif ($step -eq 'collapse') { $r = Invoke-UiCall $T $U.ExpandP 'Collapse' $null 'collapse' }
    elseif ($step -eq 'expandToggle') {
      if ($info.Expand -eq 0) { $r = Invoke-UiCall $T $U.ExpandP 'Expand' $null 'expand' }
      elseif ($info.Expand -eq 1 -or $info.Expand -eq 2) { $r = Invoke-UiCall $T $U.ExpandP 'Collapse' $null 'collapse' }
    }
    elseif ($step -eq 'scroll') { $r = Invoke-UiCall $T $U.ScrollP 'ScrollIntoView' $null 'scrollIntoView' }
    elseif ($step -eq 'legacy') {
      $s = Invoke-UiLegacyAction $info
      if ($s -eq 'done') { $r = New-UiResult $true 'legacy' $null }
      elseif ($s -eq 'pending') { $r = New-UiResult $true 'legacy' 'The app is still handling the action (it may have opened a dialog).'; $r['pending'] = $true }
      else { [void]$reasons.Add('MSAA default action: ' + $s) }
    }
    if ($null -eq $r) { continue }
    if ($r.ok -or $r.Contains('disabled')) { return $r }
    if ($r.Contains('reason')) { [void]$reasons.Add([string]$r.reason) }
  }
  $why = 'The element has none of the UI Automation patterns for this (' + ($Steps -join ', ') + ').'
  if ($reasons.Count -gt 0) { $why = [string]::Join(' ', $reasons.ToArray()) }
  return (New-UiResult $false 'none' $why)
}

function Invoke-UiFocus($T) {
  if (-not $T.Info.Enabled) { return (New-UiDisabledResult) }
  [void](Enter-UiWindow $T.Handle)
  return (Invoke-UiCall $T $null 'SetFocus' $null 'focus')
}

function Set-UiValue($T, [string]$Value) {
  $U = $script:Uia
  $info = $T.Info
  if (-not $info.Enabled) { return (New-UiDisabledResult) }
  if ($info.HasValue -and -not $info.ReadOnly) {
    $r = Invoke-UiCall $T $U.ValueP 'SetValue' ([object[]]@($Value)) 'value'
    if ($null -ne $r) { return $r }
  }
  if ($info.HasRange) {
    $d = 0.0
    if ([double]::TryParse($Value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$d)) {
      $r = Invoke-UiCall $T $U.RangeP 'SetValue' ([object[]]@($d)) 'range'
      if ($null -ne $r) { return $r }
    } else {
      return (New-UiResult $false 'none' ('This is a range control; give a number, not ''' + $Value + '''.'))
    }
  }
  if ($info.HasValue -and $info.ReadOnly) { return (New-UiResult $false 'none' 'The element is read-only.') }
  return (New-UiResult $false 'none' 'The element has no settable value (no ValuePattern).')
}

# Select the item named $Value inside a list, combo box, menu or tab strip: expand it when it is
# collapsed, find the item among its descendants (or in the app's popups), select or invoke it,
# and collapse what was expanded.
function Select-UiItem($T, [string]$Value) {
  $U = $script:Uia
  $info = $T.Info
  if (-not $info.Enabled) { return (New-UiDisabledResult) }
  $expanded = $false
  if ($info.CanExpand -and $info.Expand -eq 0) {
    $r = Invoke-UiCall $T $U.ExpandP 'Expand' $null 'expand'
    if ($null -ne $r -and $r.ok) {
      $expanded = $true
      Start-Sleep -Milliseconds 250
    }
  }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $F = New-UiFindCriteria $Value '' $script:UiItemRoles $false 5
  $o = @{ MaxLevel = 8; MaxScan = 1500; MaxEmit = 0; Deadline = 1500; Compact = $true; Find = $F }
  $found = New-Object 'System.Collections.Generic.List[object]'
  $walk = Invoke-UiWalk $T.El $T.Hwnd $T.Path $o $sw
  foreach ($m in $walk.Found) { $m.Hwnd = $T.Hwnd; $found.Add($m) }
  if ($found.Count -eq 0) {
    $o.Deadline = 3000
    foreach ($p in @(Get-UiPopups $T.Handle)) {
      if ($sw.ElapsedMilliseconds -ge $o.Deadline) { break }
      try {
        $proot = [System.Windows.Automation.AutomationElement]::FromHandle((New-Object System.IntPtr -ArgumentList ([long]$p)))
        $pw = Invoke-UiWalk $proot ([string]$p) '' $o $sw
        foreach ($m in $pw.Found) { $m.Hwnd = [string]$p; $found.Add($m) }
      } catch { }
    }
  }
  if ($found.Count -eq 0) {
    if ($expanded) { [void](Invoke-UiCall $T $U.ExpandP 'Collapse' $null 'collapse') }
    return (New-UiResult $false 'none' ("No item named '" + $Value + "' was found in this element."))
  }
  $best = @(Sort-UiFound $found)[0]
  $rec = $best.Rec
  $item = @{ El = $rec.El; Info = $rec.Info; Handle = (New-Object System.IntPtr -ArgumentList ([long]$best.Hwnd)); Hwnd = $best.Hwnd; Path = $rec.Path; Id = (New-UiId $best.Hwnd $rec.Path $rec.Info) }
  Save-UiElement $item.Id $item.El
  $r = Invoke-UiSteps $item @('select', 'invoke', 'legacy')
  if ($r.ok -and $expanded -and -not $r.Contains('pending')) {
    try {
      $now = Read-UiInfo ($T.El.GetUpdatedCache($U.One))
      if ($now.Expand -eq 1) { [void](Invoke-UiCall $T $U.ExpandP 'Collapse' $null 'collapse') }
    } catch { }
  }
  $r['item'] = [ordered]@{ id = $item.Id; role = [string]$rec.Info.Role; name = [string]$rec.Info.Name }
  return $r
}

# A context menu: expand a menu button, else focus the element and press Shift+F10.
function Show-UiMenu($T) {
  $info = $T.Info
  if (-not $info.Enabled) { return (New-UiDisabledResult) }
  if ($info.CanExpand -and $info.Expand -eq 0 -and ($info.Role -eq 'menuitem' -or $info.Role -eq 'button' -or $info.Role -eq 'combobox')) {
    $r = Invoke-UiCall $T $script:Uia.ExpandP 'Expand' $null 'expand'
    if ($null -ne $r -and $r.ok) { return $r }
  }
  [void](Enter-UiWindow $T.Handle)
  $f = Invoke-UiCall $T $null 'SetFocus' $null 'focus'
  if (-not $f.ok) { return (New-UiResult $false 'none' ('Could not focus the element for its context menu: ' + [string]$f.reason)) }
  Start-Sleep -Milliseconds 60
  Send-UiMenuKey
  return (New-UiResult $true 'keyboard' $null)
}

# uiaction {id, action, value?} -> {ok, method, pending?, reason?, disabled?, item?, id, role, name,
# bounds, value?}. ok:false with method 'none' means no UI Automation way worked: the caller may
# fall back to the mouse at bounds.
function Invoke-UiAction($A) {
  Assert-Native
  [void](Get-UiaRefs)
  Clear-UiCache $false
  $want = ([string](Get-Arg $A 'action' '')).Trim()
  $action = $null
  foreach ($k in $script:UiActions) { if ($k -eq $want) { $action = $k } }
  if (-not $action) {
    throw (New-HostError ("Unknown UI action '" + $want + "'.") 'BAD_ARGS' ('Use one of: ' + ($script:UiActions -join ', ') + '.'))
  }
  $hasValue = $null -ne (Get-Arg $A 'value' $null)
  $value = [string](Get-Arg $A 'value' '')
  if ($action -eq 'setValue' -and -not $hasValue) { throw (New-HostError 'setValue needs a value.' 'BAD_ARGS' $null) }
  $t = Resolve-UiElement ([string](Get-Arg $A 'id' ''))
  Confirm-UiWindowInput $t.Handle
  $res = $null
  if ($action -eq 'press') { $res = Invoke-UiSteps $t @('invoke', 'toggle', 'select', 'expandToggle', 'legacy') }
  elseif ($action -eq 'focus') { $res = Invoke-UiFocus $t }
  elseif ($action -eq 'setValue') { $res = Set-UiValue $t $value }
  elseif ($action -eq 'select') {
    if ($value) { $res = Select-UiItem $t $value } else { $res = Invoke-UiSteps $t @('select', 'invoke') }
  }
  elseif ($action -eq 'expand') { $res = Invoke-UiSteps $t @('expand') }
  elseif ($action -eq 'collapse') { $res = Invoke-UiSteps $t @('collapse') }
  elseif ($action -eq 'scrollIntoView') { $res = Invoke-UiSteps $t @('scroll') }
  else { $res = Show-UiMenu $t }
  $info = $t.Info
  if (-not $res.Contains('pending')) {
    try { $info = Read-UiInfo ($t.El.GetUpdatedCache($script:Uia.One)) } catch { $info = $t.Info }
  }
  $res['id'] = $t.Id
  $res['role'] = [string]$info.Role
  $res['name'] = [string]$info.Name
  $res['bounds'] = ConvertTo-UiBounds $info
  if ($null -ne $info.Value) { $res['value'] = [string]$info.Value }
  return $res
}

# uiinfo -> {available, error}: whether UI Automation loads in this PowerShell.
function Get-UiInfo {
  if (-not $script:IsWin) { return [ordered]@{ available = $false; error = 'UI Automation needs Windows.' } }
  try {
    [void](Get-UiaRefs)
    return [ordered]@{ available = $true; error = $null }
  } catch {
    return [ordered]@{ available = $false; error = (Get-UiFault $_).Message }
  }
}

# winbounds {hwnd, state?: maximize|minimize|restore|fullscreen, x?, y?, width?, height?}
# -> {ok, error, x, y, width, height, state: normal|minimized|maximized}
function Set-WindowBounds($A) {
  Assert-Native
  $h = Get-Hwnd $A
  if (-not [AnywhereNative]::IsWindowHandle($h)) { return [ordered]@{ ok = $false; error = 'The window does not exist.' } }
  $state = ([string](Get-Arg $A 'state' '')).Trim()
  $mask = 0
  $x = 0; $y = 0; $w = 0; $hh = 0
  if ($null -ne (Get-Arg $A 'x')) { $x = Get-IntArg $A 'x'; $mask = $mask -bor 1 }
  if ($null -ne (Get-Arg $A 'y')) { $y = Get-IntArg $A 'y'; $mask = $mask -bor 2 }
  if ($null -ne (Get-Arg $A 'width')) { $w = Get-IntArg $A 'width'; $mask = $mask -bor 4 }
  if ($null -ne (Get-Arg $A 'height')) { $hh = Get-IntArg $A 'height'; $mask = $mask -bor 8 }
  if (-not $state -and $mask -eq 0) { throw (New-HostError 'Give a state or bounds.' 'BAD_ARGS' $null) }
  $ok = $true
  $err = $null
  if ($state) {
    $ok = [bool][AnywhereNative]::SetWindowState($h, $state)
    if (-not $ok) { $err = 'Windows did not ' + $state + ' the window.' }
  }
  if ($ok -and $mask -ne 0) {
    $ok = [bool][AnywhereNative]::SetWindowBounds($h, $x, $y, $w, $hh, $mask)
    if (-not $ok) {
      $code = [AnywhereNative]::LastBoundsError
      $err = 'SetWindowPos failed (Win32 error ' + $code + ').'
      if ($code -eq 5) { $err += ' The window runs as administrator.' }
    }
  }
  $res = [ordered]@{ ok = $ok; error = $err }
  $b = [AnywhereNative]::WindowBounds($h)
  if ($null -ne $b) {
    $res['x'] = $b[0]; $res['y'] = $b[1]; $res['width'] = $b[2]; $res['height'] = $b[3]
    $res['state'] = @('normal', 'minimized', 'maximized')[$b[4]]
  }
  return $res
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
    'uiinfo' { return (Get-UiInfo) }
    'uitree' { return (Get-UiTree $A) }
    'uifind' { return (Find-UiElements $A) }
    'uiaction' { return (Invoke-UiAction $A) }
    'winbounds' { return (Set-WindowBounds $A) }
    'clipget' { return @{ text = (Get-ClipText) } }
    'clipset' { return (Set-ClipText ([string](Get-Arg $A 'text' ''))) }
    'notify' { return (Show-Notification ([string](Get-Arg $A 'title' '')) ([string](Get-Arg $A 'body' ''))) }
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
