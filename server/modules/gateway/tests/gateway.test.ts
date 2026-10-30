import assert from 'node:assert/strict';
import test from 'node:test';

import { AnthropicAdapter } from '../adapters/anthropic.adapter.js';
import { GeminiAdapter } from '../adapters/gemini.adapter.js';
import { OpenAIAdapter } from '../adapters/openai.adapter.js';
import { sanitizeJsonSchema, stripCacheControl } from '../adapters/schema.cleaner.js';
import { scrubVendorIdentities } from '../adapters/prompt.scrubber.js';
import { BackendRouter } from '../backends/backend.router.js';

test('schema.cleaner: sanitizeJsonSchema removes $schema, definitions and ensures valid object schema', () => {
  const dirtySchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'BashTool',
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to run',
        $id: '#command',
      },
    },
    required: ['command'],
    additionalProperties: false,
  };

  const clean = sanitizeJsonSchema(dirtySchema);
  assert.equal(clean['$schema'], undefined);
  assert.equal(clean['title'], undefined);
  assert.equal(clean.type, 'object');
  assert.ok(clean.properties);
  const props = clean.properties as Record<string, any>;
  assert.equal(props.command.type, 'string');
  assert.equal(props.command['$id'], undefined);
});

test('schema.cleaner: stripCacheControl recursively deletes cache_control fields', () => {
  const payload = {
    system: [{ type: 'text', text: 'Prompt', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }],
      },
    ],
    tools: [
      {
        name: 'test',
        cache_control: { type: 'ephemeral' },
      },
    ],
  };

  const cleaned = stripCacheControl(payload) as any;
  assert.equal(cleaned.system[0].cache_control, undefined);
  assert.equal(cleaned.messages[0].content[0].cache_control, undefined);
  assert.equal(cleaned.tools[0].cache_control, undefined);
});

test('AnthropicAdapter: parseRequest converts Anthropic message request and strips cache_control', () => {
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
          {
            type: 'tool_result' as const,
            tool_use_id: 'call_1',
            content: 'file.txt',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
    tools: [
      {
        name: 'bash',
        description: 'Execute command',
        input_schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { command: { type: 'string' } },
        },
      },
    ],
    thinking: {
      type: 'enabled',
      budget_tokens: 2048,
    },
    stream: true,
  };

  const unified = AnthropicAdapter.parseRequest(raw as any);
  assert.equal(unified.model, 'claude-3-7-sonnet-20250219');
  assert.equal(unified.systemPrompt, 'You are an AI assistant');
  assert.equal(unified.stream, true);
  assert.equal(unified.thinkingBudget, 2048);
  assert.equal(unified.messages.length, 3);
  assert.equal(unified.tools?.length, 1);
  assert.equal(unified.tools?.[0].name, 'bash');
  const toolParams = unified.tools?.[0].parameters as Record<string, any>;
  assert.equal(toolParams?.['$schema'], undefined);

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

test('GeminiAdapter: toGeminiPayload maps unified request and correctly resolves functionResponse tool names', () => {
  const unified = {
    model: 'gemini-2.5-pro',
    systemPrompt: 'Be concise',
    thinkingBudget: 1024,
    messages: [
      { role: 'user' as const, content: 'Run command' },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_call' as const,
            id: 'call_unique_42',
            name: 'execute_command',
            arguments: { cmd: 'pwd' },
          },
        ],
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            toolCallId: 'call_unique_42',
            content: '/home/user/project',
          },
        ],
      },
    ],
    tools: [
      {
        name: 'execute_command',
        description: 'Execute command',
        parameters: { $schema: 'strict', type: 'object', properties: { cmd: { type: 'string' } } },
      },
    ],
  };

  const geminiPayload = GeminiAdapter.toGeminiPayload(unified);
  assert.equal(geminiPayload.systemInstruction?.parts[0].text, 'Be concise');
  assert.equal(geminiPayload.generationConfig?.thinkingConfig?.thinkingBudget, 1024);
  assert.equal(geminiPayload.contents.length, 3);

  // Assistant turn has functionCall
  const assistantPart = geminiPayload.contents[1].parts[0];
  assert.ok(assistantPart.functionCall);
  assert.equal(assistantPart.functionCall.name, 'execute_command');

  // User turn has functionResponse with the RESOLVED tool name
  const toolResponsePart = geminiPayload.contents[2].parts[0];
  assert.ok(toolResponsePart.functionResponse);
  assert.equal(toolResponsePart.functionResponse.name, 'execute_command');
  assert.deepEqual(toolResponsePart.functionResponse.response, { output: '/home/user/project' });

  // Tool parameter schema should not contain $schema
  assert.equal(geminiPayload.tools?.[0].functionDeclarations[0].parameters?.['$schema'], undefined);
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
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.equal(parsed.usage?.totalTokens, 35);
});

test('BackendRouter: listAvailableModels and provider prefix routing', () => {
  const router = new BackendRouter();
  const models = router.listAvailableModels();
  const ids = models.map((m) => m.id);

  assert.ok(ids.includes('claude-3-7-sonnet-20250219'));
  assert.ok(ids.includes('claude-3-5-sonnet-20241022'));
  assert.ok(ids.includes('gemini-3.8-flash-high'));
  assert.ok(ids.includes('claude-sonnet-4-6'));

  // Test provider prefix routing: agy/gemini-3.8-flash-high
  const resolvedAgy = router.resolveBackend('agy/gemini-3.8-flash-high');
  assert.equal(resolvedAgy.backend.id, 'agy');
  assert.equal(resolvedAgy.targetModel, 'gemini-3.8-flash-high');
});

test('prompt.scrubber: scrubVendorIdentities cleans Claude Code and Anthropic brand identity', () => {
  const dirtyPrompt = "You are Claude Code, Anthropic's official CLI for software development. You are Claude, created by Anthropic.";
  const cleanPrompt = scrubVendorIdentities(dirtyPrompt);

  assert.ok(!cleanPrompt.includes('Claude Code'));
  assert.ok(!cleanPrompt.includes('created by Anthropic'));
  assert.ok(cleanPrompt.includes('AI software engineering assistant'));
});

test('GeminiAdapter: extracts system messages from messages list into systemInstruction and keeps contents clean', () => {
  const req = {
    model: 'gemini-2.5-pro',
    messages: [
      { role: 'system' as const, content: 'You are Claude Code, Anthropic official CLI.' },
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi' },
    ],
  };

  const payload = GeminiAdapter.toGeminiPayload(req);

  // systemInstruction should exist and be cleaned
  assert.ok(payload.systemInstruction);
  assert.ok(payload.systemInstruction.parts[0].text.includes('AI software engineering assistant'));
  assert.ok(!payload.systemInstruction.parts[0].text.includes('Claude Code'));

  // contents should only have user and model, NO system messages
  assert.equal(payload.contents.length, 2);
  assert.equal(payload.contents[0].role, 'user');
  assert.equal(payload.contents[1].role, 'model');
});
