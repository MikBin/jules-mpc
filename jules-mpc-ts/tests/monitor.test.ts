import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isQuestionMessage,
  shouldEmitStuck,
  monitorOnce,
  findActionableMessage,
  jobStatusUrl,
  jobMessagesUrl,
  buildHeaders
} from '../scripts/jules_monitor.js';
import { promises as fs } from 'fs';

// Mock fs
vi.mock('fs', async () => {
  return {
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      appendFile: vi.fn(),
      mkdir: vi.fn(),
    }
  };
});

// Mock fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('jules_monitor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isQuestionMessage', () => {
    it('should return true for messages with "question" tag', () => {
      expect(isQuestionMessage({ tags: ['question'] })).toBe(true);
    });

    it('should return true for messages with "needs_input" tag', () => {
      expect(isQuestionMessage({ tags: ['needs_input'] })).toBe(true);
    });

    it('should return true for assistant messages containing "?"', () => {
      expect(isQuestionMessage({ role: 'assistant', content: 'What do you think?' })).toBe(true);
    });

    it('should return false for user messages containing "?"', () => {
      expect(isQuestionMessage({ role: 'user', content: 'What do you think?' })).toBe(false);
    });

    it('should return false for normal assistant messages', () => {
      expect(isQuestionMessage({ role: 'assistant', content: 'Here is the code.' })).toBe(false);
    });
  });

  describe('shouldEmitStuck', () => {
    it('should return false if lastActivity is undefined', () => {
      expect(shouldEmitStuck(undefined, 10)).toBe(false);
    });

    it('should return false if lastActivity is invalid date', () => {
      expect(shouldEmitStuck('invalid', 10)).toBe(false);
    });

    it('should return true if elapsed time > threshold', () => {
      const now = Date.now();
      const lastActivity = new Date(now - 20 * 60 * 1000).toISOString(); // 20 mins ago
      // Mock Date.now to ensure consistency?
      // Or just rely on logic. 20 mins >= 10 mins -> true
      expect(shouldEmitStuck(lastActivity, 10)).toBe(true);
    });

    it('should return false if elapsed time < threshold', () => {
      const now = Date.now();
      const lastActivity = new Date(now - 5 * 60 * 1000).toISOString(); // 5 mins ago
      expect(shouldEmitStuck(lastActivity, 10)).toBe(false);
    });
  });

  describe('monitorOnce', () => {
    const apiBase = 'https://api.jules.ai';
    const token = 'test-token';
    const eventsPath = 'events.jsonl';
    const stuckMinutes = 10;

    it('should update status and emit event on completion', async () => {
      const jobs = [{ job_id: 'job-1' }];
      const state = {};

      // Mock status response: COMPLETED
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 'COMPLETED' }),
      });

      // Mock messages response (empty)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ messages: [] }),
      });

      await monitorOnce(jobs, state, apiBase, token, eventsPath, stuckMinutes);

      expect(fs.appendFile).toHaveBeenCalledWith(
        eventsPath,
        expect.stringContaining('"event":"completed"'),
        'utf8'
      );
      expect(state['job-1'].last_status).toBe('COMPLETED');
    });

    it('should detect stuck jobs', async () => {
      const jobs = [{ job_id: 'job-1' }];
      // Set last activity to be old
      const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      const state = {
        'job-1': { last_activity: oldTime, last_status: 'RUNNING' }
      };

      // Mock status response: RUNNING
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 'RUNNING' }),
      });

      // Mock messages response (empty)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ messages: [] }),
      });

      await monitorOnce(jobs, state, apiBase, token, eventsPath, stuckMinutes);

      expect(fs.appendFile).toHaveBeenCalledWith(
        eventsPath,
        expect.stringContaining('"event":"stuck"'),
        'utf8'
      );
    });

    it('should detect questions', async () => {
      const jobs = [{ job_id: 'job-1' }];
      const state = {};

      // Mock status response: WAITING_FOR_INPUT (or just running)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 'RUNNING' }),
      });

      // Mock messages response with a question
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          messages: [{ role: 'assistant', content: 'Do you want fries with that?', tags: ['question'] }]
        }),
      });

      await monitorOnce(jobs, state, apiBase, token, eventsPath, stuckMinutes);

      expect(fs.appendFile).toHaveBeenCalledWith(
        eventsPath,
        expect.stringContaining('"event":"question"'),
        'utf8'
      );
    });
  });
});
