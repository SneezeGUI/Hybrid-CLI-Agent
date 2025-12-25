/**
 * Input validation utilities for MCP server
 * Provides defensive validation for all user inputs
 */

import { VALID_MODELS as CONFIG_VALID_MODELS } from '../config/index.js';

/**
 * Validation limits and constants
 */
export const LIMITS = {
  MAX_PROMPT_LENGTH: 500000,      // 500K chars (~125K tokens)
  MIN_PROMPT_LENGTH: 1,
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_FILES_PER_REQUEST: 100,
  MAX_SOURCES_COMPARISON: 10,
  MAX_CONVERSATION_HISTORY: 100,
  MAX_ROUNDS: 10,

  // Imported from centralized config
  VALID_MODELS: CONFIG_VALID_MODELS,

  VALID_OUTPUT_MODES: ['content', 'files_with_matches', 'count'],
  VALID_COMPARISON_TYPES: ['semantic', 'structural', 'line_by_line', 'key_points'],
  VALID_SUMMARY_STYLES: ['brief', 'detailed', 'bullet_points', 'executive'],
  VALID_REVIEW_TYPES: ['comprehensive', 'security_only', 'performance_only', 'quick'],
  VALID_COLLABORATION_MODES: ['debate', 'validation', 'sequential'],
  VALID_DEBATE_STYLES: ['constructive', 'adversarial', 'collaborative', 'socratic', 'devil_advocate'],
  VALID_SEVERITY_LEVELS: ['info', 'warning', 'error', 'critical'],
};

/**
 * Validates a prompt string
 * @param {*} prompt - The prompt to validate
 * @returns {{ valid: boolean, error?: string, sanitized?: string }}
 */
export function validatePrompt(prompt) {
  if (prompt === null || prompt === undefined) {
    return { valid: false, error: 'Prompt is required' };
  }

  if (typeof prompt !== 'string') {
    return { valid: false, error: `Prompt must be a string, got ${typeof prompt}` };
  }

  const trimmed = prompt.trim();

  if (trimmed.length < LIMITS.MIN_PROMPT_LENGTH) {
    return { valid: false, error: 'Prompt cannot be empty' };
  }

  if (trimmed.length > LIMITS.MAX_PROMPT_LENGTH) {
    return {
      valid: false,
      error: `Prompt exceeds maximum length of ${LIMITS.MAX_PROMPT_LENGTH} characters (got ${trimmed.length})`
    };
  }

  return { valid: true, sanitized: trimmed };
}

/**
 * Validates a model name against allowed models
 * @param {*} model - The model name to validate
 * @param {string[]} validModels - Array of valid model names
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateModel(model, validModels = LIMITS.VALID_MODELS) {
  if (model === null || model === undefined) {
    // Model is optional, use default
    return { valid: true };
  }

  if (typeof model !== 'string') {
    return { valid: false, error: `Model must be a string, got ${typeof model}` };
  }

  if (!validModels.includes(model)) {
    return {
      valid: false,
      error: `Invalid model '${model}'. Valid models: ${validModels.join(', ')}`
    };
  }

  return { valid: true };
}

/**
 * Validates an array of file patterns
 * @param {*} patterns - The patterns array to validate
 * @param {number} maxPatterns - Maximum number of patterns allowed
 * @returns {{ valid: boolean, error?: string, patterns?: string[] }}
 */
export function validateFilePatterns(patterns, maxPatterns = LIMITS.MAX_FILES_PER_REQUEST) {
  if (patterns === null || patterns === undefined) {
    return { valid: false, error: 'File patterns are required' };
  }

  if (!Array.isArray(patterns)) {
    return { valid: false, error: `File patterns must be an array, got ${typeof patterns}` };
  }

  if (patterns.length === 0) {
    return { valid: false, error: 'At least one file pattern is required' };
  }

  if (patterns.length > maxPatterns) {
    return {
      valid: false,
      error: `Too many file patterns. Maximum is ${maxPatterns}, got ${patterns.length}`
    };
  }

  // Filter and validate each pattern
  const validPatterns = [];
  const invalidPatterns = [];

  for (const pattern of patterns) {
    if (typeof pattern !== 'string') {
      invalidPatterns.push(`${pattern} (not a string)`);
      continue;
    }
    if (pattern.trim().length === 0) {
      invalidPatterns.push('(empty string)');
      continue;
    }
    validPatterns.push(pattern.trim());
  }

  if (validPatterns.length === 0) {
    return { valid: false, error: 'No valid file patterns provided' };
  }

  return {
    valid: true,
    patterns: validPatterns,
    warnings: invalidPatterns.length > 0 ? `Ignored invalid patterns: ${invalidPatterns.join(', ')}` : undefined
  };
}

/**
 * Validates an array of sources for comparison
 * @param {*} sources - The sources array to validate
 * @param {number} maxSources - Maximum number of sources allowed
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSources(sources, maxSources = LIMITS.MAX_SOURCES_COMPARISON) {
  if (sources === null || sources === undefined) {
    return { valid: false, error: 'Sources are required' };
  }

  if (!Array.isArray(sources)) {
    return { valid: false, error: `Sources must be an array, got ${typeof sources}` };
  }

  if (sources.length < 2) {
    return { valid: false, error: 'At least 2 sources are required for comparison' };
  }

  if (sources.length > maxSources) {
    return {
      valid: false,
      error: `Too many sources. Maximum is ${maxSources}, got ${sources.length}`
    };
  }

  // Validate each source is a non-empty string
  for (let i = 0; i < sources.length; i++) {
    if (typeof sources[i] !== 'string') {
      return { valid: false, error: `Source at index ${i} must be a string` };
    }
    if (sources[i].trim().length === 0) {
      return { valid: false, error: `Source at index ${i} cannot be empty` };
    }
  }

  return { valid: true };
}

/**
 * Validates a positive integer within a range
 * @param {*} value - The value to validate
 * @param {string} name - The field name for error messages
 * @param {number} min - Minimum value (inclusive)
 * @param {number} max - Maximum value (inclusive)
 * @returns {{ valid: boolean, error?: string, value?: number }}
 */
export function validatePositiveInteger(value, name, min = 1, max = Infinity) {
  if (value === null || value === undefined) {
    // Optional field, use default
    return { valid: true };
  }

  const num = Number(value);

  if (!Number.isInteger(num)) {
    return { valid: false, error: `${name} must be an integer, got ${typeof value}` };
  }

  if (num < min) {
    return { valid: false, error: `${name} must be at least ${min}, got ${num}` };
  }

  if (num > max) {
    return { valid: false, error: `${name} must be at most ${max}, got ${num}` };
  }

  return { valid: true, value: num };
}

/**
 * Validates a value against an enum of allowed values
 * @param {*} value - The value to validate
 * @param {string[]} validValues - Array of allowed values
 * @param {string} fieldName - The field name for error messages
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateEnum(value, validValues, fieldName) {
  if (value === null || value === undefined) {
    // Optional field, use default
    return { valid: true };
  }

  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string, got ${typeof value}` };
  }

  if (!validValues.includes(value)) {
    return {
      valid: false,
      error: `Invalid ${fieldName} '${value}'. Valid values: ${validValues.join(', ')}`
    };
  }

  return { valid: true };
}

/**
 * Validates an object has required fields
 * @param {*} obj - The object to validate
 * @param {string[]} requiredFields - Array of required field names
 * @returns {{ valid: boolean, error?: string, missingFields?: string[] }}
 */
export function validateObject(obj, requiredFields = []) {
  if (obj === null || obj === undefined) {
    return { valid: false, error: 'Object is required' };
  }

  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, error: `Expected object, got ${Array.isArray(obj) ? 'array' : typeof obj}` };
  }

  if (requiredFields.length === 0) {
    return { valid: true };
  }

  const missingFields = requiredFields.filter(field => {
    const value = obj[field];
    return value === null || value === undefined || value === '';
  });

  if (missingFields.length > 0) {
    return {
      valid: false,
      error: `Missing required fields: ${missingFields.join(', ')}`,
      missingFields
    };
  }

  return { valid: true };
}

/**
 * Validates temperature parameter (0.0 to 2.0)
 * @param {*} value - The temperature value
 * @returns {{ valid: boolean, error?: string, value?: number }}
 */
export function validateTemperature(value) {
  if (value === null || value === undefined) {
    return { valid: true };
  }

  const num = Number(value);

  if (isNaN(num)) {
    return { valid: false, error: `Temperature must be a number, got ${typeof value}` };
  }

  if (num < 0 || num > 2) {
    return { valid: false, error: `Temperature must be between 0.0 and 2.0, got ${num}` };
  }

  return { valid: true, value: num };
}

/**
 * Validates conversation ID format
 * @param {*} id - The conversation ID
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateConversationId(id) {
  if (id === null || id === undefined) {
    return { valid: false, error: 'Conversation ID is required' };
  }

  if (typeof id !== 'string') {
    return { valid: false, error: `Conversation ID must be a string, got ${typeof id}` };
  }

  if (id.trim().length === 0) {
    return { valid: false, error: 'Conversation ID cannot be empty' };
  }

  // Basic format validation (alphanumeric + hyphens)
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    return { valid: false, error: 'Conversation ID contains invalid characters' };
  }

  return { valid: true };
}

/**
 * Aggregate validation helper - validates multiple fields at once
 * @param {Object} validations - Object mapping field names to validation results
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function aggregateValidations(validations) {
  const errors = [];

  for (const [field, result] of Object.entries(validations)) {
    if (!result.valid && result.error) {
      errors.push(`${field}: ${result.error}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export default {
  LIMITS,
  validatePrompt,
  validateModel,
  validateFilePatterns,
  validateSources,
  validatePositiveInteger,
  validateEnum,
  validateObject,
  validateTemperature,
  validateConversationId,
  aggregateValidations,
};
