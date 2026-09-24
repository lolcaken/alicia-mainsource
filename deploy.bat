@echo off
setlocal EnableDelayedExpansion

if not defined ALICIA_DEPLOY_HOST (
  echo [ERROR] Set ALICIA_DEPLOY_HOST before deploying.
  exit /b 1
)
if not defined ALICIA_DEPLOY_USER (
  echo [ERROR] Set ALICIA_DEPLOY_USER before deploying.
  exit /b 1
)
if not defined ALICIA_DEPLOY_PASSWORD (
  echo [ERROR] Set ALICIA_DEPLOY_PASSWORD before deploying.
  exit /b 1
)
if not defined ALICIA_DEPLOY_PORT set "ALICIA_DEPLOY_PORT=2022"
if not defined ALICIA_DEPLOY_KNOWN_HOSTS set "ALICIA_DEPLOY_KNOWN_HOSTS=%USERPROFILE%\.ssh\known_hosts"
if not exist "%ALICIA_DEPLOY_KNOWN_HOSTS%" (
  echo [ERROR] Known-hosts file not found: %ALICIA_DEPLOY_KNOWN_HOSTS%
  echo [ERROR] Verify the host key manually before deployment.
  exit /b 1
)

for /f "delims=" %%v in ('node -p "require(process.cwd() + '/package.json').version"') do set VER=%%v
set ARCHIVE_DIR=%USERPROFILE%\Downloads\alicia tracker archive
if not exist "%ARCHIVE_DIR%" mkdir "%ARCHIVE_DIR%"
powershell -NoProfile -Command "Compress-Archive -Path bot, services, test, docs, config.js, package.json, README.md, server.js, .gitignore, deploy.bat -DestinationPath '%ARCHIVE_DIR%\alicia-tracker-v%VER%.zip' -Force"
if errorlevel 1 (
  echo [ERROR] Archive creation failed.
  exit /b 1
)
echo [deploy] Archived alicia-tracker-v%VER%.zip

set ASKPASS=%TEMP%\alicia-askpass-%RANDOM%.cmd
> "%ASKPASS%" echo @powershell -NoProfile -Command "[Console]::Out.Write($env:ALICIA_DEPLOY_PASSWORD)"
set "SSH_ASKPASS=%ASKPASS%"
set "SSH_ASKPASS_REQUIRE=force"
set "DISPLAY=localhost:0"

(
  echo put -r bot
  echo put -r services
  echo put -r test
  echo put config.js
  echo put package.json
  echo put server.js
  echo put README.md
  echo put .gitignore
  echo put deploy.bat
  echo bye
) | sftp -oStrictHostKeyChecking=yes -oConnectTimeout=15 -oNumberOfPasswordPrompts=1 -oUserKnownHostsFile="%ALICIA_DEPLOY_KNOWN_HOSTS%" -P %ALICIA_DEPLOY_PORT% "%ALICIA_DEPLOY_USER%@%ALICIA_DEPLOY_HOST%"
set SFTP_RESULT=%ERRORLEVEL%
del "%ASKPASS%" 2>nul
set "ALICIA_DEPLOY_PASSWORD="
if not "%SFTP_RESULT%"=="0" (
  echo [ERROR] SFTP upload failed with exit code %SFTP_RESULT%.
  exit /b %SFTP_RESULT%
)
echo [deploy] Done. Restart the bot in the ACLClouds panel.
endlocal
