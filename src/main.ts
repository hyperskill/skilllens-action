import * as core from '@actions/core'
import * as github from '@actions/github'

const SKILLLENS_API_URL = 'https://api.skilllens.dev/v1/recommendations'

let debugEnabled = false

function debug(message: string): void {
  if (debugEnabled) {
    core.debug(message)
  }
}

export type ReviewItem = {
  type: 'inline' | 'review' | 'conversation'
  body: string
  path?: string
  author?: string
  created_at: string
}

export function redactCodeFences(body: string, max = 200): string {
  let trimCount = 0
  const result = body.replace(/```([\s\S]*?)```/g, (_m, p1) => {
    const s = String(p1)
    if (s.length > max) {
      trimCount++
      return '```' + s.slice(0, max) + '…' + '```'
    }
    return '```' + s + '```'
  })
  if (trimCount > 0) {
    debug(`Trimmed ${trimCount} code fence(s) exceeding ${max} chars`)
  }
  return result
}

export function isNoisy(body: string): boolean {
  const trimmed = body.trim().toLowerCase()
  if (trimmed.length === 0) {
    debug('Filtered noisy comment: empty')
    return true
  }
  if (trimmed.length <= 5 && /^[👍👎✅❌🎉💯lgtm]+$/u.test(trimmed)) {
    debug(`Filtered noisy comment: "${trimmed}"`)
    return true
  }
  return false
}

export async function listData(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pr: number
): Promise<ReviewItem[]> {
  debug(`Fetching review data for PR #${pr} in ${owner}/${repo}`)
  const [inline, reviews, convo] = await Promise.all([
    octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: pr,
      per_page: 100
    }),
    octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pr,
      per_page: 100
    }),
    octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pr,
      per_page: 100
    })
  ])

  debug(
    `Fetched ${inline.data.length} inline comment(s), ${reviews.data.length} review(s), ${convo.data.length} conversation comment(s)`
  )

  const items: ReviewItem[] = []

  for (const comment of inline.data) {
    if (comment.body && !isNoisy(comment.body)) {
      items.push({
        type: 'inline',
        body: redactCodeFences(comment.body),
        path: comment.path,
        author: comment.user?.login,
        created_at: comment.created_at
      })
    }
  }

  for (const review of reviews.data) {
    if (review.body && !isNoisy(review.body)) {
      items.push({
        type: 'review',
        body: redactCodeFences(review.body),
        author: review.user?.login,
        created_at: review.submitted_at || ''
      })
    }
  }

  for (const comment of convo.data) {
    if (comment.body && !isNoisy(comment.body)) {
      items.push({
        type: 'conversation',
        body: redactCodeFences(comment.body),
        author: comment.user?.login,
        created_at: comment.created_at
      })
    }
  }

  debug(`Returning ${items.length} non-noisy review item(s) after filtering`)
  return items
}

export async function upsertComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pr: number,
  marker: string,
  markdown: string
): Promise<string> {
  debug(`Looking for existing comment with marker: ${marker}`)
  const existing = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pr,
    per_page: 100
  })
  const found = existing.data.find((c) => c.body?.includes(marker))

  const fullBody = `${marker}\n\n${markdown}`

  if (found) {
    debug(`Updating existing comment (ID: ${found.id})`)
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: found.id,
      body: fullBody
    })
    debug(`Updated comment URL: ${found.html_url}`)
    return found.html_url
  } else {
    debug('Creating new comment (no existing comment found)')
    const created = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr,
      body: fullBody
    })
    debug(`Created comment URL: ${created.data.html_url}`)
    return created.data.html_url
  }
}

export async function run(): Promise<void> {
  try {
    debugEnabled = core.getInput('enable-debug') === 'true'
    debug('Debug logging enabled')

    const { owner, repo } = github.context.repo
    const pr =
      github.context.payload.pull_request?.number ??
      github.context.payload.issue?.number

    debug(`Repository: ${owner}/${repo}`)
    debug(`PR number: ${pr ?? 'not found'}`)

    if (!pr) {
      core.info('No PR number found in context; exiting.')
      return
    }

    const token = process.env.GITHUB_TOKEN || core.getInput('github-token')
    if (!token) {
      core.setFailed('GITHUB_TOKEN is required')
      return
    }

    const octokit = github.getOctokit(token)

    const items = await listData(octokit, owner, repo, pr)
    if (items.length === 0) {
      debug('No review content found after fetching and filtering')
      core.info('No review content to analyze; exiting.')
      return
    }

    const audience = core.getInput('oidc-audience')
    const idToken = await core.getIDToken(audience)

    const defaults = {
      language: core.getInput('default-language'),
      maxTopics: Number(core.getInput('max-topics')),
      minConfidence: Number(core.getInput('min-confidence'))
    }

    const failOnProxyError = core.getInput('fail-on-proxy-error') === 'true'

    debug(`OIDC Audience: ${audience}`)
    debug(
      `Defaults: language=${defaults.language}, maxTopics=${defaults.maxTopics}, minConfidence=${defaults.minConfidence}`
    )
    debug(`Fail on proxy error: ${failOnProxyError}`)

    debug(`Calling SkillLens API with ${items.length} review item(s)`)

    let resp: Response
    try {
      resp = await fetch(SKILLLENS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({
          repo: { owner, name: repo, prNumber: pr },
          reviews: items,
          defaults
        })
      })
    } catch (fetchError) {
      const msg = `Network error calling SkillLens API: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
      debug(msg)
      if (failOnProxyError) {
        core.setFailed(msg)
        return
      }
      core.warning(msg)
      return
    }

    debug(`API response status: ${resp.status}`)
    if (!resp.ok) {
      const msg = `Proxy error ${resp.status}: ${await resp.text()}`
      if (failOnProxyError) {
        core.setFailed(msg)
        return
      }
      core.warning(msg)
      return
    }

    const data = (await resp.json()) as {
      topics: unknown[]
      commentMarkdown: string
    }

    debug(`API returned ${data.topics?.length ?? 0} topic(s)`)
    debug(`Comment markdown length: ${data.commentMarkdown?.length ?? 0} chars`)

    if (!data.commentMarkdown) {
      debug('No comment markdown in API response')
      core.info('Proxy returned no commentMarkdown; nothing to post.')
      return
    }

    const marker = core.getInput('comment-marker')
    debug(`Upserting comment with marker: ${marker}`)

    const url = await upsertComment(
      octokit,
      owner,
      repo,
      pr,
      marker,
      data.commentMarkdown
    )

    core.setOutput('topics-json', JSON.stringify(data.topics ?? []))
    core.setOutput('comment-url', url)

    debug('Action completed successfully')
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}
