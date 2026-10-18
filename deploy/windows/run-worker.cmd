@echo off
rem ---------------------------------------------------------------------------
rem Boot-time launcher for the agentmesh Worker Daemon on Windows.
rem
rem Register it once (as Administrator):
rem
rem   setx /M AGENTMESH_DAEMON_TOKEN "<openssl rand -hex 32>"
rem   schtasks /create /tn "agentmesh worker" /tr "C:\agentmesh\deploy\windows\run-worker.cmd" ^
rem            /sc onstart /ru SYSTEM /rl HIGHEST /f
rem
rem Then: schtasks /run /tn "agentmesh worker"   (or reboot)
rem
rem Why a wrapper: > net start <service> needs a real Windows service binary,
rem and node.exe is not one. Task Scheduler runs at boot without extra software,
rem which is enough for a single worker host. If you already run NSSM or WinSW,
rem use it instead — it gives you log rotation, which this redirect does not.
rem
rem Security: the token is a MACHINE environment variable (setx /M), not a line
rem in this file. Keep this file and agentmesh.yaml free of secrets, and give
rem the task a dedicated service account rather than SYSTEM where possible.
rem ---------------------------------------------------------------------------
setlocal

set "AGENTMESH_HOME=C:\agentmesh"
cd /d "%AGENTMESH_HOME%" || exit /b 1

if not defined AGENTMESH_DAEMON_TOKEN (
  echo [agentmesh] AGENTMESH_DAEMON_TOKEN is not set; refusing to start >&2
  exit /b 1
)

rem stdout is not captured by Task Scheduler, so keep a file. It is NOT rotated
rem here: the audit trail (daemon.auditPath) is the rotated, security-relevant
rem log; this file only holds startup errors.
node "%AGENTMESH_HOME%\dist\cli.js" daemon --config "%AGENTMESH_HOME%\agentmesh.yaml" >> "%AGENTMESH_HOME%\daemon.out.log" 2>&1
exit /b %ERRORLEVEL%
