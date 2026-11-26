@echo off
title Derek - keep this window open (close it to stop him)
cd /d C:\dev\jarvis-bricks
echo.
echo   Derek's world:  http://localhost:8000/world.html
echo   Status + diary:  http://localhost:8000/
echo.
echo   Keep this window open. Close it to stop Derek.
echo.
python tick.py --watch --keep --port 8000 --speed 3
pause
