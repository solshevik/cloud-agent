import type { NextFunction, Request, Response } from 'express';

import { IS_PLATFORM } from '../../shared/utils.js';
import { apiKeysDb } from '../database/index.js';

import { gatewayConfigService } from './gateway.config.js';

export function gatewayAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 1. Extract API key from headers or query parameters
  const authHeader = req.headers.authorization;
  let bearerKey: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    bearerKey = authHeader.slice(7).trim();
  }

  const apiKeyHeader = (req.headers['x-api-key'] as string | undefined)?.trim();
  const queryKey = (req.query.apiKey as string | undefined)?.trim() || (req.query.key as string | undefined)?.trim();

  const candidateKey = apiKeyHeader || bearerKey || queryKey;

  const isAnthropicPath = req.path.includes('/messages');

  const respondUnauthorized = (message: string) => {
    if (isAnthropicPath) {
      res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message,
        },
      });
    } else {
      res.status(401).json({
        error: {
          message,
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key',
        },
      });
    }
  };

  // 2. Check platform mode bypass (if trusted platform proxy)
  if (IS_PLATFORM && !candidateKey) {
    return next();
  }

  if (!candidateKey) {
    return respondUnauthorized('API key required. Provide via "x-api-key" header, "Authorization: Bearer <key>", or "?apiKey=<key>".');
  }

  // 3. Check gateway static API key (if configured in gatewayConfig)
  const config = gatewayConfigService.getConfig();
  if (config.apiKey && candidateKey === config.apiKey) {
    (req as any).user = { id: 0, username: 'gateway-admin' };
    return next();
  }

  // 4. Validate against CloudCLI database api_keys
  try {
    const user = apiKeysDb.validateApiKey(candidateKey);
    if (user) {
      (req as any).user = user;
      return next();
    }
  } catch (err) {
    console.error('Error validating API key in database:', err);
  }

  return respondUnauthorized('Invalid or inactive API key.');
}
