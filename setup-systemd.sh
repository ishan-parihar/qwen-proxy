#!/bin/bash
# Qwen Proxy Systemd Service Setup Script
# This script helps set up and manage the qwen-proxy systemd user service

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SERVICE_NAME="qwen-proxy"
SERVICE_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"
PROXY_DIR="$HOME/.qwen-proxy"

# Find node path
if command -v node &> /dev/null; then
    NODE_PATH=$(which node)
elif [ -f "/home/linuxbrew/.linuxbrew/bin/node" ]; then
    NODE_PATH="/home/linuxbrew/.linuxbrew/bin/node"
elif [ -f "/usr/bin/node" ]; then
    NODE_PATH="/usr/bin/node"
else
    NODE_PATH="node"
fi

# Functions
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_dependencies() {
    print_info "Checking dependencies..."

    # Check if systemd is available
    if ! command -v systemctl &> /dev/null; then
        print_error "systemctl not found. This script requires systemd."
        exit 1
    fi

    # Check if node is available
    if ! command -v node &> /dev/null; then
        print_error "Node.js not found"
        exit 1
    fi

    # Check if qwen-proxy is available
    if ! command -v qwen-proxy &> /dev/null; then
        print_warning "qwen-proxy not in PATH. Checking local installation..."
        
        # Check common install locations
        local found=false
        for dir in "$HOME/.bun/bin" "$HOME/.npm-global/bin" "$HOME/.local/bin" "$HOME/node_modules/.bin"; do
            if [ -f "$dir/qwen-proxy" ]; then
                QWEN_PROXY_BIN="$dir/qwen-proxy"
                found=true
                print_info "Found qwen-proxy at $QWEN_PROXY_BIN"
                break
            fi
        done
        
        if [ "$found" = false ]; then
            print_error "qwen-proxy not found. Please install it first:"
            print_info "  npm install -g @ishan-parihar/qwen-proxy"
            print_info "  or"
            print_info "  bun link (from project directory)"
            exit 1
        fi
    else
        QWEN_PROXY_BIN=$(which qwen-proxy)
    fi

    print_success "All dependencies checked"
}

create_service_file() {
    print_info "Creating systemd service file..."

    mkdir -p "$HOME/.config/systemd/user"
    mkdir -p "$PROXY_DIR"

    cat > "$SERVICE_FILE" << EOFSERVICE
[Unit]
Description=Qwen Proxy Server - OpenAI-compatible API proxy for Qwen OAuth
Documentation=https://github.com/ishan-parihar/qwen-proxy
After=network.target

[Service]
Type=forking
PIDFile=$PROXY_DIR/server.pid
ExecStart=$NODE_PATH $QWEN_PROXY_BIN start
ExecStop=$QWEN_PROXY_BIN stop
ExecReload=$QWEN_PROXY_BIN restart
Restart=always
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Environment
Environment=NODE_ENV=production

# Resource limits
LimitNOFILE=65536
MemoryMax=512M

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=qwen-proxy

[Install]
WantedBy=default.target
EOFSERVICE

    print_success "Service file created at $SERVICE_FILE"
}

reload_systemd() {
    print_info "Reloading systemd daemon..."
    systemctl --user daemon-reload
    print_success "Systemd daemon reloaded"
}

enable_service() {
    print_info "Enabling $SERVICE_NAME service..."
    systemctl --user enable "$SERVICE_NAME"
    print_success "Service enabled (will start on login)"
}

start_service() {
    print_info "Starting $SERVICE_NAME service..."
    systemctl --user reset-failed "$SERVICE_NAME" 2>/dev/null || true
    systemctl --user start "$SERVICE_NAME"
    print_success "Service started"
}

show_status() {
    print_info "Service status:"
    systemctl --user status "$SERVICE_NAME" --no-pager || true
    echo ""
    print_info "Proxy status:"
    qwen-proxy status 2>/dev/null || true
}

show_logs() {
    print_info "Recent logs (last 20 lines):"
    journalctl --user -u "$SERVICE_NAME" -n 20 --no-pager || true
}

test_api() {
    print_info "Testing API endpoint..."
    
    local port=$(cat "$PROXY_DIR/config.json" 2>/dev/null | grep -o '"port":[[:space:]]*[0-9]*' | grep -o '[0-9]*' || echo "3000")
    
    print_info "Testing http://127.0.0.1:$port/v1/models ..."
    
    local response=$(curl -s http://127.0.0.1:$port/v1/models 2>/dev/null)
    
    if echo "$response" | grep -q '"object"'; then
        print_success "API is responding!"
        echo "$response" | head -c 200
        echo ""
    else
        print_error "API not responding"
        print_info "Response: $response"
    fi
}

test_auto_restart() {
    print_info "Testing auto-restart functionality..."
    print_warning "This will kill the qwen-proxy process to test if systemd restarts it"

    read -p "Continue? (y/N): " -n 1 -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        local pid_file="$PROXY_DIR/server.pid"

        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            print_info "Killing process $pid..."
            kill "$pid" 2>/dev/null || true

            print_info "Waiting 5 seconds for systemd to restart..."
            sleep 5

            if systemctl --user is-active "$SERVICE_NAME" &> /dev/null; then
                print_success "✓ Service was automatically restarted by systemd!"
                show_status
            else
                print_error "✗ Service did not restart automatically"
                show_status
            fi
        else
            print_error "PID file not found. Service may not be running."
        fi
    else
        print_info "Auto-restart test skipped"
    fi
}

show_menu() {
    echo ""
    echo "Qwen Proxy Systemd Service Management"
    echo "======================================"
    echo ""
    echo "1) Setup and enable service"
    echo "2) Start service"
    echo "3) Stop service"
    echo "4) Restart service"
    echo "5) Show status"
    echo "6) Show logs"
    echo "7) Show logs (follow mode)"
    echo "8) Test API endpoint"
    echo "9) Test auto-restart"
    echo "10) Enable service for autostart"
    echo "11) Disable service autostart"
    echo "0) Exit"
    echo ""
    read -p "Select an option: " choice

    case $choice in
        1)
            check_dependencies
            create_service_file
            reload_systemd
            enable_service
            start_service
            show_status
            ;;
        2)
            systemctl --user start "$SERVICE_NAME"
            print_success "Service started"
            show_status
            ;;
        3)
            systemctl --user stop "$SERVICE_NAME"
            print_success "Service stopped"
            ;;
        4)
            systemctl --user restart "$SERVICE_NAME"
            print_success "Service restarted"
            show_status
            ;;
        5)
            show_status
            ;;
        6)
            show_logs
            ;;
        7)
            print_info "Following logs (Ctrl+C to exit)..."
            journalctl --user -u "$SERVICE_NAME" -f
            ;;
        8)
            test_api
            ;;
        9)
            test_auto_restart
            ;;
        10)
            systemctl --user enable "$SERVICE_NAME"
            print_success "Service enabled for autostart"
            ;;
        11)
            systemctl --user disable "$SERVICE_NAME"
            print_success "Service autostart disabled"
            ;;
        0)
            print_info "Exiting..."
            exit 0
            ;;
        *)
            print_error "Invalid option"
            ;;
    esac
}

# Main script
if [ "$1" == "--setup" ]; then
    check_dependencies
    create_service_file
    reload_systemd
    enable_service
    start_service
    show_status
    echo ""
    print_success "Setup complete! Service is now running and will start automatically on login."
    print_info "To manage the service, run: $0"
elif [ "$1" == "--status" ]; then
    show_status
elif [ "$1" == "--logs" ]; then
    if [ "$2" == "--follow" ]; then
        journalctl --user -u "$SERVICE_NAME" -f
    else
        show_logs
    fi
elif [ "$1" == "--start" ]; then
    systemctl --user start "$SERVICE_NAME"
    print_success "Service started"
elif [ "$1" == "--stop" ]; then
    systemctl --user stop "$SERVICE_NAME"
    print_success "Service stopped"
elif [ "$1" == "--restart" ]; then
    systemctl --user restart "$SERVICE_NAME"
    print_success "Service restarted"
elif [ "$1" == "--enable" ]; then
    systemctl --user enable "$SERVICE_NAME"
    print_success "Service enabled for autostart"
elif [ "$1" == "--disable" ]; then
    systemctl --user disable "$SERVICE_NAME"
    print_success "Service autostart disabled"
elif [ "$1" == "--test-api" ]; then
    test_api
elif [ "$1" == "--test-restart" ]; then
    test_auto_restart
else
    while true; do
        show_menu
    done
fi
