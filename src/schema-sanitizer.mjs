/**
 * JSON Schema Sanitizer for Google Cloud Code / Gemini
 *
 * 核心机制：
 * Google Gemini API 严格限制 JSON Schema 语法，任何不支持的关键字都会导致 400 校验错误：
 * 1. 字段白名单过滤（仅允许 type, description, properties, required, items, enum）；
 * 2. 将 const 语法重写为 enum: [val]；
 * 3. 将类型转换为 Google 协议大写形式（STRING, NUMBER, INTEGER, BOOLEAN, ARRAY, OBJECT）；
 * 4. 自动为无 properties 的空 object 补齐占位属性，避免接口拒绝。
 */

function toGoogleType(type) {
  if (!type || typeof type !== 'string') return 'OBJECT';
  const typeMap = {
    'string': 'STRING',
    'number': 'NUMBER',
    'integer': 'INTEGER',
    'boolean': 'BOOLEAN',
    'array': 'ARRAY',
    'object': 'OBJECT',
    'null': 'STRING',
  };
  return typeMap[type.toLowerCase()] || type.toUpperCase();
}

export function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return {
      type: 'OBJECT',
      properties: {
        reason: { type: 'STRING', description: 'Execution parameter' }
      },
      required: ['reason']
    };
  }

  const ALLOWED_FIELDS = new Set([
    'type',
    'description',
    'properties',
    'required',
    'items',
    'enum',
    'title'
  ]);

  const sanitized = {};

  for (const [key, value] of Object.entries(schema)) {
    // 转换 const 为 enum
    if (key === 'const') {
      sanitized.enum = [value];
      continue;
    }

    if (!ALLOWED_FIELDS.has(key)) {
      continue;
    }

    if (key === 'type') {
      sanitized.type = toGoogleType(value);
    } else if (key === 'properties' && value && typeof value === 'object') {
      sanitized.properties = {};
      const sortedPropKeys = Object.keys(value).sort();
      for (const propKey of sortedPropKeys) {
        sanitized.properties[propKey] = sanitizeSchema(value[propKey]);
      }
    } else if (key === 'items' && value && typeof value === 'object') {
      if (Array.isArray(value)) {
        sanitized.items = value.map(item => sanitizeSchema(item));
      } else {
        sanitized.items = sanitizeSchema(value);
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeSchema(value);
    } else {
      sanitized[key] = value;
    }
  }

  // 过滤 required 数组，确保仅包含 properties 中真实存在的字段名（避免 Google 报 required[X]: property is not defined）
  if (Array.isArray(sanitized.required)) {
    if (sanitized.properties && typeof sanitized.properties === 'object') {
      const validPropNames = new Set(Object.keys(sanitized.properties));
      sanitized.required = sanitized.required.filter(r => typeof r === 'string' && validPropNames.has(r));
      if (sanitized.required.length === 0) {
        delete sanitized.required;
      }
    } else {
      delete sanitized.required;
    }
  }

  // ARRAY 类型必须具备 items 字段
  if (sanitized.type === 'ARRAY' && !sanitized.items) {
    sanitized.items = { type: 'STRING' };
  }

  // 默认补齐 type
  if (!sanitized.type) {
    sanitized.type = 'OBJECT';
  }

  // 若为 OBJECT 但无 properties，Google 可能会拒收，补充占位属性
  if (sanitized.type === 'OBJECT' && (!sanitized.properties || Object.keys(sanitized.properties).length === 0)) {
    sanitized.properties = {
      _empty: {
        type: 'BOOLEAN',
        description: 'Parameter presence flag'
      }
    };
  }

  return sanitized;
}
