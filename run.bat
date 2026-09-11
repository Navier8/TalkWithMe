@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "CONTROL_FILE=%ROOT%data\server-control.json"
set "STT_ROOT=%ROOT%..\whisper-fastapi"
set "STT_PYTHON=%STT_ROOT%\.venv\Scripts\python.exe"
set "TTS_ROOT=%ROOT%..\tts-serve"
set "TTS_PYTHON=%ROOT%..\omnivoice\.venv\Scripts\python.exe"
set "HOST=127.0.0.1"
set "PORT=8000"
set "STT_PORT=5000"
set "TTS_PORT=8181"
set "ACTION=%~1"

if "%ACTION%"=="" set "ACTION=start"

if /I "%ACTION%"=="start" goto start
if /I "%ACTION%"=="stop" goto stop
if /I "%ACTION%"=="restart" goto restart
if /I "%ACTION%"=="status" goto status
if /I "%ACTION%"=="help" goto usage

echo Unknown command: %ACTION%
goto usage

:start
if exist "%CONTROL_FILE%" (
    call "%~f0" status >nul 2>&1
    if not errorlevel 1 (
        echo TalkWithMe is already running.
        exit /b 1
    )
    del /q "%CONTROL_FILE%" >nul 2>&1
)

if not exist "%ROOT%data" mkdir "%ROOT%data" >nul 2>&1

echo Starting TalkWithMe on http://%HOST%:%PORT%
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = '%ROOT%'; " ^
    "$sttRoot = '%STT_ROOT%'; " ^
    "$sttPython = '%STT_PYTHON%'; " ^
    "$ttsRoot = '%TTS_ROOT%'; " ^
    "$ttsPython = '%TTS_PYTHON%'; " ^
    "$control = '%CONTROL_FILE%'; " ^
    "if (!(Test-Path -LiteralPath $sttPython)) { Write-Error ('Whisper-FastAPI Python not found: {0}' -f $sttPython); exit 1 }; " ^
    "if (!(Test-Path -LiteralPath $ttsPython)) { Write-Error ('OmniVoice Python not found: {0}' -f $ttsPython); exit 1 }; " ^
    "if (!(Test-Path -LiteralPath (Join-Path $ttsRoot 'impl\server_omnivoice.py'))) { Write-Error ('tts-serve OmniVoice wrapper not found: {0}' -f $ttsRoot); exit 1 }; " ^
    "$nv = Join-Path $sttRoot '.venv\Lib\site-packages\nvidia'; " ^
    "$cudaBin = @((Join-Path $nv 'cublas\bin'), (Join-Path $nv 'cudnn\bin'), (Join-Path $nv 'cuda_nvrtc\bin')); " ^
    "$missing = @(); foreach ($p in $cudaBin) { if (!(Test-Path -LiteralPath $p)) { $missing += $p } }; " ^
    "if ($missing.Count -gt 0) { Write-Warning ('CUDA runtime libraries not found, STT will fail on the GPU: {0} -- reinstall them into the whisper venv with: pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 (cuDNN major version 9)' -f ($missing -join ', ')) }; " ^
    "$savedPath = $env:PATH; $env:PATH = ($cudaBin -join ';') + ';' + $env:PATH; " ^
    "$stt = Start-Process -FilePath $sttPython -WorkingDirectory $sttRoot -ArgumentList @('-W','ignore::UserWarning','whisper_fastapi.py','--host','%HOST%','--port','%STT_PORT%','--model','large-v3-turbo','--device','cuda','--compute_type','float16') -PassThru -WindowStyle Normal; " ^
    "$env:PATH = $savedPath; " ^
    "$tts = Start-Process -FilePath $ttsPython -WorkingDirectory $ttsRoot -ArgumentList @('-m','uvicorn','impl.server_omnivoice:app','--host','%HOST%','--port','%TTS_PORT%') -PassThru -WindowStyle Normal; " ^
    "$proc = Start-Process -FilePath 'python' -WorkingDirectory $root -ArgumentList @('-m','uvicorn','app.main:app','--host','%HOST%','--port','%PORT%','--reload') -PassThru -WindowStyle Normal; " ^
    "@{ pid = $proc.Id; stt_pid = $stt.Id; tts_pid = $tts.Id; host = '%HOST%'; port = %PORT%; stt_port = %STT_PORT%; tts_port = %TTS_PORT% } | ConvertTo-Json | Set-Content -LiteralPath $control -Encoding utf8"
if errorlevel 1 (
    echo Failed to start TalkWithMe.
    exit /b 1
)
exit /b 0

:stop
if not exist "%CONTROL_FILE%" (
    echo TalkWithMe is not running or no control file exists.
    exit /b 2
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$control = '%CONTROL_FILE%'; " ^
    "$info = Get-Content -Raw $control | ConvertFrom-Json; " ^
    "$proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue; " ^
    "$stt = Get-Process -Id $info.stt_pid -ErrorAction SilentlyContinue; " ^
    "$tts = Get-Process -Id $info.tts_pid -ErrorAction SilentlyContinue; " ^
    "if ($null -eq $proc -and $null -eq $stt -and $null -eq $tts) { Write-Host ('Stale control file for PIDs {0}, {1}, and {2}; removing it.' -f $info.pid, $info.stt_pid, $info.tts_pid); Remove-Item -LiteralPath $control -Force -ErrorAction SilentlyContinue; exit 2 }; " ^
    "if ($null -ne $proc) { Write-Host ('Stopping TalkWithMe PID {0}...' -f $info.pid); taskkill /PID $info.pid /T /F | Out-Null }; " ^
    "if ($null -ne $stt) { Write-Host ('Stopping Whisper-FastAPI PID {0}...' -f $info.stt_pid); taskkill /PID $info.stt_pid /T /F | Out-Null }; " ^
    "if ($null -ne $tts) { Write-Host ('Stopping OmniVoice PID {0}...' -f $info.tts_pid); taskkill /PID $info.tts_pid /T /F | Out-Null }; " ^
    "Remove-Item -LiteralPath $control -Force -ErrorAction SilentlyContinue; " ^
    "Write-Host 'TalkWithMe stopped.'"
exit /b %ERRORLEVEL%

:restart
call "%~f0" stop
rem 2 = nothing was running; that is no reason to skip the start.
if "%ERRORLEVEL%"=="2" goto start
if errorlevel 1 exit /b %ERRORLEVEL%
goto start

:status
if not exist "%CONTROL_FILE%" (
    echo TalkWithMe is not running.
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$control = '%CONTROL_FILE%'; " ^
    "$info = Get-Content -Raw $control | ConvertFrom-Json; " ^
    "$proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue; " ^
    "$stt = Get-Process -Id $info.stt_pid -ErrorAction SilentlyContinue; " ^
    "$tts = Get-Process -Id $info.tts_pid -ErrorAction SilentlyContinue; " ^
    "if ($null -eq $proc -or $null -eq $stt -or $null -eq $tts) { Write-Host ('Stale or incomplete control file found for PIDs {0}, {1}, and {2}.' -f $info.pid, $info.stt_pid, $info.tts_pid); exit 1 }; " ^
    "Write-Host ('TalkWithMe is running at http://{0}:{1} (PID {2}); Whisper-FastAPI is running at http://{0}:{3} (PID {4}); OmniVoice is running at http://{0}:{5} (PID {6}).' -f $info.host, $info.port, $info.pid, $info.stt_port, $info.stt_pid, $info.tts_port, $info.tts_pid)"
exit /b %ERRORLEVEL%

:usage
echo Usage: run.bat [start^|stop^|restart^|status^|help]
echo.
echo stop exit codes: 0 = stopped, 1 = stop failed, 2 = nothing was running.
exit /b 1
