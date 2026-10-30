import assert from 'node:assert/strict';
import test from 'node:test';

import { AnthropicAdapter } from '../adapters/anthropic.adapter.js';
import { GeminiAdapter } from '../adapters/gemini.adapter.js';
import { OpenAIAdapter } from '../adapters/openai.adapter.js';
import { BackendRouter } from '../backends/backend.router.js';

test('AnthropicAdapter: parseRequest converts Anthropic message request to UnifiedChatRequest', () => {
  const raw = {
    model: 'claude-3-7-sonnet-20250219',
    system: 'You are an AI assistant',
    messages: [
      { role: 'user' as const, content: 'Hello world' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Running tool' },
          { type: 'tool_use' as const, id: 'call_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'call_1', content: 'file.txt' },
        ],
      },
    ],
    tools: [
      {
        name: 'bash',
        description: 'Execute command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
    stream: true,
  };

  const unified = AnthropicAdapter.parseRequest(raw);
  assert.equal(unified.model, 'claude-3-7-sonnet-20250219');
  assert.equal(unified.systemPrompt, 'You are an AI assistant');
  assert.equal(unified.stream, true);
  assert.equal(unified.messages.length, 3);
  assert.equal(unified.tools?.length, 1);
  assert.equal(unified.tools?.[0].name, 'bash');

  // Check tool_result mapping
  const lastMsg = unified.messages[2];
  assert.equal(Array.isArray(lastMsg.content), true);
  const resultPart = (lastMsg.content as any[])[0];
  assert.equal(resultPart.type, 'tool_result');
  assert.equal(resultPart.toolCallId, 'call_1');
  assert.equal(resultPart.content, 'file.txt');
});

test('AnthropicAdapter: formatResponse produces standard Anthropic response JSON', () => {
  const unifiedResponse = {
    id: '12345',
    model: 'claude-3-7-sonnet-20250219',
    content: 'All done',
    thinking: 'Thinking about files...',
    toolCalls: [
      { id: 'tool_1', name: 'read_file', arguments: { path: '/tmp/test' } },
    ],
    finishReason: 'tool_calls' as const,
    usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
  };

  const formatted = AnthropicAdapter.formatResponse(unifiedResponse) as any;
  assert.equal(formatted.id, 'msg_12345');
  assert.equal(formatted.type, 'message');
  assert.equal(formatted.role, 'assistant');
  assert.equal(formatted.stop_reason, 'tool_use');
  assert.equal(formatted.usage.input_tokens, 50);
  assert.equal(formatted.usage.output_tokens, 25);
  assert.equal(formatted.content.length, 3); // thinking + text + tool_use
  assert.equal(formatted.content[0].type, 'thinking');
  assert.equal(formatted.content[1].type, 'text');
  assert.equal(formatted.content[2].type, 'tool_use');
});

test('OpenAIAdapter: parseRequest converts OpenAI request to UnifiedChatRequest', () => {
  const raw = {
    model: 'gpt-4o',
    messages: [
      { role: 'system' as const, content: 'You are helpful' },
      { role: 'user' as const, content: 'Hi' },
      {
        role: 'assistant' as const,
        content: 'I will list directory',
        tool_calls: [
          {
            id: 'call_99',
            type: 'function' as const,
            function: { name: 'list_dir', arguments: '{"path":"."}' },
          },
        ],
      },
      {
        role: 'tool' as const,
        tool_call_id: 'call_99',
        content: 'index.ts',
      },
    ],
    stream: false,
  };

  const unified = OpenAIAdapter.parseRequest(raw);
  assert.equal(unified.model, 'gpt-4o');
  assert.equal(unified.systemPrompt, 'You are helpful');
  assert.equal(unified.messages.length, 3);
  assert.equal(unified.messages[1].role, 'assistant');
  assert.equal(unified.messages[2].role, 'tool');
});

test('OpenAIAdapter: formatResponse formats OpenAI completion JSON', () => {
  const unifiedResponse = {
    id: 'comp_1',
    model: 'gpt-4o',
    content: 'Hello from model',
    toolCalls: [],
    finishReason: 'stop' as const,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };

  const formatted = OpenAIAdapter.formatResponse(unifiedResponse) as any;
  assert.equal(formatted.id, 'chatcmpl-comp_1');
  assert.equal(formatted.object, 'chat.completion');
  assert.equal(formatted.choices[0].message.content, 'Hello from model');
  assert.equal(formatted.choices[0].finish_reason, 'stop');
});

test('GeminiAdapter: toGeminiPayload maps unified request to Google Gemini REST schema', () => {
  const unified = {
    model: 'gemini-2.5-pro',
    systemPrompt: 'Be concise',
    messages: [
      { role: 'user' as const, content: 'What is 2+2?' },
      { role: 'assistant' as const, content: 'It is 4' },
      { role: 'user' as const, content: 'Thanks' },
    ],
    tools: [
      {
        name: 'calc',
        description: 'Calculator',
        parameters: { type: 'object', properties: { expr: { type: 'string' } } },
      },
    ],
  };

  const geminiPayload = GeminiAdapter.toGeminiPayload(unified);
  assert.equal(geminiPayload.systemInstruction?.parts[0].text, 'Be concise');
  assert.equal(geminiPayload.contents.length, 3);
  assert.equal(geminiPayload.contents[0].role, 'user');
  assert.equal(geminiPayload.contents[1].role, 'model');
  assert.equal(geminiPayload.tools?.[0].functionDeclarations[0].name, 'calc');
});

test('GeminiAdapter: parseGeminiChunk parses text, thinking and functionCall', () => {
  const rawChunk = {
    candidates: [
      {
        content: {
          parts: [
            { text: 'Planning response...', thought: true },
            { text: 'Final Answer' },
            { functionCall: { name: 'search', args: { q: 'weather' } } },
          ],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 15,
      totalTokenCount: 35,
    },
  };

  const parsed = GeminiAdapter.parseGeminiChunk(rawChunk);
  assert.equal(parsed.thinking, 'Planning response...');
  assert.equal(parsed.text, 'Final Answer');
  assert.equal(parsed.toolCalls?.length, 1);
  assert.equal(parsed.toolCalls?.[0].name, 'search');
  assert.equal(parsed.usage?.totalTokens, 35);
});

test('BackendRouter: listAvailableModels contains Gemini, Claude, OpenAI, and Antigravity models', () => {
  const router = new BackendRouter();
  const models = router.listAvailableModels();
  const ids = models.map((m) => m.id);

  assert.ok(ids.includes('claude-3-7-sonnet-20250219'));
  assert.ok(ids.includes('claude-3-5-sonnet-20241022'));
  assert.ok(ids.includes('gemini-3.8-flash-high'));
  assert.ok(ids.includes('claude-sonnet-4-6'));
});
