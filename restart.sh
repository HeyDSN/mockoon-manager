#!/bin/bash

# Exit on error
set -e

# Function to check if directory exists
check_directory() {
    if [ ! -d "$1" ]; then
        echo "Error: Directory $1 not found"
        exit 1
    fi
}

# Function to handle errors
handle_error() {
    echo "Error occurred in script at line: ${BASH_LINENO[0]}"
    exit 1
}

# Function to safely stop PM2 process
stop_pm2_process() {
    local process_name=$1
    if pm2 list | grep -q "$process_name"; then
        echo "Stopping $process_name..."
        pm2 stop "$process_name" 2>/dev/null || true
        pm2 delete "$process_name" 2>/dev/null || true
    else
        echo "Process $process_name not running"
    fi
}

# Set error handler
trap 'handle_error' ERR

# Kill existing PM2 daemon and clear dump
echo "📦 Cleaning up existing PM2 processes..."
pm2 kill || true
pm2 cleardump || true

# Start PM2 daemon with nohup
echo "📦 Starting PM2 daemon..."
nohup pm2 daemon > /dev/null 2>&1 & disown

# Wait for PM2 to start
sleep 2

echo "📦 Stopping Mockoon Manager processes..."
stop_pm2_process "fe-mockoon-manager"
stop_pm2_process "be-mockoon-manager"

# Store the root directory
ROOT_DIR=$(pwd)

# Backend deployment
echo "🔄 Deploying backend..."
check_directory "backend"
cd backend
echo "Installing backend dependencies..."
npm install
echo "Starting backend with PM2..."
nohup npm start > /dev/null 2>&1 & disown

# Return to root directory
cd "$ROOT_DIR"

# Frontend deployment
echo "🔄 Deploying frontend..."
check_directory "frontend"
cd frontend
echo "Installing frontend dependencies..."
npm install
echo "Installing serve globally..."
npm install -g serve
echo "Building frontend..."
npm run build
echo "Starting frontend with PM2..."
nohup npm start > /dev/null 2>&1 & disown

# Return to root directory
cd "$ROOT_DIR"

# Wait for processes to start
sleep 3

# Save and setup startup
echo "💾 Setting up PM2 startup..."
nohup pm2 save > /dev/null 2>&1 & disown

if ! systemctl is-enabled pm2-root.service &>/dev/null; then
    nohup pm2 startup systemd -u root --hp /root > /dev/null 2>&1 & disown
    systemctl enable pm2-root
fi

# Display running processes
echo "✨ Deployment complete! Running processes:"
pm2 list

echo "🚀 Application has been restarted successfully!"