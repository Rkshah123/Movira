@echo off
REM Build the release APK with the documented init.gradle flag.
REM A batch file is used because the repo path contains a space ("My Application"),
REM which breaks -Dmovira.root=... when passed through a quoted cmd /c command line.
REM
REM --no-configure-on-demand: gradle.properties sets org.gradle.configureondemand=true,
REM which configures only :app and leaves the autolinked library subprojects
REM (react-native-video, track-player, slider, async-storage, react-native-fs)
REM unevaluated. Their android plugins never run, so they publish no variants and
REM :app fails variant matching with "No variants exist". The libraries are
REM discovered by a settings-level command (autolinkLibrariesFromCommand), so
REM Gradle cannot see they are needed until they are configured.
setlocal
cd /d "%~dp0"
call "%~dp0gradlew.bat" --no-configure-on-demand -I "%~dp0init.gradle" "-Dmovira.root=%~dp0.." assembleRelease
endlocal
