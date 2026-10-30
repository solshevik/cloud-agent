import express, { type Request, type Response } from 'express';

import { backendRouter } from './backends/backend.router.js';
import { gatewayConfigService } from './gateway.config.js';

export const gatewayAdminRoutes = express.Router();

/**
 * GET /api/gateway/config
 * Return current gateway settings and available models.
 */
gatewayAdminRoutes.get('/config', (_req: Request, res: Response) => {
  const config = gatewayConfigService.getMaskedConfig();
  const models = backendRouter.listAvailableModels();
  res.json({
    config,
    models,
  });
});

/**
 * POST /api/gateway/config
 * Update gateway settings.
 */
gatewayAdminRoutes.post('/config', (req: Request, res: Response) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Request body must be an object' });
  }

  gatewayConfigService.updateConfig(updates);

  res.json({
    success: true,
    config: gatewayConfigService.getMaskedConfig(),
  });
});
