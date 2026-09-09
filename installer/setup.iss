#define MyAppName "GW1 Live Trade Prices"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Inkspot77"
#define MyAppURL "https://github.com/Inkspot77/gw1-live-trade-prices"

[Setup]
AppId={{55116AE9-D5F4-4CB9-AAF7-6D0498190C90}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
; {localappdata} + lowest privileges: no admin prompt, since the app writes
; its own data continuously and nothing it does needs elevation.
DefaultDirName={localappdata}\GW1TradePrices
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=GW1TradePrices-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; No code-signing certificate for v1 — Windows SmartScreen will warn on
; first run ("Windows protected your PC"). Documented in
; deploy/DEPLOY.md's Troubleshooting table rather than blocking on a cert.

[Files]
; dist\ is assembled by CI (see the windows-installer job in
; .github/workflows/docker-image.yml): the portable Node runtime, bin/,
; src/, public/, data/gwtoolbox-items.json, and this folder's launch
; scripts. Never ship a pre-populated data\prices.db — openDatabase()
; creates it fresh per machine on first run.
Source: "..\dist\*"; DestDir: "{app}"; Flags: recursesubdirs

[Tasks]
Name: "startupicon"; Description: "Start {#MyAppName} when Windows starts"; GroupDescription: "Additional options:"

[Icons]
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\launch.vbs"
Name: "{group}\{#MyAppName}"; Filename: "{app}\launch.vbs"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\launch.vbs"; Tasks: startupicon

[Run]
Filename: "{app}\launch.vbs"; Flags: postinstall nowait skipifsilent; Description: "Launch {#MyAppName} now"

; Deliberately no [UninstallDelete] entry for "{app}\data". The uninstaller
; only removes files it tracked from [Files] above; data\prices.db is
; created at runtime and never shipped, so it's never in that list and
; survives uninstall untouched. See deploy/DEPLOY.md.
