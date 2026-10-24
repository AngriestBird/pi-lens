---
section: Fixed
audience: user
---

- **csharp-ls no longer crashes with SIGABRT in C# folders that have no solution or project** — for a C# file with no `.sln`/`.slnx`/`.csproj` above it (a Unity `Assets/**` tree is the common case), the root fallback handed csharp-ls the file's own directory. csharp-ls then threw "no .csproj/.fsproj or sln files found" on a thread-pool thread and the .NET runtime aborted the process, leaving a core dump per attempt. The C# server now declines to spawn in a directory with no solution or project file, so the file is simply not analysed.
