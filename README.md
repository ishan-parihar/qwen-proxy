# Qwen Proxy Server

An OpenAI-compatible proxy server that forwards requests to Qwen API using OAuth authentication from qwen-code credentials.

## Features

- **OpenAI-compatible API** - Works with any OpenAI SDK
- **OAuth Authentication** - Uses qwen-code credentials (`~/.qwen/oauth_creds.json`)
- **Auto Token Refresh** - Automatically refreshes expired tokens
- **Multi-endpoint Support** - Routes to portal.qwen.ai or DashScope based on your token
- **Streaming Support** - Full support for streaming responses
- **CORS Enabled** - Works with browser-based applications

## Prerequisites

- Node.js 18+ (with native fetch support)
- qwen-code CLI authenticated (`qwen-code auth login`)

## Installation

```bash
cd ~/projects/qwen-proxy
npm install
```

## Usage

### Start the server

```bash
npm start
# or with custom port
PORT=8080 npm start
# or with debug logging
DEBUG=1 npm start
```

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/models` | List available models |
| GET | `/v1/models/:id` | Get model details |
| POST | `/v1/chat/completions` | Chat completions (OpenAI-compatible) |
| GET | `/status` | Authentication status |
| GET | `/health` | Health check |

### Available Models

- `qwen3-coder-plus` - Most capable coding model (1M context)
- `qwen3-coder-flash` - Faster coding model
- `coder-model` - Auto-routed coding model
- `vision-model` - Vision-language model

## Integration Examples

### OpenAI SDK (Node.js)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'any',  // API key is ignored, OAuth is used
  baseURL: 'http://localhost:3000/v1',
});

const response = await client.chat.completions.create({
  model: 'qwen3-coder-plus',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
```

### Python (openai)

```python
from openai import OpenAI

client = OpenAI(
    api_key="any",  # API key is ignored
    base_url="http://localhost:3000/v1",
)

response = client.chat.completions.create(
    model="qwen3-coder-plus",
    messages=[{"role": "user", "content": "Hello!"}],
)

print(response.choices[0].message.content)
```

### cURL

```bash
# List models
curl http://localhost:3000/v1/models

# Chat completion
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-plus",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-plus",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Environment Variables

```bash
OPENAI_API_KEY=any
OPENAI_BASE_URL=http://localhost:3000/v1
```

## Authentication

The proxy reads credentials from `~/.qwen/oauth_creds.json`, which is created by the qwen-code CLI when you authenticate:

```bash
# Authenticate with qwen-code
qwen-code auth login
```

Check authentication status:

```bash
curl http://localhost:3000/status
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
