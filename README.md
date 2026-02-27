# Qwen Proxy

A CLI tool that provides an OpenAI-compatible API proxy for Qwen OAuth accounts with multi-account support and load balancing.

## Features

- **OpenAI-Compatible API**: Use any OpenAI SDK with Qwen models
- **Multi-Account Support**: Manage multiple Qwen accounts
- **Load Balancing**: Round-robin routing across accounts
- **Auto Token Refresh**: Automatic token refresh before expiry
- **CLI Management**: Easy start/stop/status commands
- **Systemd Integration**: Run as a background service

## Installation

### From npm (when published)

```bash
npm install -g @ishan-parihar/qwen-proxy
# or
bun install -g @ishan-parihar/qwen-proxy
```

### From GitHub

```bash
# Clone and link
git clone https://github.com/ishan-parihar/qwen-proxy.git
cd qwen-proxy
bun install
bun link

# Or install directly from GitHub
bun install -g ishan-parihar/qwen-proxy
```

## Quick Start

### 1. Add Account

First, authenticate with qwen-code, then import credentials:

```bash
# Authenticate with Qwen (if not already done)
qwen-code auth login

# Import credentials to qwen-proxy
qwen-proxy account import --name default
```

### 2. Start Server

```bash
qwen-proxy start
```

### 3. Use the API

```bash
# List models
curl http://127.0.0.1:3000/v1/models

# Chat completion
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## CLI Commands

### Server Management

```bash
qwen-proxy start              # Start the proxy server
qwen-proxy start --port 8080  # Start on custom port
qwen-proxy stop               # Stop the server
qwen-proxy restart            # Restart the server
qwen-proxy status             # Show server status
qwen-proxy logs               # View server logs
qwen-proxy config             # Show configuration
```

### Account Management

```bash
qwen-proxy account list                    # List all accounts
qwen-proxy account import --name <name>    # Import from qwen-code
qwen-proxy account default <id-or-name>    # Set default account
qwen-proxy account enable <id-or-name>     # Enable an account
qwen-proxy account disable <id-or-name>    # Disable an account
qwen-proxy account remove <id-or-name>     # Remove an account
```

## Configuration

Configuration is stored in `~/.qwen-proxy/`:

- `config.json` - Server configuration (port, host, routing strategy)
- `accounts.json` - Account credentials (encrypted)
- `server.log` - Server output log
- `error.log` - Error log

### Routing Strategies

Set via environment variable `ROUTING_STRATEGY`:

- `default` - Use the default account (default)
- `round-robin` - Rotate through all active accounts

```bash
ROUTING_STRATEGY=round-robin qwen-proxy start
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | List available models |
| `/v1/models/:id` | GET | Get model details |
| `/v1/chat/completions` | POST | Chat completion (OpenAI-compatible) |
| `/status` | GET | Server and account status |
| `/accounts` | GET | List all configured accounts |
| `/health` | GET | Health check |

## Available Models

- `qwen3-coder-plus` - Qwen3 Coder Plus
- `qwen3-coder-flash` - Qwen3 Coder Flash
- `coder-model` - Coder model (alias)
- `vision-model` - Vision model

## Usage with OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="any",  # Any non-empty string works
    base_url="http://127.0.0.1:3000/v1"
)

response = client.chat.completions.create(
    model="qwen3-coder-flash",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

## Systemd Service

Run as a systemd user service for automatic startup:

```bash
./setup-systemd.sh --setup
./setup-systemd.sh --start
```

Or manually:

```bash
# Create service file
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/qwen-proxy.service << 'SERVICE'
[Unit]
Description=Qwen Proxy Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/.bun/install/global/node_modules/@ishan-parihar/qwen-proxy/dist/server.mjs
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=HOST=127.0.0.1

[Install]
WantedBy=default.target
SERVICE

# Enable and start
systemctl --user daemon-reload
systemctl --user enable qwen-proxy
systemctl --user start qwen-proxy
```

## How It Works

1. **Authentication**: Uses OAuth 2.0 Device Flow with PKCE
2. **Token Management**: Automatically refreshes tokens before expiry
3. **API Proxy**: Forwards OpenAI-format requests to Qwen API
4. **Load Balancing**: Distributes requests across multiple accounts

## Development

```bash
# Install dependencies
bun install

# Build
npm run build

# Development mode with auto-reload
npm run dev
```

## License

MIT

## Related Projects

- [qwen-code](https://github.com/qwenlm/qwen-code) - Official Qwen CLI
- [claude-code-router](https://github.com/ishan-parihar/claude-code-router) - Similar proxy for Claude
