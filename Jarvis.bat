@echo off
title Jarvis - keep this window open (close it to stop him)
cd /d C:\dev\jarvis-bricks
echo.
echo   Jarvis's world:  http://localhost:8000/world.html
echo   Status + diary:  http://localhost:8000/
echo.
echo   Keep this window open. Close it to stop Jarvis.
echo.
python tick.py --watch --keep --port 8000 --speed 3
pause
