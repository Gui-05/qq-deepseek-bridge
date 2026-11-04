@echo off
rem start-gsv-api.example.cmd - start the GPT-SoVITS HTTP API (127.0.0.1:9880).
rem
rem Copy this next to your GPT-SoVITS install and fix the paths.
rem Why NO_PROXY matters: a system proxy also intercepts 127.0.0.1 and the
rem local call then times out (they are NOT exempt by default).
setlocal

set "GSV_ROOT=D:\gpt-sovits\repo"
set "GSV_PY=D:\gpt-sovits\venv\Scripts\python.exe"

cd /d "%GSV_ROOT%"
set "FTLANG_CACHE=%GSV_ROOT%\GPT_SoVITS\pretrained_models\fast_langdetect"
set "PYTHONIOENCODING=utf-8"
set "NO_PROXY=127.0.0.1,localhost"
set "no_proxy=127.0.0.1,localhost"

"%GSV_PY%" api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
