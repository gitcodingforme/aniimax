@REM Starts the Aniimo game watcher from the aniimax folder. It only looks at the game window and never sends input to the game. Extra words are passed on, for example: start_watcher.cmd --once
@echo off
cd /d "%~dp0.."
python scripts\watch_game.py --exe Aniimo.exe %*
pause
