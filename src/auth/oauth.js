/**
 * Qwen OAuth Device Flow Implementation
 * 
 * Based on RFC 8628 with PKCE support
 * Handles device authorization, token polling, and refresh
 */

import { randomBytes, createHash, randomUUID } from 'node:crypto';

// OAuth Configuration
export const OAUTH_CONFIG = {
  baseUrl: 'https://chat.qwen.ai',
  deviceCodeEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
  tokenEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/token',
  clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
  scope: 'openid profile email model.completion',
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
};

// Token refresh buffer (30 seconds before expiry)
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000;

/**
 * Error thrown when server requests slow_down (RFC 8628)
 */
export class SlowDownError extends Error {
  constructor() {
    super('slow_down: server requested increased polling interval');
    this.name = 'SlowDownError';
  }
}

/**
 * Generate PKCE code verifier and challenge (RFC 7636)
 */
export function generatePKCE() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

/**
 * Convert object to URL-encoded form data
 */
function objectToUrlEncoded(data) {
  return Object.keys(data)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
    .join('&');
}

/**
 * Request device authorization from Qwen OAuth
 * Returns device_code, user_code, and verification URL
 */
export async function requestDeviceAuthorization(codeChallenge) {
  const bodyData = {
    client_id: OAUTH_CONFIG.clientId,
    scope: OAUTH_CONFIG.scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  };

  const response = await fetch(OAUTH_CONFIG.deviceCodeEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'x-request-id': randomUUID(),
    },
    body: objectToUrlEncoded(bodyData),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Device auth failed: HTTP ${response.status}: ${errorData}`);
  }

  const result = await response.json();

  if (!result.device_code || !result.user_code) {
    throw new Error('Invalid device authorization response');
  }

  return result;
}

/**
 * Poll for device token after user authorization
 * Returns null if still pending
 */
export async function pollDeviceToken(deviceCode, codeVerifier) {
  const bodyData = {
    grant_type: OAUTH_CONFIG.grantType,
    client_id: OAUTH_CONFIG.clientId,
    device_code: deviceCode,
    code_verifier: codeVerifier,
  };

  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: objectToUrlEncoded(bodyData),
  });

  if (!response.ok) {
    const responseText = await response.text();

    try {
      const errorData = JSON.parse(responseText);

      // Authorization pending - user hasn't authorized yet
      if (response.status === 400 && errorData.error === 'authorization_pending') {
        return null;
      }

      // Slow down - increase poll interval
      if (response.status === 429 && errorData.error === 'slow_down') {
        throw new SlowDownError();
      }

      throw new Error(`Token poll failed: ${errorData.error || responseText}`);
    } catch (parseError) {
      if (parseError instanceof SyntaxError) {
        throw new Error(`Token poll failed: ${response.status} ${response.statusText}`);
      }
      throw parseError;
    }
  }

  return await response.json();
}

/**
 * Convert token response to credentials
 */
export function tokenResponseToCredentials(tokenResponse) {
  return {
    accessToken: tokenResponse.access_token,
    tokenType: tokenResponse.token_type || 'Bearer',
    refreshToken: tokenResponse.refresh_token,
    resourceUrl: tokenResponse.resource_url,
    expiryDate: Date.now() + tokenResponse.expires_in * 1000,
    scope: tokenResponse.scope,
  };
}

/**
 * Refresh access token using refresh_token
 */
export async function refreshAccessToken(refreshToken) {
  const bodyData = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CONFIG.clientId,
  };

  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: objectToUrlEncoded(bodyData),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: HTTP ${response.status}: ${errorText}`);
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
 * Check if credentials are expired (with buffer)
 */
export function isCredentialsExpired(credentials) {
  if (!credentials.expiryDate) return false;
  return Date.now() > credentials.expiryDate - TOKEN_REFRESH_BUFFER_MS;
}

/**
 * Get remaining time until expiry in seconds
 */
export function getTimeUntilExpiry(credentials) {
  if (!credentials.expiryDate) return Infinity;
  return Math.max(0, Math.floor((credentials.expiryDate - Date.now()) / 1000));
}

/**
 * Perform full device authorization flow
 * Opens browser for user to authorize, polls for token
 */
export async function performDeviceAuthFlow(onVerificationUrl, pollIntervalMs = 2000, timeoutMs = 5 * 60 * 1000) {
  // Generate PKCE
  const { verifier, challenge } = generatePKCE();

  // Request device authorization
  const deviceAuth = await requestDeviceAuthorization(challenge);

  // Notify caller of verification URL
  onVerificationUrl(deviceAuth.verification_uri_complete, deviceAuth.user_code);

  // Poll for token
  const startTime = Date.now();
  let interval = pollIntervalMs;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    try {
      const tokenResponse = await pollDeviceToken(deviceAuth.device_code, verifier);

      if (tokenResponse) {
        return tokenResponseToCredentials(tokenResponse);
      }
    } catch (error) {
      if (error instanceof SlowDownError) {
        interval = Math.min(interval * 1.5, 10000);
      } else {
        throw error;
      }
    }
  }

  throw new Error('Device authorization timeout');
}
