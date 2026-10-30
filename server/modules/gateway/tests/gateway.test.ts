import assert from 'node:assert/strict';
import test from 'node:test';

import { AnthropicAdapter } from '../adapters/anthropic.adapter.js';
import { GeminiAdapter } from '../adapters/gemini.adapter.js';
import { OpenAIAdapter } from '../adapters/openai.adapter.js';
import { sanitizeJsonSchema, stripCacheControl } from '../adapters/schema.cleaner.js';
import { cleanSystemPrompt, scrubPromptMetadata, scrubVendorIdentities } from '../adapters/prompt.scrubber.js';
import { BackendRouter } from '../backends/backend.router.js';
import { SessionContinuityManager } from '../session.manager.js';

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

test('prompt.scrubber: scrubPromptMetadata and cleanSystemPrompt remove environment noise while preserving code', () => {
  const dirtyPrompt = `You are Claude Code, created by Anthropic.
The user's current time is: 2026-10-30T14:57:17.123Z.
The user's location is: Tokyo, Japan.
User's timezone: Asia/Tokyo.
Operating System: Linux x86_64.
The USER's OS version is linux.
Today's date is: 2026-10-30.
Current working directory: /home/yubs/claudecodeui.

<ADDITIONAL_METADATA>
The current local time is: 2026-10-30T15:05:49Z.
</ADDITIONAL_METADATA>

Please solve this function:
function getCurrentTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}`;

  const cleaned = cleanSystemPrompt(dirtyPrompt);
  assert.ok(cleaned);

  // Vendor claims removed
  assert.ok(!cleaned.includes('Claude Code'));
  assert.ok(!cleaned.includes('created by Anthropic'));
  assert.ok(cleaned.includes('AI software engineering assistant'));

  // Environmental noise removed
  assert.ok(!cleaned.includes('Tokyo, Japan'));
  assert.ok(!cleaned.includes('Asia/Tokyo'));
  assert.ok(!cleaned.includes('Operating System: Linux'));
  assert.ok(!cleaned.includes('2026-10-30T14:57:17'));
  assert.ok(!cleaned.includes('<ADDITIONAL_METADATA>'));

  // Code function preserved
  assert.ok(cleaned.includes('function getCurrentTimezone()'));
  assert.ok(cleaned.includes('Intl.DateTimeFormat().resolvedOptions().timeZone'));
});

test('SessionContinuityManager: generates consistent session keys and handles multi-turn resumption', () => {
  const manager = new SessionContinuityManager();

  const turn1Req = {
    model: 'gemini-3.8-flash-high',
    messages: [
      { role: 'user' as const, content: 'What is the capital of France?' },
    ],
  };

  assert.equal(manager.isFirstTurn(turn1Req), true);

  // Key is derived from first user message
  const key1 = manager.resolveSessionKey(turn1Req);
  assert.ok(key1.startsWith('fp:'));

  // Register conversation id
  manager.setAgyConversationId(key1, 'agy-conv-12345');
  assert.equal(manager.getAgyConversationId(key1), 'agy-conv-12345');

  // Turn 2 request containing history
  const turn2Req = {
    model: 'gemini-3.8-flash-high',
    messages: [
      { role: 'user' as const, content: 'What is the capital of France?' },
      { role: 'assistant' as const, content: 'The capital of France is Paris.' },
      { role: 'user' as const, content: 'What is its population?' },
    ],
  };

  assert.equal(manager.isFirstTurn(turn2Req), false);

  // Key remains identical because first user message is the same
  const key2 = manager.resolveSessionKey(turn2Req);
  assert.equal(key2, key1);

  // Prompt for resume should only be the incremental trailing user message
  const promptTurn2 = manager.getPromptForAgy(turn2Req, true);
  assert.equal(promptTurn2, 'What is its population?');

  // Prompt for fresh invocation without resume contains full history
  const promptTurn1 = manager.getPromptForAgy(turn1Req, false);
  assert.equal(promptTurn1, 'What is the capital of France?');
});
