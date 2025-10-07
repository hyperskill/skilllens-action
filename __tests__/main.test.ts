/**
 * Unit tests for the action's main functionality, src/main.ts
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as github from '../__fixtures__/github.js'

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => github)

const { run, redactCodeFences, isNoisy, listData, upsertComment } =
  await import('../src/main.js')

describe('main.ts', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    process.env.GITHUB_TOKEN = 'test-token'

    github.context.repo = { owner: 'test-owner', repo: 'test-repo' }
    github.context.payload = { pull_request: { number: 123 } }

    core.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'skilllens-api-url': 'https://api.test.com/v1/recommendations',
        'oidc-audience': 'skilllens.dev',
        'default-language': 'Python',
        'max-topics': '5',
        'min-confidence': '0.65',
        'comment-marker': '<!-- SkillLens:v0 -->',
        'fail-on-proxy-error': 'false'
      }
      return inputs[name] || ''
    })

    core.getIDToken.mockResolvedValue('test-id-token')
  })

  afterEach(() => {
    delete process.env.GITHUB_TOKEN
  })

  describe('redactCodeFences', () => {
    it('Trims long code blocks', () => {
      const input = '```' + 'x'.repeat(300) + '```'
      const result = redactCodeFences(input, 200)
      expect(result).toContain('…')
      expect(result.length).toBeLessThan(input.length)
    })

    it('Leaves short code blocks unchanged', () => {
      const input = '```console\necho "hello"\n```'
      const result = redactCodeFences(input, 200)
      expect(result).toBe(input)
    })
  })

  describe('isNoisy', () => {
    it('Identifies empty strings as noisy', () => {
      expect(isNoisy('')).toBe(true)
      expect(isNoisy('   ')).toBe(true)
    })

    it('Identifies emoji-only comments as noisy', () => {
      expect(isNoisy('👍')).toBe(true)
      expect(isNoisy('✅')).toBe(true)
      expect(isNoisy('lgtm')).toBe(true)
    })

    it('Identifies substantial comments as not noisy', () => {
      expect(isNoisy('This needs improvement')).toBe(false)
      expect(isNoisy('Please refactor this function')).toBe(false)
    })
  })

  describe('listData', () => {
    it('Fetches and normalizes review data', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockResolvedValue({
              data: [
                {
                  body: 'Inline comment',
                  path: 'src/file.ts',
                  user: { login: 'reviewer1' },
                  created_at: '2023-01-01T00:00:00Z'
                }
              ]
            }),
            listReviews: jest.fn().mockResolvedValue({
              data: [
                {
                  body: 'Review body',
                  user: { login: 'reviewer2' },
                  submitted_at: '2023-01-01T00:00:00Z'
                }
              ]
            })
          },
          issues: {
            listComments: jest.fn().mockResolvedValue({
              data: [
                {
                  body: 'Conversation comment',
                  user: { login: 'commenter1' },
                  created_at: '2023-01-01T00:00:00Z'
                }
              ]
            })
          }
        }
      } as ReturnType<typeof github.getOctokit>

      const items = await listData(mockOctokit, 'owner', 'repo', 123)

      expect(items).toHaveLength(3)
      expect(items[0].type).toBe('inline')
      expect(items[1].type).toBe('review')
      expect(items[2].type).toBe('conversation')
    })

    it('Filters out noisy comments', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockResolvedValue({
              data: [
                {
                  body: 'LGTM',
                  path: 'src/file.ts',
                  user: { login: 'reviewer1' },
                  created_at: '2023-01-01T00:00:00Z'
                }
              ]
            }),
            listReviews: jest.fn().mockResolvedValue({ data: [] })
          },
          issues: {
            listComments: jest.fn().mockResolvedValue({ data: [] })
          }
        }
      } as ReturnType<typeof github.getOctokit>

      const items = await listData(mockOctokit, 'owner', 'repo', 123)

      expect(items).toHaveLength(0)
    })
  })

  describe('upsertComment', () => {
    it('Creates new comment when none exists', async () => {
      const mockOctokit = {
        rest: {
          issues: {
            listComments: jest.fn().mockResolvedValue({ data: [] }),
            createComment: jest.fn().mockResolvedValue({
              data: { html_url: 'https://github.com/test/comment/1' }
            })
          }
        }
      } as ReturnType<typeof github.getOctokit>

      const url = await upsertComment(
        mockOctokit,
        'owner',
        'repo',
        123,
        '<!-- marker -->',
        'content'
      )

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled()
      expect(url).toBe('https://github.com/test/comment/1')
    })

    it('Updates existing comment when marker found', async () => {
      const mockOctokit = {
        rest: {
          issues: {
            listComments: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 456,
                  body: '<!-- marker -->\nOld content',
                  html_url: 'https://github.com/test/comment/456'
                }
              ]
            }),
            updateComment: jest.fn().mockResolvedValue({ data: {} })
          }
        }
      } as ReturnType<typeof github.getOctokit>

      const url = await upsertComment(
        mockOctokit,
        'owner',
        'repo',
        123,
        '<!-- marker -->',
        'new content'
      )

      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 456,
        body: '<!-- marker -->\n\nnew content'
      })
      expect(url).toBe('https://github.com/test/comment/456')
    })
  })

  describe('run', () => {
    let mockFetch: jest.Mock

    beforeEach(() => {
      mockFetch = jest.fn() as jest.Mock
      global.fetch = mockFetch

      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockResolvedValue({
              data: [
                {
                  body: 'Review comment',
                  path: 'src/file.ts',
                  user: { login: 'reviewer' },
                  created_at: '2023-01-01T00:00:00Z'
                }
              ]
            }),
            listReviews: jest.fn().mockResolvedValue({ data: [] })
          },
          issues: {
            listComments: jest.fn().mockResolvedValue({ data: [] }),
            createComment: jest.fn().mockResolvedValue({
              data: { html_url: 'https://github.com/test/comment/1' }
            })
          }
        }
      }

      github.getOctokit.mockReturnValue(
        mockOctokit as ReturnType<typeof github.getOctokit>
      )
    })

    it('Exits early when no PR number found', async () => {
      github.context.payload = {}

      await run()

      expect(core.info).toHaveBeenCalledWith(
        'No PR number found in context; exiting.'
      )
    })

    it('Exits early when no review content found', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            listReviewComments: jest.fn().mockResolvedValue({ data: [] }),
            listReviews: jest.fn().mockResolvedValue({ data: [] })
          },
          issues: {
            listComments: jest.fn().mockResolvedValue({ data: [] })
          }
        }
      }

      github.getOctokit.mockReturnValue(
        mockOctokit as ReturnType<typeof github.getOctokit>
      )

      await run()

      expect(core.info).toHaveBeenCalledWith(
        'No review content to analyze; exiting.'
      )
    })

    it('Calls proxy and creates comment on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          topics: [{ name: 'Python Basics' }],
          commentMarkdown: '## Learning Resources\n\nCheck out these topics!'
        })
      })

      await run()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/v1/recommendations',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-id-token'
          })
        })
      )

      expect(core.setOutput).toHaveBeenCalledWith(
        'topics-json',
        expect.any(String)
      )
      expect(core.setOutput).toHaveBeenCalledWith(
        'comment-url',
        'https://github.com/test/comment/1'
      )
    })

    it('Handles proxy error with warning when fail-on-proxy-error is false', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error'
      })

      await run()

      expect(core.warning).toHaveBeenCalledWith(
        'Proxy error 500: Internal server error'
      )
      expect(core.setFailed).not.toHaveBeenCalled()
    })

    it('Fails workflow when proxy error and fail-on-proxy-error is true', async () => {
      core.getInput.mockImplementation((name: string) => {
        if (name === 'fail-on-proxy-error') return 'true'
        if (name === 'skilllens-api-url')
          return 'https://api.test.com/v1/recommendations'
        return ''
      })

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error'
      })

      await run()

      expect(core.setFailed).toHaveBeenCalledWith(
        'Proxy error 500: Internal server error'
      )
    })

    it('Exits when proxy returns no commentMarkdown', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          topics: [],
          commentMarkdown: ''
        })
      })

      await run()

      expect(core.info).toHaveBeenCalledWith(
        'Proxy returned no commentMarkdown; nothing to post.'
      )
      expect(core.setOutput).not.toHaveBeenCalled()
    })

    it('Handles errors and sets failed status', async () => {
      github.getOctokit.mockImplementation(() => {
        throw new Error('Octokit initialization failed')
      })

      await run()

      expect(core.setFailed).toHaveBeenCalledWith(
        'Octokit initialization failed'
      )
    })
  })
})
