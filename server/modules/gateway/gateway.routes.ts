import crypto from 'crypto';

import express, { type Request, type Response } from 'express';

import { AnthropicAdapter } from './adapters/anthropic.adapter.js';
import { OpenAIAdapter } from './adapters/openai.adapter.js';
import { backendRouter } from './backends/backend.router.js';
import { gatewayAuthMiddleware } from './gateway.auth.js';

export const gatewayRoutes = express.Router();

// Apply unified gateway authentication
gatewayRoutes.use(gatewayAuthMiddleware);

/**
 * GET /v1/models
 * Returns the list of models supported by the gateway.
 */
gatewayRoutes.get('/models', (_req: Request, res: Response) => {
  const models = backendRouter.listAvailableModels();
  res.json({
    object: 'list',
    data: models,
  });
});

/**
 * GET /v1/models/:model
 * Returns details for a single model.
 */
gatewayRoutes.get('/models/:model', (req: Request, res: Response) => {
  const modelId = req.params.model;
  const models = backendRouter.listAvailableModels();
  const found = models.find((m) => m.id === modelId);

  if (found) {
    return res.json(found);
  }

  return res.json({
    id: modelId,
    object: 'model',
    created: 1700000000,
    owned_by: 'custom',
  });
});

/**
 * POST /v1/messages
 * Anthropic Messages API compatible endpoint (used by Claude Code CLI and Anthropic SDKs).
 */
gatewayRoutes.post('/messages', async (req: Request, res: Response) => {
  try {
    const rawBody = req.body;
    if (!rawBody || !rawBody.messages) {
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'messages field is required',
        },
      });
    }

    const unifiedRequest = AnthropicAdapter.parseRequest(rawBody);
    const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;

    if (unifiedRequest.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const streamHandler = AnthropicAdapter.createStreamHandler(res, rawBody.model, messageId);

      try {
        await backendRouter.executeStream(unifiedRequest, (chunk) => {
          streamHandler.handleChunk(chunk);
        });
        streamHandler.finish();
      } catch (streamErr: any) {
        console.error('Streaming error in /v1/messages:', streamErr);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: streamErr.message } })}\n\n`);
        res.end();
      }
    } else {
      const { response } = await backendRouter.execute(unifiedRequest);
      const formatted = AnthropicAdapter.formatResponse(response, rawBody.model);
      return res.json(formatted);
    }
  } catch (err: any) {
    console.error('Error handling /v1/messages:', err);
    return res.status(500).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: err.message || 'Internal gateway error',
      },
    });
  }
});

/**
 * POST /v1/chat/completions
 * OpenAI Chat Completions API compatible endpoint (used by Cursor, NextChat, etc.).
 */
gatewayRoutes.post('/chat/completions', async (req: Request, res: Response) => {
  try {
    const rawBody = req.body;
    if (!rawBody || !rawBody.messages) {
      return res.status(400).json({
        error: {
          message: 'messages field is required',
          type: 'invalid_request_error',
          param: 'messages',
          code: null,
        },
      });
    }

    const unifiedRequest = OpenAIAdapter.parseRequest(rawBody);
    const completionId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

    if (unifiedRequest.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const streamHandler = OpenAIAdapter.createStreamHandler(res, rawBody.model, completionId);

      try {
        await backendRouter.executeStream(unifiedRequest, (chunk) => {
          streamHandler.handleChunk(chunk);
        });
        streamHandler.finish();
      } catch (streamErr: any) {
        console.error('Streaming error in /v1/chat/completions:', streamErr);
        res.write(`data: ${JSON.stringify({ error: { message: streamErr.message, type: 'api_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      const { response } = await backendRouter.execute(unifiedRequest);
      const formatted = OpenAIAdapter.formatResponse(response, rawBody.model);
      return res.json(formatted);
    }
  } catch (err: any) {
    console.error('Error handling /v1/chat/completions:', err);
    return res.status(500).json({
      error: {
        message: err.message || 'Internal gateway error',
        type: 'api_error',
        code: null,
      },
    });
  }
});

/**
 * Gemini routes handler for /v1beta
 */
export const geminiGatewayRoutes = express.Router();
geminiGatewayRoutes.use(gatewayAuthMiddleware);

geminiGatewayRoutes.post('/models/:modelAndAction', async (req: Request, res: Response) => {
  try {
    const param = String(req.params.modelAndAction);
    const isStream = param.includes(':streamGenerateContent');
    const model = param.replace(/:.*$/, '');

    const geminiPayload = req.body;
    // Map to UnifiedChatRequest
    const unifiedRequest = {
      model,
      stream: isStream,
      messages: (geminiPayload.contents || []).map((c: any) => ({
        role: c.role === 'model' ? 'assistant' : 'user',
        content: (c.parts || []).map((p: any) => {
          if (p.text) return { type: 'text', text: p.text };
          if (p.functionCall) {
            return {
              type: 'tool_call',
              id: `call_${Date.now()}`,
              name: p.functionCall.name,
              arguments: p.functionCall.args,
            };
          }
          if (p.functionResponse) {
            return {
              type: 'tool_result',
              toolCallId: p.functionResponse.name,
              name: p.functionResponse.name,
              content: JSON.stringify(p.functionResponse.response),
            };
          }
          return { type: 'text', text: '' };
        }),
      })),
      systemPrompt: geminiPayload.systemInstruction?.parts?.map((p: any) => p.text).join('\n'),
      tools: geminiPayload.tools?.[0]?.functionDeclarations?.map((f: any) => ({
        name: f.name,
        description: f.description,
        parameters: f.parameters || {},
      })),
      temperature: geminiPayload.generationConfig?.temperature,
      maxTokens: geminiPayload.generationConfig?.maxOutputTokens,
    } as any;

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      await backendRouter.executeStream(unifiedRequest, (chunk) => {
        const parts: any[] = [];
        if (chunk.thinking) {
          parts.push({ text: chunk.thinking, thought: true });
        }
        if (chunk.text) {
          parts.push({ text: chunk.text });
        }
        if (chunk.toolCalls) {
          for (const tc of chunk.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {},
              },
            });
          }
        }

        const data = {
          candidates: [
            {
              content: { role: 'model', parts },
              finishReason: chunk.finishReason === 'stop' ? 'STOP' : undefined,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      });
      res.end();
    } else {
      const { response } = await backendRouter.execute(unifiedRequest);
      const parts: any[] = [];
      if (response.thinking) {
        parts.push({ text: response.thinking, thought: true });
      }
      if (response.content) {
        parts.push({ text: response.content });
      }
      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.arguments,
            },
          });
        }
      }

      res.json({
        candidates: [
          {
            content: { role: 'model', parts },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: response.usage.promptTokens,
          candidatesTokenCount: response.usage.completionTokens,
          totalTokenCount: response.usage.totalTokens,
        },
      });
    }
  } catch (err: any) {
    console.error('Error in /v1beta/models:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});
