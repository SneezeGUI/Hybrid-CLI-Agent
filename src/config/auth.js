/**
 * Authentication and provider configuration defaults
 * @module config/auth
 */

/**
 * Default authentication configuration for cloud providers
 * @constant
 * @type {Object}
 */
export const AUTH_DEFAULTS = {
  /** Default Vertex AI region */
  vertexLocation: 'us-central1',
  /** Default auth method */
  primaryMethod: 'oauth',
};

/**
 * Authentication fallback order
 * @constant
 * @type {string[]}
 */
export const AUTH_FALLBACK_ORDER = [
  'oauth',
  'api-key',
  'vertex',
];
