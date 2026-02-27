/**
 * Multi-Account Manager for Qwen Proxy
 * 
 * Manages multiple Qwen OAuth accounts with load balancing
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import {
  refreshAccessToken,
  isCredentialsExpired,
  OAUTH_CONFIG,
} from '../auth/oauth.js';

// Paths
const QWEN_PROXY_DIR = join(homedir(), '.qwen-proxy');
const ACCOUNTS_FILE = join(QWEN_PROXY_DIR, 'accounts.json');

// API Configuration
const API_CONFIG = {
  dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  dashscopeIntlBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  portalBaseUrl: 'https://portal.qwen.ai/v1',
};

// DashScope Headers
const DASHSCOPE_HEADERS = {
  cacheControl: 'X-DashScope-CacheControl',
  userAgent: 'X-DashScope-UserAgent',
  authType: 'X-DashScope-AuthType',
};

const USER_AGENT = 'qwen-proxy/1.2.0';

// Round-robin state
let lastAccountIndex = -1;

/**
 * Ensure the .qwen-proxy directory exists
 */
function ensureDir() {
  if (!existsSync(QWEN_PROXY_DIR)) {
    mkdirSync(QWEN_PROXY_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load accounts from file
 */
export function loadAccounts() {
  ensureDir();
  
  if (!existsSync(ACCOUNTS_FILE)) {
    return { accounts: {}, defaultAccountId: null };
  }

  try {
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    
    // Validate structure
    if (!data.accounts || typeof data.accounts !== 'object') {
      return { accounts: {}, defaultAccountId: null };
    }

    return data;
  } catch {
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
 * Get default account
 */
export function getDefaultAccount() {
  const data = loadAccounts();
  
  if (!data.defaultAccountId) {
    // Fall back to first enabled account
    const enabledAccounts = Object.values(data.accounts).filter(a => a.enabled);
    return enabledAccounts.length > 0 ? enabledAccounts[0] : null;
  }

  const account = data.accounts[data.defaultAccountId];
  if (account?.enabled) {
    return account;
  }

  // Default not available, find first enabled
  const enabledAccounts = Object.values(data.accounts).filter(a => a.enabled);
  return enabledAccounts.length > 0 ? enabledAccounts[0] : null;
}

/**
 * Get all enabled accounts
 */
export function getEnabledAccounts() {
  const data = loadAccounts();
  return Object.values(data.accounts).filter(a => a.enabled);
}

/**
 * Get account for request (with load balancing)
 */
export function getAccountForRequest(strategy = 'default') {
  const enabledAccounts = getEnabledAccounts();

  if (enabledAccounts.length === 0) {
    return null;
  }

  if (strategy === 'round-robin' && enabledAccounts.length > 1) {
    // Round-robin: cycle through accounts
    lastAccountIndex = (lastAccountIndex + 1) % enabledAccounts.length;
    return enabledAccounts[lastAccountIndex];
  }

  // Default strategy: use default account or first enabled
  return getDefaultAccount();
}

/**
 * Get valid credentials (with auto-refresh)
 */
export async function getValidCredentials(accountId) {
  const data = loadAccounts();
  const account = data.accounts[accountId];

  if (!account || !account.enabled) {
    return null;
  }

  // Check if token needs refresh
  if (isCredentialsExpired(account.credentials)) {
    if (!account.credentials.refreshToken) {
      console.error(`Account ${account.name} token expired and no refresh token available`);
      return null;
    }

    try {
      console.log(`Refreshing token for account ${account.name}...`);
      const newCredentials = await refreshAccessToken(account.credentials.refreshToken);

      // Update stored credentials
      data.accounts[accountId].credentials = {
        accessToken: newCredentials.accessToken,
        tokenType: newCredentials.tokenType,
        refreshToken: newCredentials.refreshToken || account.credentials.refreshToken,
        resourceUrl: newCredentials.resourceUrl,
        expiryDate: newCredentials.expiryDate,
        scope: newCredentials.scope,
      };

      saveAccounts(data);
      console.log(`Token refreshed for account ${account.name}`);

      return {
        accessToken: newCredentials.accessToken,
        tokenType: newCredentials.tokenType,
        resourceUrl: newCredentials.resourceUrl,
      };
    } catch (error) {
      console.error(`Failed to refresh token for account ${account.name}:`, error);
      return null;
    }
  }

  return {
    accessToken: account.credentials.accessToken,
    tokenType: account.credentials.tokenType,
    resourceUrl: account.credentials.resourceUrl,
  };
}

/**
 * Update account stats after successful request
 */
export function updateAccountStats(accountId) {
  const data = loadAccounts();
  
  if (data.accounts[accountId]) {
    data.accounts[accountId].lastUsed = Date.now();
    data.accounts[accountId].requestCount++;
    saveAccounts(data);
  }
}

/**
 * Resolve base URL from resource_url
 */
export function resolveBaseUrl(resourceUrl) {
  if (!resourceUrl) {
    return API_CONFIG.portalBaseUrl;
  }

  // Normalize URL
  const normalized = resourceUrl.toLowerCase().replace(/\/+$/, '');

  if (normalized === 'portal.qwen.ai' || normalized.includes('portal.qwen.ai')) {
    return API_CONFIG.portalBaseUrl;
  }

  if (normalized.includes('dashscope-intl')) {
    return API_CONFIG.dashscopeIntlBaseUrl;
  }

  if (normalized.includes('dashscope')) {
    return API_CONFIG.dashscopeBaseUrl;
  }

  // Default to portal
  return API_CONFIG.portalBaseUrl;
}

/**
 * Build headers for API request
 */
export function buildHeaders(credentials) {
  const headers = {
    'Authorization': `${credentials.tokenType} ${credentials.accessToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const baseUrl = resolveBaseUrl(credentials.resourceUrl);

  // Add DashScope-specific headers for DashScope endpoints
  if (baseUrl.includes('dashscope')) {
    headers[DASHSCOPE_HEADERS.cacheControl] = 'user-explicit';
    headers[DASHSCOPE_HEADERS.userAgent] = USER_AGENT;
    headers[DASHSCOPE_HEADERS.authType] = 'OAUTH';
  }

  return headers;
}

/**
 * Check if account token is valid
 */
export function isTokenValid(account) {
  if (!account || !account.credentials) return false;
  return !isCredentialsExpired(account.credentials);
}

/**
 * Get account by ID or name
 */
export function getAccount(idOrName) {
  const data = loadAccounts();
  
  // Try by ID first
  if (data.accounts[idOrName]) {
    return data.accounts[idOrName];
  }

  // Try by name
  const found = Object.values(data.accounts).find(a => a.name === idOrName);
  return found || null;
}
