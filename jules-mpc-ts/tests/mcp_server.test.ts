import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildHeaders,
  urlJoin,
  createJob,
  getJob,
  getMessages,
  sendMessage,
  getArtifacts,
  requestRetry,
  mergePr,
  cancelJob,
  listJobs,
  API_BASE,
  DEFAULT_API_BASE
} from '../mcp-server/jules_mcp_server.js';

// Mock fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('jules_mcp_server', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildHeaders', () => {
    it('should include Accept header', () => {
      const headers = buildHeaders();
      expect(headers).toHaveProperty('Accept', 'application/json');
    });

    // Note: API_TOKEN is read at module load time, so we can't easily toggle it here
    // without re-importing the module. We assume it captures whatever was in env
    // or undefined.
  });

  describe('urlJoin', () => {
    it('should join base URL and path', () => {
      // API_BASE might differ based on env, but we check logic relative to it
      const base = API_BASE.replace(/\/$/, "");
      expect(urlJoin('jobs')).toBe(`${base}/jobs`);
    });

    it('should handle leading slash in path', () => {
      const base = API_BASE.replace(/\/$/, "");
      expect(urlJoin('/jobs')).toBe(`${base}/jobs`);
    });
  });

  describe('API wrappers', () => {
    const mockResponse = (data: any, ok = true, status = 200) => {
      fetchMock.mockResolvedValue({
        ok,
        status,
        text: async () => data ? JSON.stringify(data) : '',
      });
    };

    it('createJob should POST to /jobs', async () => {
      mockResponse({ id: 'job-123' });
      const payload = { repo: 'owner/repo', prompt: 'do it' };

      const result = await createJob(payload);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/jobs$/),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload)
        })
      );
      expect(result).toEqual({ id: 'job-123' });
    });

    it('getJob should GET /jobs/:id', async () => {
      mockResponse({ id: 'job-123', status: 'PENDING' });

      const result = await getJob('job-123');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/jobs\/job-123$/),
        expect.any(Object)
      );
      expect(result).toEqual({ id: 'job-123', status: 'PENDING' });
    });

    it('getMessages should GET /jobs/:id/messages', async () => {
      mockResponse({ messages: [] });

      await getMessages('job-123');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/jobs\/job-123\/messages$/),
        expect.any(Object)
      );
    });

    it('getMessages should append cursor if provided', async () => {
      mockResponse({ messages: [] });

      await getMessages('job-123', 'next-page');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/jobs\/job-123\/messages\?cursor=next-page$/),
        expect.any(Object)
      );
    });

    it('sendMessage should POST to /jobs/:id/messages', async () => {
      mockResponse({ id: 'msg-1' });
      const message = { role: 'user', content: 'hello' };

      await sendMessage('job-123', message);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/jobs\/job-123\/messages$/),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(message)
        })
      );
    });

    it('getArtifacts should GET /jobs/:id/artifacts', async () => {
      mockResponse({ files: [] });

      await getArtifacts('job-123');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/jobs\/job-123\/artifacts$/),
        expect.any(Object)
      );
    });

    it('requestRetry should POST to /jobs/:id:retry', async () => {
      mockResponse({ status: 'RETRYING' });

      await requestRetry('job-123');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/jobs\/job-123:retry$/),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('mergePr should POST to /jobs/:id:merge', async () => {
      mockResponse({ merged: true });
      const payload = { strategy: 'squash' };

      await mergePr('job-123', payload);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/jobs\/job-123:merge$/),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(payload)
        })
      );
    });

    it('cancelJob should POST to /jobs/:id:cancel', async () => {
      mockResponse({ status: 'CANCELLED' });

      await cancelJob('job-123');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/jobs\/job-123:cancel$/),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('listJobs should GET /jobs with query params', async () => {
      mockResponse({ jobs: [] });

      await listJobs('owner/repo', 10);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('repo=owner%2Frepo'),
        expect.any(Object)
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('limit=10'),
        expect.any(Object)
      );
    });

    it('should throw error on non-ok response', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      await expect(getJob('invalid-id')).rejects.toThrow('HTTP 404');
    });
  });
});
