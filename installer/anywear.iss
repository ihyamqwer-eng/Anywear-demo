#ifndef StageDir
  #error StageDir must point to the staged installer payload.
#endif

#ifndef OutputDir
  #define OutputDir "output"
#endif

#define AppName "Qingye Anywear"
#define AppVersion "0.3.0"

[Setup]
AppId={{B9EC759B-EA25-472F-89E7-C74EB4A4B87D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=QingyeTech
DefaultDirName={localappdata}\QingyeTech\Anywear\app-runtime
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ChangesEnvironment=yes
OutputDir={#OutputDir}
OutputBaseFilename=Anywear-Setup-x64
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\app\scripts\anywear.cmd"; Parameters: "start"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\app\scripts\anywear.cmd"; Parameters: "start"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Run]
Filename: "{app}\app\scripts\anywear.cmd"; Parameters: "start"; Description: "Start {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
function CommandDirectory: String;
begin
  Result := ExpandConstant('{app}\app\scripts');
end;

function PathContains(const PathValue, Entry: String): Boolean;
var
  Remaining: String;
  CurrentEntry: String;
  Separator: Integer;
begin
  Result := False;
  Remaining := PathValue;
  while Remaining <> '' do
  begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then
    begin
      CurrentEntry := Remaining;
      Remaining := '';
    end
    else
    begin
      CurrentEntry := Copy(Remaining, 1, Separator - 1);
      Delete(Remaining, 1, Separator);
    end;
    if CompareText(Trim(CurrentEntry), Entry) = 0 then
    begin
      Result := True;
      exit;
    end;
  end;
end;

function PathWithoutEntry(const PathValue, Entry: String): String;
var
  Remaining: String;
  CurrentEntry: String;
  Separator: Integer;
  FirstEntry: Boolean;
begin
  Result := '';
  Remaining := PathValue;
  FirstEntry := True;
  while Remaining <> '' do
  begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then
    begin
      CurrentEntry := Remaining;
      Remaining := '';
    end
    else
    begin
      CurrentEntry := Copy(Remaining, 1, Separator - 1);
      Delete(Remaining, 1, Separator);
    end;
    if CompareText(Trim(CurrentEntry), Entry) <> 0 then
    begin
      if not FirstEntry then
        Result := Result + ';';
      Result := Result + CurrentEntry;
      FirstEntry := False;
    end;
  end;
end;

procedure AddCommandPath;
var
  UserPath: String;
  Entry: String;
begin
  Entry := CommandDirectory;
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', UserPath) then
    UserPath := '';
  if PathContains(UserPath, Entry) then
    exit;
  if (UserPath <> '') and (Copy(UserPath, Length(UserPath), 1) <> ';') then
    UserPath := UserPath + ';';
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', UserPath + Entry);
end;

procedure RemoveCommandPath;
var
  UserPath: String;
  UpdatedPath: String;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', UserPath) then
    exit;
  UpdatedPath := PathWithoutEntry(UserPath, CommandDirectory);
  if UpdatedPath = UserPath then
    exit;
  if UpdatedPath = '' then
    RegDeleteValue(HKCU, 'Environment', 'Path')
  else
    RegWriteExpandStringValue(HKCU, 'Environment', 'Path', UpdatedPath);
end;

function ConfigDirectory: String;
begin
  Result := ExpandConstant('{localappdata}\QingyeTech\Anywear');
end;

function StopInstalledService: Boolean;
var
  RuntimePath: String;
  CliPath: String;
  ExitCode: Integer;
begin
  RuntimePath := ExpandConstant('{app}\runtime\node.exe');
  CliPath := ExpandConstant('{app}\app\scripts\anywear-cli.mjs');
  if not FileExists(RuntimePath) or not FileExists(CliPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Exec(RuntimePath, '"' + CliPath + '" stop', ExtractFileDir(CliPath), SW_HIDE, ewWaitUntilTerminated, ExitCode)
    and (ExitCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if StopInstalledService then
    Result := ''
  else
    Result := 'Anywear could not stop its local service. Close the running app and retry the installation.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopInstalledService;
  if not Result then
    MsgBox('Anywear could not stop its local service. Close the running app and retry the uninstall.', mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigPath: String;
  SeedPath: String;
begin
  if CurStep <> ssPostInstall then
    exit;

  ForceDirectories(ConfigDirectory);
  ConfigPath := AddBackslash(ConfigDirectory) + '.env';
  SeedPath := ExpandConstant('{app}\app\.env.seed');
  if not FileExists(ConfigPath) then
    CopyFile(SeedPath, ConfigPath, False);
  AddCommandPath;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveCommandPath;
end;
