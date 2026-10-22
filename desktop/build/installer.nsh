; Movira — Open With / Default apps registration (per-user, HKCU).
;
; electron-builder's fileAssociations already create per-extension ProgIds
; (double-click handlers). This include additionally registers Movira as a
; REGISTERED APPLICATION with Capabilities, which is what makes it appear in:
;   - Explorer right-click → Open with → "Choose another app" full list
;   - Windows Settings → Apps → Default apps (so the user can set Movira as
;     the default player for any format WITHOUT stealing the default from
;     VLC or any other player automatically).
;
; All writes are per-user (HKCU) — no admin rights required.

!macro MoviraRegisterApplication
  ; Application registration visible to Windows' Open With / Default apps.
  ; (${PRODUCT_NAME} etc. are electron-builder defines; the product name is
  ; hard-coded here so the keys are stable regardless of define availability.)
  WriteRegStr HKCU "Software\Movira" "ApplicationName" "Movira"
  WriteRegStr HKCU "Software\Movira" "ApplicationCompany" "Movira"
  WriteRegStr HKCU "Software\Movira" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Movira\Capabilities" "ApplicationName" "Movira"
  WriteRegStr HKCU "Software\Movira\Capabilities" "ApplicationDescription" "A lightweight offline media player for video and audio."
  WriteRegStr HKCU "Software\Movira\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Movira\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Movira\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; File-type capability list (extends Open With entries beyond the ProgIds).
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mp4"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".m4v"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mkv"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".webm" "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mov"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".avi"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".wmv"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".asf"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".flv"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".f4v"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".ts"   "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".m2ts" "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mts"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".vob"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mpg"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mpeg" "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mpe"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".3gp"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".3g2"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".ogv"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".divx" "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".xvid" "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mxf"  "Movira.Video"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mp3"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".wav"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".flac" "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".m4a"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".aac"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".ogg"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".oga"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".opus" "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".wma"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".aiff" "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".mka"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".ac3"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".eac3" "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".dts"  "Movira.Audio"
  WriteRegStr HKCU "Software\Movira\Capabilities\FileAssociations" ".ape"  "Movira.Audio"

  ; Ensure the ProgIds referenced above exist with correct open commands
  ; (electron-builder creates these too; harmless to enforce).
  WriteRegStr HKCU "Software\Classes\Movira.Video\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\Movira.Video\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Movira.Audio\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\Movira.Audio\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"

  ; Register Movira as an application Windows offers in Default apps.
  WriteRegStr HKCU "Software\RegisteredApplications" "Movira" "Software\Movira\Capabilities"

  ; Make sure the shell sees the new registrations immediately.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro MoviraUnregisterApplication
  DeleteRegKey HKCU "Software\RegisteredApplications\Movira"
  DeleteRegKey /ifempty HKCU "Software\Classes\Movira.Video"
  DeleteRegKey /ifempty HKCU "Software\Classes\Movira.Audio"
  DeleteRegKey /ifempty HKCU "Software\Movira"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; electron-builder calls these standard hook macros at the right time.
!macro customInstall
  !insertmacro MoviraRegisterApplication
!macroend

!macro customUnInstall
  !insertmacro MoviraUnregisterApplication
!macroend
