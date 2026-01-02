@echo off
echo ========================================
echo Adding Firewall Rule for Port 3001
echo ========================================
echo.
echo This script requires Administrator privileges
echo.

netsh advfirewall firewall add rule name="Signaling Server WebRTC" dir=in action=allow protocol=TCP localport=3001
netsh advfirewall firewall add rule name="Signaling Server WebRTC Out" dir=out action=allow protocol=TCP localport=3001

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ Firewall rules added successfully!
    echo.
    echo Port 3001 is now allowed through Windows Firewall
) else (
    echo.
    echo ❌ Failed to add firewall rules
    echo.
    echo Please run this script as Administrator:
    echo Right-click and select "Run as administrator"
)

echo.
pause

