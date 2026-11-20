Unicode true
!include "MUI2.nsh"

Name "LH Video"
OutFile "..\dist\LH Video Setup 0.1.0.exe"
InstallDir "$LOCALAPPDATA\LH Video"
InstallDirRegKey HKCU "Software\LHVideo" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!define MUI_ICON "lh-video.ico"
!define MUI_UNICON "lh-video.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\LHVideo.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch LH Video"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Spanish"

Section "LH Video" SecMain
  SetOutPath "$INSTDIR"
  File /r "..\dist\stage\app"
  File "..\dist\stage\node.exe"
  File "..\dist\stage\LHVideo.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\LHVideo" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LHVideo" "DisplayName" "LH Video"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LHVideo" "DisplayVersion" "0.1.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LHVideo" "Publisher" "Lamboy Holdings"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LHVideo" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LHVideo" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LHVideo" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LHVideo" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\LH Video"
  CreateShortCut "$SMPROGRAMS\LH Video\LH Video.lnk" "$INSTDIR\LHVideo.exe"
  CreateShortCut "$SMPROGRAMS\LH Video\Uninstall LH Video.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\LH Video.lnk" "$INSTDIR\LHVideo.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\LH Video.lnk"
  RMDir /r "$SMPROGRAMS\LH Video"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LHVideo"
  DeleteRegKey HKCU "Software\LHVideo"
  RMDir /r "$INSTDIR"
SectionEnd
