/**
 * Identity & Branding Scrubber for Multi-Protocol LLM Gateway.
 * Cleans vendor-specific identity claims (Claude Code, Anthropic, OpenAI, etc.)
 * from system instructions and user prompts so that target models (Gemini, DeepSeek, etc.)
 * don't experience identity confusion or prompt leakage.
 */

// Patterns that declare specific vendor identities in system prompts
const IDENTITY_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  {
    regex: /\bYou are Claude Code\b[^.,\n]*/gi,
    replacement: 'You are an advanced AI software engineering assistant',
  },
  {
    regex: /\bYou are Claude,\s*(an AI|a large language model)?\s*created by Anthropic\b[^.,\n]*/gi,
    replacement: 'You are a helpful and intelligent AI programming assistant',
  },
  {
    regex: /\bYou are a helpful assistant developed by OpenAI\b[^.,\n]*/gi,
    replacement: 'You are a helpful and intelligent AI programming assistant',
  },
  {
    regex: /\bAnthropic's official CLI for Claude\b[^.,\n]*/gi,
    replacement: 'an intelligent AI coding CLI',
  },
  {
    regex: /\bAnthropic's Claude\b/gi,
    replacement: 'the AI assistant',
  },
];

/**
 * Scrubs vendor-specific branding and identity claims from system instructions.
 */
export function scrubVendorIdentities(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') {
    return prompt;
  }

  let cleaned = prompt;
  for (const { regex, replacement } of IDENTITY_PATTERNS) {
    cleaned = cleaned.replace(regex, replacement);
  }

  return cleaned;
}
