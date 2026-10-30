@echo off
rem Opens VS Code with the DataFlow extension of this folder. The title of the window starts with
rem "[Extension Development Host]". The script compiles the extension first. If the window is open, VS Code loads
rem it again with the new code.
rem
rem Usage: open-editor.bat [folder or file] [other arguments of VS Code]
rem With no folder, VS Code opens the last folder of the window.
rem If VS Code runs as administrator, also run this script as administrator.
setlocal
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

rem VS Code: the command code of the PATH, else a user installation, else a system installation
set "CODE="
for /f "delims=" %%c in ('where code.cmd 2^>nul') do if not defined CODE set "CODE=%%c"
if not defined CODE if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" set "CODE=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
if not defined CODE if exist "%ProgramFiles%\Microsoft VS Code\bin\code.cmd" set "CODE=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
if not defined CODE (
	echo VS Code is not in the PATH and not in its usual folders. Add the folder bin of VS Code to the PATH.
	pause
	exit /b 1
)

echo Compiling the extension...
pushd "%ROOT%"
call npm run compile
if errorlevel 1 (
	popd
	echo The compilation failed. Read the errors above.
	pause
	exit /b 1
)
popd

if not exist "%ROOT%\engine\bin\dataflow-engine.exe" if not exist "%ROOT%\build\engine\dataflow-engine.exe" (
	echo There is no engine in build\engine. DataFlow cannot parse C++ code until you build the engine.
	echo Read engine\README.md, or set dataflow.engine.path in VS Code.
	pause
)

call "%CODE%" --new-window --extensionDevelopmentPath="%ROOT%" %*
endlocal
