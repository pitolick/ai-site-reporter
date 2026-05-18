import { describe, it, expect } from 'vitest';
import { AI_SITE_REPORTER_VERSION } from '../src/index.js';

describe('ai-site-reporter smoke test', () => {
  it('exports a version string', () => {
    expect(typeof AI_SITE_REPORTER_VERSION).toBe('string');
    expect(AI_SITE_REPORTER_VERSION).toBe('0.0.0');
  });
});
