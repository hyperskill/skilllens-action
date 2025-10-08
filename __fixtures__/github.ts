import type * as github from '@actions/github'
import { jest } from '@jest/globals'

export const context = {
  repo: { owner: 'test-owner', repo: 'test-repo' },
  payload: {
    pull_request: { number: 123 }
  }
}

export const getOctokit = jest.fn(() => ({
  rest: {
    pulls: {
      listReviewComments: jest.fn(),
      listReviews: jest.fn()
    },
    issues: {
      listComments: jest.fn(),
      createComment: jest.fn(),
      updateComment: jest.fn()
    }
  }
})) as unknown as typeof github.getOctokit
