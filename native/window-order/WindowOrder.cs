// Lists the visible top-level windows from the top of the z-order down, as JSON:
// [{"pid":123,"x":0,"y":0,"w":800,"h":600}, ...] in physical screen pixels. The app uses it to work
// out which part of its own window is actually showing, so Screen OCR never reads the app's own
// text. Read-only: it only enumerates windows.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT = 0x20;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int DWMWA_CLOAKED = 14;

    static int Main()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }

        List<string> items = new List<string>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
            // Click-through overlays don't hide what is underneath them.
            if ((GetWindowLong(hWnd, GWL_EXSTYLE) & WS_EX_TRANSPARENT) != 0) return true;

            int cloaked;
            if (DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;

            RECT rect;
            if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0) return true;
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            items.Add("{\"pid\":" + pid + ",\"x\":" + rect.Left + ",\"y\":" + rect.Top + ",\"w\":" + width + ",\"h\":" + height + "}");
            return true;
        }, IntPtr.Zero);

        Console.Out.Write("[" + string.Join(",", items.ToArray()) + "]");
        return 0;
    }
}
