' Runs launch.bat with no visible console window for the launcher itself
' (node's own console, opened by `start` inside launch.bat, still shows —
' that's the window the README tells Windows users to leave open).
Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")
scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
objShell.Run """" & scriptDir & "\launch.bat""", 0, False
