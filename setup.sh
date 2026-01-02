#!/bin/bash

echo "Setting up WebRTC Signaling Server for local network..."
echo ""

if [ ! -f .env ]; then
    echo "Creating .env file from env.example..."
    cp env.example .env
    echo ".env file created!"
else
    echo ".env file already exists, skipping..."
fi

echo ""
echo "Configuration:"
echo "- Server will listen on: 0.0.0.0 (all network interfaces)"
echo "- Accessible at: http://192.168.1.13:3001"
echo "- Also accessible at: http://localhost:3001"
echo ""
echo "To start the server, run: npm run dev"
echo ""






