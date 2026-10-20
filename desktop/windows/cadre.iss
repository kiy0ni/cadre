; Installateur Windows de Cadre (Inno Setup 6). Construit par « pnpm dist:win » sur Windows.
; Installation par utilisateur (pas besoin d'être administrateur), menu Démarrer, raccourci bureau, liens cadre://.
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef Arch
  #define Arch "x64"
#endif

[Setup]
AppId={{6B1C4E2A-7F3D-4C8B-9A21-CADRE0000001}
AppName=Cadre
AppVersion={#AppVersion}
AppPublisher=Cadre
DefaultDirName={localappdata}\Programs\Cadre
DefaultGroupName=Cadre
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=Cadre-Setup-{#Arch}
SetupIconFile={#SourceDir}\..\..\icon.ico
UninstallDisplayIcon={app}\Cadre.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed={#Arch}compatible
ArchitecturesInstallIn64BitMode={#Arch}compatible

[Languages]
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "Créer un raccourci sur le bureau"; GroupDescription: "Raccourcis :"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Cadre"; Filename: "{app}\Cadre.exe"
Name: "{autodesktop}\Cadre"; Filename: "{app}\Cadre.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\cadre"; ValueType: string; ValueName: ""; ValueData: "URL:Cadre"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\cadre"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\cadre\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Cadre.exe"" ""%1"""

[Run]
Filename: "{app}\Cadre.exe"; Description: "Lancer Cadre"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/IM Cadre.exe /F"; Flags: runhidden; RunOnceId: "StopCadre"
