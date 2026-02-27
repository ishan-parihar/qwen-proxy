/**
 * Qwen OAuth Authentication Module
 * Handles token loading, validation, and refresh
 * Based on qwen-code implementation
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// OAuth Configuration (from qwen-code)
export const OAUTH_CONFIG = {
  deviceCodeEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
  tokenEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/token',
  clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
  scope: 'openid profile email model.completion',
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
};

// API Endpoints
export const API_ENDPOINTS = {
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  dashscopeIntl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  portal: 'https://portal.qwen.ai/v1',
};

// Token refresh buffer (30 seconds before expiry)
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000;

// Credentials file path
export function getCredentialsPath() {
  return join(homedir(), '.qwen', 'oauth_creds.json');
}

// Load credentials from file
export function loadCredentials() {
  const credPath = getCredentialsPath();
  
  if (!existsSync(credPath)) {
    return null;
  }

  try {
    const content = readFileSync(credPath, 'utf-8');
    const data = JSON.parse(content);

    if (!data.access_token) {
      return null;
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      refreshToken: data.refresh_token,
      resourceUrl: data.resource_url,
      expiryDate: data.expiry_date,
      scope: data.scope,
    };
  } catch (error) {
    console.error('Error loading credentials:', error.message);
    return null;
  }
}

// Save credentials to file
export function saveCredentials(credentials) {
  const credPath = getCredentialsPath();
  const dir = join(homedir(), '.qwen');

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const data = {
    access_token: credentials.accessToken,
    token_type: credentials.tokenType || 'Bearer',
    refresh_token: credentials.refreshToken,
    resource_url: credentials.resourceUrl,
    expiry_date: credentials.expiryDate,
    scope: credentials.scope,
  };

  writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Check if token is valid
export function isTokenValid(credentials) {
  if (!credentials?.expiryDate || !credentials?.accessToken) {
    return false;
  }
  return Date.now() < credentials.expiryDate - TOKEN_REFRESH_BUFFER_MS;
}

// Resolve API base URL from resource_url
export function resolveBaseUrl(resourceUrl) {
  if (!resourceUrl) {
    return API_ENDPOINTS.dashscope;
  }

  const normalized = resourceUrl.toLowerCase().trim();

  if (normalized.includes('portal.qwen.ai')) {
    return API_ENDPOINTS.portal;
  }

  if (normalized.includes('dashscope-intl')) {
    return API_ENDPOINTS.dashscopeIntl;
  }

  if (normalized.includes('dashscope')) {
    return API_ENDPOINTS.dashscope;
  }

  // If it's a full URL, use it
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    const url = resourceUrl.endsWith('/v1') ? resourceUrl : `${resourceUrl}/v1`;
    return url;
  }

  // Default to dashscope
  return API_ENDPOINTS.dashscope;
}

// Refresh access token
export async function refreshAccessToken(refreshToken) {
  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CONFIG.clientId,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    tokenType: data.token_type || 'Bearer',
    refreshToken: data.refresh_token || refreshToken,
    resourceUrl: data.resource_url,
    expiryDate: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}

// Get valid credentials (with auto-refresh)
export async function getValidCredentials() {
  let credentials = loadCredentials();

  if (!credentials) {
    throw new Error('No credentials found. Please authenticate first using qwen-code CLI.');
  }

  // Check if token needs refresh
  if (!isTokenValid(credentials)) {
    if (!credentials.refreshToken) {
      throw new Error('Token expired and no refresh token available.');
    }

    console.log('Token expired, refreshing...');
    credentials = await refreshAccessToken(credentials.refreshToken);
    saveCredentials(credentials);
    console.log('Token refreshed successfully.');
  }

  return credentials;
}

// Build headers for API requests
export function buildHeaders(credentials) {
  const resourceUrl = credentials.resourceUrl?.toLowerCase() || '';
  const isDashScope = resourceUrl.includes('dashscope') || !resourceUrl;

  const headers = {
    'Authorization': `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json',
  };

  // Add DashScope-specific headers
  if (isDashScope) {
    headers['X-DashScope-CacheControl'] = 'enable';
    headers['X-DashScope-UserAgent'] = 'qwen-proxy/1.0.0';
    headers['X-DashScope-AuthType'] = 'qwen-oauth';
  }

  return headers;
}
