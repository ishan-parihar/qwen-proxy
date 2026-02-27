# Qwen Proxy CLI

An OpenAI-compatible proxy server for Qwen OAuth API with CLI management.

## Installation

```bash
# From npm (after publish)
npm install -g @ishan-parihar/qwen-proxy

# Or from source
git clone https://github.com/ishan-parihar/qwen-proxy.git
cd qwen-proxy
npm install
npm run build
npm link
```

## Prerequisites

- Node.js 18+
- qwen-code CLI authenticated (`qwen-code auth login`)

## Usage

```bash
# Start the proxy server
qwen-proxy start

# Start with custom port/host
qwen-proxy start --port 8080 --host 0.0.0.0

# Check server status
qwen-proxy status

# Stop the server
qwen-proxy stop

# Restart the server
qwen-proxy restart

# View logs
qwen-proxy logs

# Configure settings
qwen-proxy config
```

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/models` | List available models |
| GET | `/v1/models/:id` | Get model details |
| POST | `/v1/chat/completions` | Chat completions |
| GET | `/status` | Authentication status |
| GET | `/health` | Health check |

## Available Models

- `qwen3-coder-plus` - Most capable coding model (1M context)
- `qwen3-coder-flash` - Faster coding model
- `coder-model` - Auto-routed coding model
- `vision-model` - Vision-language model

## Integration

### OpenAI SDK (Node.js)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'any',
  baseURL: 'http://127.0.0.1:3000/v1',
});

const response = await client.chat.completions.create({
  model: 'qwen3-coder-plus',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="any",
    base_url="http://127.0.0.1:3000/v1",
)

response = client.chat.completions.create(
    model="qwen3-coder-plus",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### Environment Variables

```bash
export OPENAI_API_KEY=any
export OPENAI_BASE_URL=http://127.0.0.1:3000/v1
```

## Architecture

```
┌──────────────┐     ┌───────────────┐     ┌─────────────────┐
│  Your App    │────▶│  Qwen Proxy   │────▶│  Qwen API       │
│ (OpenAI SDK) │◀────│ (localhost)   │◀────│ (OAuth + Token) │
└──────────────┘     └───────────────┘     └─────────────────┘
                            │
                            ▼
                     ┌───────────────┐
                     │ ~/.qwen/      │
                     │ oauth_creds   │
                     └───────────────┘
```

## License

MIT
