/**
 * Multi-Account Manager for Qwen Proxy
 * 
 * Manages multiple Qwen OAuth accounts with load balancing and failover.
 * Credentials stored in ~/.qwen-proxy/accounts.json
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Paths
const QWEN_PROXY_DIR = join(homedir(), '.qwen-proxy');
const ACCOUNTS_FILE = join(QWEN_PROXY_DIR, 'accounts.json');
const CONFIG_FILE = join(QWEN_PROXY_DIR, 'config.json');
const QWEN_CREDS_FILE = join(homedir(), '.qwen', 'oauth_creds.json');

// Token refresh buffer (30 seconds before expiry)
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000;

// OAuth Configuration
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

/**
 * Ensure the proxy directory exists
 */
function ensureDir() {
  if (!existsSync(QWEN_PROXY_DIR)) {
    mkdirSync(QWEN_PROXY_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load all accounts from file
 */
export function loadAccounts() {
  ensureDir();
  
  if (!existsSync(ACCOUNTS_FILE)) {
    // Try to migrate from existing qwen-code credentials
    const migrated = migrateFromQwenCode();
    if (migrated) {
      return loadAccounts();
    }
    return { accounts: {}, defaultAccountId: null };
  }

  try {
    const content = readFileSync(ACCOUNTS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading accounts:', error.message);
    return { accounts: {}, defaultAccountId: null };
  }
}

/**
 * Save accounts to file
 */
export function saveAccounts(data) {
  ensureDir();
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Migrate credentials from qwen-code CLI
 */
function migrateFromQwenCode() {
  if (!existsSync(QWEN_CREDS_FILE)) {
    return false;
  }

  try {
    const content = readFileSync(QWEN_CREDS_FILE, 'utf-8');
    const creds = JSON.parse(content);

    if (!creds.access_token) {
      return false;
    }

    const accountId = randomUUID();
    const accounts = {
      accounts: {
        [accountId]: {
          id: accountId,
          name: 'default',
          credentials: {
            accessToken: creds.access_token,
            tokenType: creds.token_type || 'Bearer',
            refreshToken: creds.refresh_token,
            resourceUrl: creds.resource_url,
            expiryDate: creds.expiry_date,
            scope: creds.scope,
          },
          createdAt: Date.now(),
          lastUsed: null,
          requestCount: 0,
          enabled: true,
        },
      },
      defaultAccountId: accountId,
    };

    saveAccounts(accounts);
    console.log('Migrated credentials from qwen-code CLI');
    return true;
  } catch (error) {
    console.error('Migration error:', error.message);
    return false;
  }
}

/**
 * Add a new account
 */
export function addAccount(name, credentials) {
  const data = loadAccounts();
  
  const accountId = randomUUID();
  
  data.accounts[accountId] = {
    id: accountId,
    name: name || `account-${Object.keys(data.accounts).length + 1}`,
    credentials: {
      accessToken: credentials.accessToken,
      tokenType: credentials.tokenType || 'Bearer',
      refreshToken: credentials.refreshToken,
      resourceUrl: credentials.resourceUrl,
      expiryDate: credentials.expiryDate,
      scope: credentials.scope,
    },
    createdAt: Date.now(),
    lastUsed: null,
    requestCount: 0,
    enabled: true,
  };

  // Set as default if first account
  if (!data.defaultAccountId) {
    data.defaultAccountId = accountId;
  }

  saveAccounts(data);
  return accountId;
}

/**
 * Remove an account
 */
export function removeAccount(accountId) {
  const data = loadAccounts();
  
  if (!data.accounts[accountId]) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const name = data.accounts[accountId].name;
  delete data.accounts[accountId];

  // Update default if needed
  if (data.defaultAccountId === accountId) {
    const remaining = Object.keys(data.accounts);
    data.defaultAccountId = remaining.length > 0 ? remaining[0] : null;
  }

  saveAccounts(data);
  return name;
}

/**
 * Get an account by ID
 */
export function getAccount(accountId) {
  const data = loadAccounts();
  return data.accounts[accountId] || null;
}

/**
 * Get default account
 */
export function getDefaultAccount() {
  const data = loadAccounts();
  if (!data.defaultAccountId) {
    return null;
  }
  return data.accounts[data.defaultAccountId] || null;
}

/**
 * List all accounts
 */
export function listAccounts() {
  const data = loadAccounts();
  return Object.values(data.accounts).map(account => ({
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    resourceUrl: account.credentials.resourceUrl,
    expiryDate: account.credentials.expiryDate,
    isValid: isTokenValid(account.credentials),
    requestCount: account.requestCount,
    lastUsed: account.lastUsed,
    isDefault: account.id === data.defaultAccountId,
  }));
}

/**
 * Set default account
 */
export function setDefaultAccount(accountId) {
  const data = loadAccounts();
  
  if (!data.accounts[accountId]) {
    throw new Error(`Account not found: ${accountId}`);
  }

  data.defaultAccountId = accountId;
  saveAccounts(data);
}

/**
 * Enable/disable an account
 */
export function toggleAccount(accountId, enabled) {
  const data = loadAccounts();
  
  if (!data.accounts[accountId]) {
    throw new Error(`Account not found: ${accountId}`);
  }

  data.accounts[accountId].enabled = enabled;
  saveAccounts(data);
}

/**
 * Update account credentials (e.g., after token refresh)
 */
export function updateCredentials(accountId, credentials) {
  const data = loadAccounts();
  
  if (!data.accounts[accountId]) {
    throw new Error(`Account not found: ${accountId}`);
  }

  data.accounts[accountId].credentials = {
    ...data.accounts[accountId].credentials,
    ...credentials,
  };
  
  saveAccounts(data);
}

/**
 * Update account stats
 */
export function updateAccountStats(accountId) {
  const data = loadAccounts();
  
  if (!data.accounts[accountId]) {
    return;
  }

  data.accounts[accountId].lastUsed = Date.now();
  data.accounts[accountId].requestCount = (data.accounts[accountId].requestCount || 0) + 1;
  
  saveAccounts(data);
}

/**
 * Check if token is valid
 */
export function isTokenValid(credentials) {
  if (!credentials?.expiryDate || !credentials?.accessToken) {
    return false;
  }
  return Date.now() < credentials.expiryDate - TOKEN_REFRESH_BUFFER_MS;
}

/**
 * Resolve API base URL from resource_url
 */
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

  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    const url = resourceUrl.endsWith('/v1') ? resourceUrl : `${resourceUrl}/v1`;
    return url;
  }

  return API_ENDPOINTS.dashscope;
}

/**
 * Refresh access token
 */
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

/**
 * Get valid credentials (with auto-refresh)
 */
export async function getValidCredentials(accountId) {
  const account = getAccount(accountId);
  
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  if (!account.enabled) {
    throw new Error(`Account is disabled: ${account.name}`);
  }

  let credentials = account.credentials;

  // Check if token needs refresh
  if (!isTokenValid(credentials)) {
    if (!credentials.refreshToken) {
      throw new Error('Token expired and no refresh token available.');
    }

    console.log(`Refreshing token for account: ${account.name}`);
    credentials = await refreshAccessToken(credentials.refreshToken);
    updateCredentials(accountId, credentials);
    console.log('Token refreshed successfully.');
  }

  return credentials;
}

/**
 * Build headers for API requests
 */
export function buildHeaders(credentials) {
  const resourceUrl = credentials.resourceUrl?.toLowerCase() || '';
  const isDashScope = resourceUrl.includes('dashscope') || !resourceUrl;

  const headers = {
    'Authorization': `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json',
  };

  if (isDashScope) {
    headers['X-DashScope-CacheControl'] = 'enable';
    headers['X-DashScope-UserAgent'] = 'qwen-proxy/1.1.0';
    headers['X-DashScope-AuthType'] = 'qwen-oauth';
  }

  return headers;
}

// ============================================
// Load Balancing / Routing
// ============================================

/**
 * Get next available account (round-robin load balancing)
 */
export function getNextAvailableAccount() {
  const data = loadAccounts();
  const enabledAccounts = Object.values(data.accounts).filter(a => 
    a.enabled && isTokenValid(a.credentials)
  );

  if (enabledAccounts.length === 0) {
    // Try accounts that might need refresh
    const refreshableAccounts = Object.values(data.accounts).filter(a => 
      a.enabled && a.credentials.refreshToken
    );
    
    if (refreshableAccounts.length > 0) {
      return refreshableAccounts[0];
    }
    
    return null;
  }

  // Round-robin: pick account with least recent usage
  enabledAccounts.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  return enabledAccounts[0];
}

/**
 * Get account for request (with routing strategy)
 */
export function getAccountForRequest(strategy = 'default') {
  switch (strategy) {
    case 'round-robin':
    case 'load-balance':
      return getNextAvailableAccount();
    
    case 'default':
    default:
      return getDefaultAccount();
  }
}
