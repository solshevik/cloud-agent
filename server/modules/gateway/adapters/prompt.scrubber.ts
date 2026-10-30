/**
 * Identity, Branding, and Environment Metadata Scrubber for Multi-Protocol LLM Gateway.
 * Cleans vendor-specific identity claims (Claude Code, Anthropic, OpenAI, etc.)
 * and environmental noise (current time, timezone, physical location, OS versions)
 * from system instructions so that target models (Gemini, DeepSeek, agy, etc.)
 * stay focused on user intent without prompt leakage or distraction.
 */

// Patterns that declare specific vendor identities in system prompts
const IDENTITY_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  {
    regex: /\bYou are Claude Code\b(?:,\s*(?:an AI\s+)?created by Anthropic)?[^.,\n]*/gi,
    replacement: 'You are an advanced AI software engineering assistant',
  },
  {
    regex: /\bYou are Claude,\s*(?:an AI|a large language model)?\s*created by Anthropic\b[^.,\n]*/gi,
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
  {
    regex: /,?\s*(?:an AI\s+)?created by Anthropic\b[^.,\n]*/gi,
    replacement: '',
  },
  {
    regex: /\bAnthropic\b/gi,
    replacement: 'AI',
  },
];

const METADATA_LINE_PREFIX = /^[ \t]*(?:(?:The\s+)?(?:user's|current)\s+)?(?:local\s+)?(?:time\s+is|local\s+time\s+is|date\s+is|today's\s+date\s+is|today's\s+date|time\s*zone|timezone|location\s+is|current\s+location\s+is|location)|^[ \t]*(?:(?:The\s+)?(?:USER's\s+)?(?:Operating\s+System|OS\s+version|Current\s+OS))|^[ \t]*(?:Current\s+working\s+directory|cwd|Command\s+Working\s+Directory)/i;

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

/**
 * Scrubs irrelevant client environment metadata (local time, timezone, physical location, OS)
 * from system instructions.
 */
export function scrubPromptMetadata(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') {
    return prompt;
  }

  // 1. Remove XML/HTML metadata blocks (e.g., <ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>)
  let cleaned = prompt.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');

  // 2. Filter out metadata lines
  const lines = cleaned.split('\n');
  const filtered = lines.filter((line) => !METADATA_LINE_PREFIX.test(line));
  cleaned = filtered.join('\n');

  // 3. Clean any inline metadata sentences
  cleaned = cleaned.replace(/(?:The\s+)?(?:user's\s+)?(?:current\s+)?(?:local\s+)?time\s+is:[^.\n]+(?:\.|\n|$)/gi, '');
  cleaned = cleaned.replace(/(?:The\s+)?(?:user's\s+)?(?:geographic\s+)?(?:current\s+)?location\s+is:[^.\n]+(?:\.|\n|$)/gi, '');
  cleaned = cleaned.replace(/(?:(?:The\s+)?user's\s+)?timezone:[^.\n]+(?:\.|\n|$)/gi, '');

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

const HARNESS_BLOCKS: RegExp[] = [
  /<guidelines>[\s\S]*?<\/guidelines>/gi,
  /<memory_management>[\s\S]*?<\/memory_management>/gi,
  /<environment>[\s\S]*?<\/environment>/gi,
  /<commit_attribution>[\s\S]*?<\/commit_attribution>/gi,
  /<artifacts>[\s\S]*?<\/artifacts>/gi,
  /<conversation_transcript>[\s\S]*?<\/conversation_transcript>/gi,
  /<skills>[\s\S]*?<\/skills>/gi,
  /<tools>[\s\S]*?<\/tools>/gi,
  /<slash_commands>[\s\S]*?<\/slash_commands>/gi,
  /<user_information>[\s\S]*?<\/user_information>/gi,
  /<system_instructions>[\s\S]*?<\/system_instructions>/gi,
  /<anthropic_guidelines>[\s\S]*?<\/anthropic_guidelines>/gi,
];

/**
 * Scrubs client harness-specific blocks (guidelines, memory_management, etc.)
 * from system instructions so backend engines like agy or Gemini are not confused by
 * foreign client harness instructions.
 */
export function scrubHarnessBlocks(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') return prompt;

  let cleaned = prompt;
  for (const block of HARNESS_BLOCKS) {
    cleaned = cleaned.replace(block, '');
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Clean system prompt completely: vendor identity scrubbing + environmental metadata removal + harness block scrubbing.
 */
export function cleanSystemPrompt(prompt?: string): string | undefined {
  if (!prompt || typeof prompt !== 'string') {
    return undefined;
  }

  const identityCleaned = scrubVendorIdentities(prompt);
  const metadataCleaned = scrubPromptMetadata(identityCleaned);
  const harnessCleaned = scrubHarnessBlocks(metadataCleaned);
  return harnessCleaned || undefined;
}

