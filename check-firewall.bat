@echo off
echo ========================================
echo Firewall and Network Check
echo ========================================
echo.

echo Checking if port 3001 is listening...
netstat -an | findstr ":3001"
echo.

echo Checking Windows Firewall rules for port 3001...
netsh advfirewall firewall show rule name=all | findstr "3001"
echo.

echo.
echo ========================================
echo To allow port 3001 through firewall:
echo ========================================
echo Run this command as Administrator:
echo.
echo netsh advfirewall firewall add rule name="Signaling Server" dir=in action=allow protocol=TCP localport=3001
echo.
echo ========================================
echo Testing server connection...
echo ========================================
echo.

curl http://localhost:3001/test
if %ERRORLEVEL% EQU 0 (
    echo.
    echo Server is accessible locally!
) else (
    echo.
    echo Server might not be running or not accessible
)

echo.
pause

