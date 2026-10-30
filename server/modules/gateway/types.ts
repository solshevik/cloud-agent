/**
 * Unified types for the Multi-Protocol API Gateway.
 * Bridges Anthropic, OpenAI, and Gemini formats into a common intermediate representation.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface UnifiedTextPart {
  type: 'text';
  text: string;
}

export interface UnifiedImagePart {
  type: 'image';
  mediaType: string;
  data: string; // base64
}

export interface UnifiedToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface UnifiedToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  name?: string;
  content: string;
  isError?: boolean;
}

export type UnifiedPart = UnifiedTextPart | UnifiedImagePart | UnifiedToolCallPart | UnifiedToolResultPart;

export interface UnifiedMessage {
  role: Role;
  content: string | UnifiedPart[];
  name?: string;
}

export interface UnifiedTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface UnifiedChatRequest {
  model: string;
  messages: UnifiedMessage[];
  systemPrompt?: string;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  tools?: UnifiedTool[];
  stopSequences?: string[];
  thinkingBudget?: number;
  rawBody?: Record<string, unknown>;
}

export interface UnifiedChunk {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name?: string;
    argumentsJson?: string;
  }>;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error' | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface UnifiedChatResponse {
  id: string;
  model: string;
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Common backend execution interface.
 */
export interface GatewayBackend {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  supportsModel(model: string): boolean;
  executeStream(
    request: UnifiedChatRequest,
    onChunk: (chunk: UnifiedChunk) => void
  ): Promise<void>;
  execute(request: UnifiedChatRequest): Promise<UnifiedChatResponse>;
}
