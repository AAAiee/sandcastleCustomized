// Embedded deliberately: the built package carries the exact supervisor source.
export const windowsSupervisor = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SandcastleOwnedProcess {
  [StructLayout(LayoutKind.Sequential)] struct Limits { public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint Size; public string Reserved, Desktop, Title; public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error; }
  [StructLayout(LayoutKind.Sequential)] struct StartupExtended { public Startup Basic; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct Information { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exit);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exit);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exit);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, ref Security security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupExtended startup, out Information information);
  static void Check(bool condition) { if (!condition) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static uint Active(IntPtr job) { Accounting value; Check(QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf<Accounting>(),IntPtr.Zero)); return value.Active; }
  static void Emit(object value) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }
  static string Quote(string value) {
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='"') { result.Append('\\',slashes*2+1); result.Append(c); } else { result.Append('\\',slashes); result.Append(c); } slashes=0; }
    result.Append('\\',slashes*2); return result.Append('"').ToString();
  }
  static bool Stop(IntPtr job, Information info, bool assigned) {
    if(info.Process!=IntPtr.Zero && !assigned) { uint exit; if(!GetExitCodeProcess(info.Process,out exit)) return false; if(exit==259 && !TerminateProcess(info.Process,125)) return false; if(WaitForSingleObject(info.Process,10000)!=0) return false; }
    if(job==IntPtr.Zero) return true;
    if(!TerminateJobObject(job,125)) return false;
    var wait=Stopwatch.StartNew(); while(Active(job)!=0) { if(wait.ElapsedMilliseconds>10000) return false; Thread.Sleep(10); } return true;
  }
  public static void Run(string path) {
    IntPtr job=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,attributes=IntPtr.Zero,jobList=IntPtr.Zero; var info=new Information(); bool assigned=false,attributesInitialized=false;
    try {
      var c=JsonDocument.Parse(File.ReadAllText(path)).RootElement;
      string jobName=c.GetProperty("jobName").GetString();
      if(c.GetProperty("mode").GetString()=="observe") {
        var pid=c.GetProperty("supervisorPid").GetInt32(); string start=c.GetProperty("supervisorStart").GetString();
        try { using(var process=Process.GetProcessById(pid)) { if(process.StartTime.ToUniversalTime().Ticks.ToString()==start && !process.HasExited) { Emit(new {type="observed",quiescent=false}); return; } } } catch(ArgumentException) { }
        job=OpenJobObject(4,false,jobName);
        if(job==IntPtr.Zero) { Check(Marshal.GetLastWin32Error()==2); Emit(new {type="observed",quiescent=true}); }
        else Emit(new {type="observed",quiescent=Active(job)==0});
        return;
      }
      using(var self=Process.GetCurrentProcess()) Emit(new {type="identity",supervisorPid=self.Id,supervisorStart=self.StartTime.ToUniversalTime().Ticks.ToString()});
      int timeout=c.GetProperty("timeoutMs").GetInt32(); var watch=Stopwatch.StartNew();
      Task<string> control=Task.Run(()=>Console.In.ReadLine());
      if(!control.Wait(Math.Min(timeout,30000)) || control.Result!="prepare") { Emit(new {type="done",reason="cancelled",exitCode=125,quiescent=true}); return; }
      job=CreateJobObject(IntPtr.Zero,jobName); Check(job!=IntPtr.Zero); Check(Marshal.GetLastWin32Error()!=183);
      var limits=new Extended(); limits.Basic.Flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<Extended>()));
      var security=new Security {Size=Marshal.SizeOf<Security>(),Inherit=true};
      output=CreateFile(c.GetProperty("stdout").GetString(),0x40000000,7,ref security,2,0,IntPtr.Zero); Check(output!=new IntPtr(-1));
      error=CreateFile(c.GetProperty("stderr").GetString(),0x40000000,7,ref security,2,0,IntPtr.Zero); Check(error!=new IntPtr(-1));
      input=CreateFile("NUL",0x80000000,7,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1));
      string executable=c.GetProperty("executable").GetString(); var command=new StringBuilder(Quote(executable));
      foreach(var arg in c.GetProperty("args").EnumerateArray()) command.Append(' ').Append(Quote(arg.GetString()));
      // Windows 10+ atomic job assignment closes the crash gap between process
      // creation and a separate AssignProcessToJobObject call. Still suspended:
      // no child instruction executes before the durable owned acknowledgment.
      IntPtr attributeSize=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeSize);
      attributes=Marshal.AllocHGlobal(attributeSize); Check(InitializeProcThreadAttributeList(attributes,1,0,ref attributeSize)); attributesInitialized=true;
      jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x0002000D),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      var startup=new StartupExtended {Basic=new Startup {Size=(uint)Marshal.SizeOf<StartupExtended>(),Flags=0x100,Input=input,Output=output,Error=error},Attributes=attributes};
      Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,c.GetProperty("cwd").GetString(),ref startup,out info));
      assigned=true; bool member; Check(IsProcessInJob(info.Process,job,out member)); Check(member);
      Emit(new {type="owned",childPid=info.ProcessId});
      control=Task.Run(()=>Console.In.ReadLine());
      if(!control.Wait(Math.Min(timeout,30000)) || control.Result!="go") { bool stopped=Stop(job,info,assigned); Emit(new {type="done",reason="cancelled",exitCode=125,quiescent=stopped}); return; }
      Check(ResumeThread(info.Thread)!=0xffffffff); control=Task.Run(()=>Console.In.ReadLine());
      string reason="completed";
      while(Active(job)!=0) {
        if(control.IsCompleted) { reason="cancelled"; break; }
        if(watch.ElapsedMilliseconds>=timeout) { reason="timeout"; break; }
        Thread.Sleep(10);
      }
      bool quiescent=reason=="completed" ? Active(job)==0 : Stop(job,info,assigned);
      uint code; Check(GetExitCodeProcess(info.Process,out code));
      Emit(new {type="done",reason,exitCode=unchecked((int)code),quiescent});
    } catch(Exception e) {
      bool quiet=false; try { quiet=Stop(job,info,assigned); } catch { }
      Emit(new {type="failed",message=e.Message,quiescent=quiet});
    } finally {
      if(attributesInitialized) DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      foreach(var handle in new[]{info.Thread,info.Process,input,output,error,job}) if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle);
    }
  }
}
'@
[SandcastleOwnedProcess]::Run($args[0])
`;
