// Lists the applications that currently have an audio session on any active playback device,
// as a JSON array on stdout: [{"pid":123,"exe":"chrome.exe","name":"Google Chrome","path":"...",
// "playing":true}, ...]. Used by the app to let the user choose which applications to listen to.
// Read-only: it never opens or captures any audio stream.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection
{
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
        [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2
{
    [PreserveSig] int GetAudioSessionControl(IntPtr audioSessionGuid, int streamFlags, out IntPtr sessionControl);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr audioSessionGuid, int streamFlags, out IntPtr audioVolume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator
{
    [PreserveSig] int GetCount(out int sessionCount);
    [PreserveSig] int GetSession(int sessionIndex, out IAudioSessionControl2 session);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2
{
    // IAudioSessionControl
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
    [PreserveSig] int GetGroupingParam(out Guid groupingParam);
    [PreserveSig] int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr newNotifications);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr newNotifications);
    // IAudioSessionControl2
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint processId);
    [PreserveSig] int IsSystemSoundsSession();
}

static class Program
{
    static string Escape(string value)
    {
        StringBuilder builder = new StringBuilder();
        foreach (char c in value ?? "")
        {
            if (c == '"' || c == '\\') builder.Append('\\').Append(c);
            else if (c < 32) builder.AppendFormat("\\u{0:x4}", (int)c);
            else builder.Append(c);
        }
        return builder.ToString();
    }

    static int Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Dictionary<uint, bool> sessions = new Dictionary<uint, bool>();
        try
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDeviceCollection devices;
            // eRender = 0, DEVICE_STATE_ACTIVE = 1
            if (enumerator.EnumAudioEndpoints(0, 1, out devices) == 0)
            {
                uint deviceCount;
                devices.GetCount(out deviceCount);
                Guid managerIid = typeof(IAudioSessionManager2).GUID;
                for (uint d = 0; d < deviceCount; d++)
                {
                    IMMDevice device;
                    if (devices.Item(d, out device) != 0) continue;
                    object managerObject;
                    // CLSCTX_ALL = 23
                    if (device.Activate(ref managerIid, 23, IntPtr.Zero, out managerObject) != 0) continue;
                    IAudioSessionEnumerator sessionEnumerator;
                    if (((IAudioSessionManager2)managerObject).GetSessionEnumerator(out sessionEnumerator) != 0) continue;
                    int count;
                    sessionEnumerator.GetCount(out count);
                    for (int i = 0; i < count; i++)
                    {
                        IAudioSessionControl2 control;
                        if (sessionEnumerator.GetSession(i, out control) != 0) continue;
                        uint pid;
                        int state;
                        if (control.GetProcessId(out pid) != 0 || pid == 0) continue;
                        if (control.IsSystemSoundsSession() == 0) continue;
                        control.GetState(out state);
                        bool playing = state == 1;
                        bool existing;
                        sessions[pid] = (sessions.TryGetValue(pid, out existing) && existing) || playing;
                    }
                }
            }
        }
        catch (Exception)
        {
            Console.Error.WriteLine("Unable to read audio sessions.");
            return 1;
        }

        List<string> items = new List<string>();
        foreach (KeyValuePair<uint, bool> session in sessions)
        {
            string exe = "", name = "", path = "";
            try
            {
                Process process = Process.GetProcessById((int)session.Key);
                exe = process.ProcessName + ".exe";
                name = process.ProcessName;
                try
                {
                    path = process.MainModule.FileName;
                    exe = Path.GetFileName(path);
                    FileVersionInfo info = FileVersionInfo.GetVersionInfo(path);
                    if (!string.IsNullOrEmpty(info.FileDescription)) name = info.FileDescription;
                    else if (!string.IsNullOrEmpty(info.ProductName)) name = info.ProductName;
                }
                catch (Exception) { /* protected process: keep the process name */ }
            }
            catch (Exception)
            {
                continue; // the process ended
            }
            items.Add("{\"pid\":" + session.Key + ",\"exe\":\"" + Escape(exe) + "\",\"name\":\"" + Escape(name) +
                "\",\"path\":\"" + Escape(path) + "\",\"playing\":" + (session.Value ? "true" : "false") + "}");
        }
        Console.Out.Write("[" + string.Join(",", items.ToArray()) + "]");
        return 0;
    }
}
