# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SkillLens GitHub Action** is a TypeScript-based GitHub Action that analyzes PR review feedback and posts learning recommendations from Hyperskill. The action reads review comments from pull requests, sends them to a SkillLens Proxy backend, and creates/updates a single PR comment with relevant educational resources.

**Key Architecture**: This is a custom TypeScript Action built from the `actions/typescript-action` template. TypeScript sources in `src/` are bundled into a single JavaScript file in `dist/index.js` (which must be committed) so consumers don't need to install dependencies.

## Critical Workflow

**IMPORTANT**: The `dist/` directory contains generated JavaScript code that MUST be kept in sync with TypeScript sources. A GitHub Actions workflow validates this.

### Standard Development Flow

1. Make changes to TypeScript files in `src/`
2. Run `npm run bundle` to regenerate `dist/index.js`
3. Commit both the TypeScript changes AND the generated `dist/` files
4. When reviewing PRs: **do not review changes in `dist/`** — they mirror the TypeScript sources

## Essential Commands

```bash
# Install dependencies
npm install

# Run all checks (format, lint, test, coverage, bundle)
npm run all

# Bundle TypeScript to dist/index.js (MUST run after src/ changes)
npm run bundle

# Run tests
npm run test

# Run tests with coverage
npm run ci-test && npm run coverage

# Format code
npm run format:write

# Lint code
npm run lint

# Test locally with stubbed GitHub Actions environment
npm run local-action
# Requires .env file (see .env.example)
```

## Architecture & Data Flow

### High-Level Flow
1. **Trigger**: PR review events (`pull_request_review`, `pull_request_review_comment`, `issue_comment`)
2. **Fetch**: Use Octokit (via `@actions/github`) with `GITHUB_TOKEN` to fetch:
   - Inline review comments (`pulls.listReviewComments`)
   - PR reviews with state/body (`pulls.listReviews`)
   - Conversation comments (`issues.listComments`)
3. **Normalize**: Filter noisy comments
4. **Authenticate**: Request GitHub OIDC ID token (requires `id-token: write` permission)
5. **API Call**: POST to SkillLens Proxy with normalized reviews + OIDC token
6. **Comment**: Upsert single PR comment using marker (`<!-- SkillLens:v0 -->`) for idempotency

### Core Components

**`src/main.ts`**: Main entry point containing:
- `run()`: Main execution function called by GitHub Actions
- `listData()`: Fetches and normalizes all review data from GitHub API
- `isNoisy()`: Filters trivial comments (emoji-only, "LGTM", etc.)
- `upsertComment()`: Creates or updates the single SkillLens PR comment

**`action.yml`**: Action metadata defining:
- Inputs: `oidc-audience`, `default-language`, `max-topics`, `min-confidence`, `comment-marker`, `fail-on-proxy-error`, `enable-debug`
- Outputs: `topics-json`, `comment-url`
- Runtime: `node24` executing `dist/index.js`

## Testing

### Test Structure
- **Location**: `__tests__/` directory
- **Framework**: Jest with TypeScript support
- **Fixtures**: Place in `__fixtures__/` directory
- **Run**: `npm run test`

### Testing Guidelines
- Write tests for both success path and edge cases
- Mock Octokit responses for GitHub API calls
- Mock fetch responses for SkillLens Proxy API
- Ensure tests maintain coverage requirements
- After refactoring, always run `npm run test`

### Local Testing
Use `@github/local-action` to test without committing:
```bash
npx @github/local-action . src/main.ts .env
```
Create `.env` file based on `.env.example` to simulate GitHub Actions environment.

## Code Standards

### General Principles
- Follow TypeScript and JavaScript best practices
- Maintain consistency with existing patterns
- Keep functions focused and manageable
- Use descriptive names that convey purpose
- Document with JSDoc comments (focus on "why", not "what")
- Follow DRY principles
- Consider long-term maintainability

### TypeScript Specifics
- Use TypeScript's type system for safety and clarity
- Avoid `any` types where possible
- Export types that may be useful for testing

### Logging
- **Always** use `@actions/core` for logging (not `console`)
- Methods: `core.info()`, `core.warning()`, `core.setFailed()`, `core.debug()`
- Ensures compatibility with GitHub Actions logging features

### Error Handling
- Use consistent error handling patterns
- Respect `fail-on-proxy-error` input for proxy failures
- Use `core.setFailed()` for critical errors
- Use `core.warning()` for non-critical issues
- Exit gracefully when no data to process

## Permissions Required (for consumers)

Action consumers must grant these permissions in their workflow:
```yaml
permissions:
  contents: read          # Read repo metadata
  pull-requests: read     # Read PR reviews and comments
  issues: write           # Create/update PR comments (PRs use Issues API)
  id-token: write         # Request OIDC token
```

## Versioning

- Follow [Semantic Versioning](https://semver.org/)
- Update `package.json` version with each release
- Create release tags (e.g., `v1.0.0`)
- Move major tag (`v1`) to latest stable release
- Use `script/release` helper for tagging and pushing releases

## Pull Request Guidelines

### Before Creating PR
- Run `npm run all` to ensure all checks pass
- Ensure `dist/` is up-to-date with `src/` changes
- Update `README.md` if functionality/usage changed
- Update version in `package.json` if needed

### PR Content
- Keep changes focused and minimal
- Include summary of changes
- Note any dependency changes
- Link to relevant issues/discussions
- Provide context for reviewers

## Security Considerations

- Action uses built-in `GITHUB_TOKEN` (not user-provided secrets)
- OIDC token obtained via `core.getIDToken(audience)`
- Workflow must grant `id-token: write` permission
- No repository source code is accessed or transmitted
- Only review comments are processed

## Key Files Reference

| Path | Purpose |
|------|---------|
| `src/main.ts` | Core action logic (fetch, normalize, call API, post comment) |
| `src/index.ts` | Entry point that calls `run()` from main.ts |
| `action.yml` | Action metadata (inputs, outputs, branding) |
| `dist/index.js` | Bundled JavaScript (generated, must commit) |
| `__tests__/` | Jest test files |
| `rollup.config.ts` | Bundler configuration |
| `package.json` | Dependencies and scripts |
| `tsconfig.json` | TypeScript compiler configuration |
| `.env.example` | Template for local action testing |
| `SPEC.md` | Detailed specification document |

## Common Pitfalls

1. **Forgetting to bundle**: After changing `src/`, must run `npm run bundle` and commit `dist/`
2. **Reviewing dist/**: Don't review `dist/` changes in PRs — they mirror TypeScript sources
3. **Using console**: Use `@actions/core` logging methods instead of `console.log`
4. **Missing permissions**: Consumers need `id-token: write` for OIDC authentication
5. **Testing without mocks**: Mock GitHub API and proxy responses in tests

## Development Container

The repository includes a `.devcontainer/` configuration for consistent development environments using VS Code Dev Containers or GitHub Codespaces.
