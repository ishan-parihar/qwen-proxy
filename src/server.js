#!/usr/bin/env node
/**
 * Qwen Proxy Server
 * 
 * An OpenAI-compatible proxy server that forwards requests to Qwen API
 * using OAuth authentication with multi-account support.
 * 
 * Usage:
 *   node server.js [--port 3000]
 * 
 * Environment variables:
 *   PORT - Server port (default: 3000)
 *   HOST - Server host (default: localhost)
 *   ROUTING_STRATEGY - 'default' or 'round-robin' (default: default)
 */

import http from 'node:http';
import { URL } from 'node:url';

import {
  loadAccounts,
  getAccountForRequest,
  getValidCredentials,
  resolveBaseUrl,
  buildHeaders,
  updateAccountStats,
  isTokenValid,
  getDefaultAccount,
} from './accounts/manager.js';

// Configuration
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const ROUTING_STRATEGY = process.env.ROUTING_STRATEGY || 'default';

// Debug logging
const DEBUG = process.env.DEBUG === '1';

function log(...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}]`, ...args);
}

function debug(...args) {
  if (DEBUG) {
    log('[DEBUG]', ...args);
  }
}

// Available Qwen models
const QWEN_MODELS = {
  'qwen3-coder-plus': {
    id: 'qwen3-coder-plus',
    object: 'model',
    created: Date.now(),
    owned_by: 'qwen',
    permission: [],
    root: 'qwen3-coder-plus',
  },
  'qwen3-coder-flash': {
    id: 'qwen3-coder-flash',
    object: 'model',
    created: Date.now(),
    owned_by: 'qwen',
    permission: [],
    root: 'qwen3-coder-flash',
  },
  'coder-model': {
    id: 'coder-model',
    object: 'model',
    created: Date.now(),
    owned_by: 'qwen',
    permission: [],
    root: 'coder-model',
  },
  'vision-model': {
    id: 'vision-model',
    object: 'model',
    created: Date.now(),
    owned_by: 'qwen',
    permission: [],
    root: 'vision-model',
  },
};

// Streaming helper
async function* streamIterator(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

// Handle /v1/models endpoint
async function handleModels(res) {
  const models = Object.values(QWEN_MODELS);
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    object: 'list',
    data: models,
  }));
}

// Handle /v1/chat/completions endpoint
async function handleChatCompletions(req, res) {
  let body = '';
  
  for await (const chunk of req) {
    body += chunk;
  }

  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  debug('Request body:', JSON.stringify(requestBody, null, 2));

  // Get account for this request
  const account = getAccountForRequest(ROUTING_STRATEGY);

  if (!account) {
    log('No available account');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No accounts configured. Use "qwen-proxy account add" to add an account.' }));
    return;
  }

  // Get valid credentials
  let credentials;
  try {
    credentials = await getValidCredentials(account.id);
  } catch (e) {
    log('Auth error for account', account.name, ':', e.message);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }

  // Resolve API endpoint
  const baseUrl = resolveBaseUrl(credentials.resourceUrl);
  const endpoint = `${baseUrl}/chat/completions`;
  
  debug('Using account:', account.name, '->', endpoint);

  // Build headers
  const headers = buildHeaders(credentials);

  // Check if streaming
  const isStreaming = requestBody.stream === true;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    debug('Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      log('API error:', response.status, errorText);
      
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(errorText);
      return;
    }

    // Update account stats
    updateAccountStats(account.id);

    if (isStreaming) {
      // Stream response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      for await (const chunk of streamIterator(response)) {
        res.write(chunk);
      }

      res.end();
    } else {
      // Non-streaming response
      const responseText = await response.text();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(responseText);
    }
  } catch (e) {
    log('Request error:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy error: ${e.message}` }));
  }
}

// Handle /v1/models/:id endpoint
async function handleModel(req, res, modelId) {
  const model = QWEN_MODELS[modelId];
  
  if (!model) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Model not found' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(model));
}

// Status endpoint
async function handleStatus(res) {
  const accountsData = loadAccounts();
  const accounts = Object.values(accountsData.accounts || {}).map(account => ({
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    isValid: isTokenValid(account.credentials),
    resourceUrl: account.credentials.resourceUrl,
    expiryDate: account.credentials.expiryDate,
    isDefault: account.id === accountsData.defaultAccountId,
  }));

  const status = {
    status: 'ok',
    routingStrategy: ROUTING_STRATEGY,
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter(a => a.enabled && a.isValid).length,
    accounts,
    defaultAccountId: accountsData.defaultAccountId,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status, null, 2));
}

// Accounts API endpoint
async function handleAccounts(req, res, method) {
  const accountsData = loadAccounts();
  
  if (method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(accountsData, null, 2));
  } else {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
}

// Main request handler
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  log(`${req.method} ${path}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Route requests
    if (path === '/v1/models' && req.method === 'GET') {
      await handleModels(res);
    } else if (path.match(/^\/v1\/models\/[^/]+$/) && req.method === 'GET') {
      const modelId = path.split('/').pop();
      await handleModel(req, res, modelId);
    } else if (path === '/v1/chat/completions' && req.method === 'POST') {
      await handleChatCompletions(req, res);
    } else if (path === '/status' && req.method === 'GET') {
      await handleStatus(res);
    } else if (path === '/accounts' && req.method === 'GET') {
      await handleAccounts(req, res, req.method);
    } else if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (e) {
    log('Unhandled error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

// Create and start server
const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  log(`Qwen Proxy Server running at http://${HOST}:${PORT}`);
  log(`Routing strategy: ${ROUTING_STRATEGY}`);
  log('');
  
  const accountsData = loadAccounts();
  const accountCount = Object.keys(accountsData.accounts || {}).length;
  
  log(`Loaded ${accountCount} account(s)`);
  
  if (accountCount === 0) {
    log('WARNING: No accounts configured!');
    log('Run "qwen-proxy account add" to add an account.');
  }
  
  log('');
  log('Endpoints:');
  log(`  GET  http://${HOST}:${PORT}/v1/models`);
  log(`  GET  http://${HOST}:${PORT}/v1/models/:id`);
  log(`  POST http://${HOST}:${PORT}/v1/chat/completions`);
  log(`  GET  http://${HOST}:${PORT}/status`);
  log(`  GET  http://${HOST}:${PORT}/accounts`);
  log(`  GET  http://${HOST}:${PORT}/health`);
  log('');
  log('Usage with OpenAI SDK:');
  log(`  OPENAI_API_KEY=any OPENAI_BASE_URL=http://${HOST}:${PORT}/v1`);
  log('');
  log('Usage with curl:');
  log(`  curl http://${HOST}:${PORT}/v1/models`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});
