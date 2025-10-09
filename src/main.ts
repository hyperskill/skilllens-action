import * as core from '@actions/core'
import * as github from '@actions/github'

const SKILLLENS_API_URL =
  'https://skilllens-25qt.onrender.com/v1/recommendations'

export type ReviewItem = {
  type: 'inline' | 'review' | 'conversation'
  body: string
  path?: string
  author?: string
  created_at: string
}

export function isNoisy(body: string): boolean {
  const trimmed = body.trim().toLowerCase()
  if (trimmed.length === 0) {
    core.debug('Filtered noisy comment: empty')
    return true
  }
  if (trimmed.length <= 5 && /^[👍👎✅❌🎉💯lgtm]+$/u.test(trimmed)) {
    core.debug(`Filtered noisy comment: "${trimmed}"`)
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
  core.debug(`Fetching review data for PR #${pr} in ${owner}/${repo}`)
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

  core.debug(
    `Fetched ${inline.data.length} inline comment(s), ${reviews.data.length} review(s), ${convo.data.length} conversation comment(s)`
  )

  const items: ReviewItem[] = []

  for (const comment of inline.data) {
    if (comment.body && !isNoisy(comment.body)) {
      items.push({
        type: 'inline',
        body: comment.body,
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
        body: review.body,
        author: review.user?.login,
        created_at: review.submitted_at ?? ''
      })
    }
  }

  for (const comment of convo.data) {
    if (comment.body && !isNoisy(comment.body)) {
      items.push({
        type: 'conversation',
        body: comment.body,
        author: comment.user?.login,
        created_at: comment.created_at
      })
    }
  }

  core.debug(
    `Returning ${items.length} non-noisy review item(s) after filtering`
  )
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
  core.debug(`Looking for existing comment with marker: ${marker}`)
  const existing = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pr,
    per_page: 100
  })
  const found = existing.data.find((c) => c.body?.includes(marker))

  // Add branded footer to the comment
  const brandedMarkdown = `${markdown}

---

<sub>🤖 Powered by [SkillLens](https://github.com/hyperskill/skilllens-action) • AI-driven learning recommendations from PR feedback</sub>`

  const fullBody = `${marker}\n\n${brandedMarkdown}`

  if (found) {
    core.debug(`Updating existing comment (ID: ${found.id})`)
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: found.id,
      body: fullBody
    })
    core.debug(`Updated comment URL: ${found.html_url}`)
    return found.html_url
  } else {
    core.debug('Creating new comment (no existing comment found)')
    const created = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr,
      body: fullBody
    })
    core.debug(`Created comment URL: ${created.data.html_url}`)
    return created.data.html_url
  }
}

export async function run(): Promise<void> {
  try {
    const { owner, repo } = github.context.repo
    const pr =
      github.context.payload.pull_request?.number ??
      github.context.payload.issue?.number

    core.debug(`Repository: ${owner}/${repo}`)
    core.debug(`PR number: ${pr ?? 'not found'}`)

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
      core.debug('No review content found after fetching and filtering')
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

    core.debug(`OIDC Audience: ${audience}`)
    core.debug(
      `Defaults: language=${defaults.language}, maxTopics=${defaults.maxTopics}, minConfidence=${defaults.minConfidence}`
    )
    core.debug(`Fail on proxy error: ${failOnProxyError}`)

    core.debug(`Calling SkillLens API with ${items.length} review item(s)`)

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
      core.debug(msg)
      if (failOnProxyError) {
        core.setFailed(msg)
        return
      }
      core.warning(msg)
      return
    }

    core.debug(`API response status: ${resp.status}`)
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

    core.debug(`API returned ${data.topics?.length ?? 0} topic(s)`)
    core.debug(
      `Comment markdown length: ${data.commentMarkdown?.length ?? 0} chars`
    )

    if (!data.commentMarkdown) {
      core.debug('No comment markdown in API response')
      core.info('Proxy returned no commentMarkdown; nothing to post.')
      return
    }

    const marker = core.getInput('comment-marker')
    core.debug(`Upserting comment with marker: ${marker}`)

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

    core.debug('Action completed successfully')
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}
