/**
 * Utility to sanitize and normalize JSON Schemas for tool parameters across different LLMs.
 * Google Gemini and OpenAI have strict JSON Schema requirements (e.g. rejecting $schema,
 * certain anyOf structures, or unknown keywords).
 */

export function sanitizeJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }

  const obj = { ...(schema as Record<string, unknown>) };

  // 1. Remove meta-schema properties that cause Gemini/OpenAI 400 errors
  delete obj['$schema'];
  delete obj['$id'];
  delete obj['definitions'];
  delete obj['$defs'];
  delete obj['title'];

  // 2. Ensure type is present
  if (!obj.type && !obj.properties && !obj.items && !obj.anyOf && !obj.oneOf) {
    obj.type = 'object';
  }

  // 3. Recursively sanitize properties
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    const cleanProps: Record<string, unknown> = {};
    for (const [propKey, propVal] of Object.entries(obj.properties as Record<string, unknown>)) {
      cleanProps[propKey] = sanitizeJsonSchema(propVal);
    }
    obj.properties = cleanProps;
  }

  // 4. Recursively sanitize items (for arrays)
  if (obj.items) {
    if (Array.isArray(obj.items)) {
      obj.items = obj.items.map(sanitizeJsonSchema);
    } else if (typeof obj.items === 'object') {
      obj.items = sanitizeJsonSchema(obj.items);
    }
  }

  // 5. Clean anyOf / oneOf
  if (Array.isArray(obj.anyOf)) {
    obj.anyOf = obj.anyOf.map(sanitizeJsonSchema);
  }
  if (Array.isArray(obj.oneOf)) {
    obj.oneOf = obj.oneOf.map(sanitizeJsonSchema);
  }

  return obj;
}

/**
 * Remove Anthropic-specific cache_control fields from any payload object recursively.
 */
export function stripCacheControl<T>(val: T): T {
  if (!val || typeof val !== 'object') {
    return val;
  }

  if (Array.isArray(val)) {
    return val.map(stripCacheControl) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (k === 'cache_control') {
      continue;
    }
    result[k] = stripCacheControl(v);
  }
  return result as T;
}
