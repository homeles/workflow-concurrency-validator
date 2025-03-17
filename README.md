# Workflow Concurrency Validator

This GitHub Action validates that the concurrency usage across workflows in a repository does not exceed a specified limit. It helps prevent abuse of GitHub's concurrent job limits by analyzing workflow files and detecting potential parallel execution.

## What it checks

- Top-level concurrency settings in workflows
- Job-level concurrency settings
- Implicit concurrency from jobs that run in parallel (no dependencies)
- Respects `cancel-in-progress: true` which doesn't count toward concurrency limits

## Installation

This action uses a bundled approach for dependencies, which makes it more reliable and faster.

## Usage Options

You can use this tool in two ways:
1. As a GitHub Action directly in your workflow
2. As a reusable workflow that can be called from other workflows

### Option 1: Setting up the Action in your Repository

Add the following to your workflow:

```yaml
jobs:
  validate-concurrency:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3
        
      - name: Validate Workflow Concurrency
        uses: homeles/workflow-concurrency-validator@v1
        with:
          max-concurrency: '10'  # Optional, defaults to 10
          workflow-path: '.github/workflows'  # Optional
          fail-on-error: 'true'  # Optional
          comment-on-pr: 'true'  # Optional
```

#### Example Workflow

Create a file `.github/workflows/validate-concurrency.yml`:

```yaml
name: Validate Workflow Concurrency

on:
  pull_request:
    paths:
      - '.github/workflows/**'
  push:
    branches:
      - main
    paths:
      - '.github/workflows/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3
        
      - name: Validate Workflow Concurrency
        uses: homeles/workflow-concurrency-validator@v1
        with:
          max-concurrency: '10'
          comment-on-pr: 'true'
```

### Option 2: Using as a Reusable Workflow

You can also set this up as a reusable workflow that can be called from other workflows.

#### Create the Reusable Workflow

First, create a file `.github/workflows/concurrency-validator-reusable.yml` in your repository:

```yaml
name: Reusable Concurrency Validator

on:
  workflow_call:
    inputs:
      max-concurrency:
        description: 'Maximum allowed concurrency across all workflows'
        required: false
        type: number
        default: 10
      workflow-path:
        description: 'Path to the workflows directory'
        required: false
        type: string
        default: '.github/workflows'
      fail-on-error:
        description: 'Whether to fail the workflow if validation fails'
        required: false
        type: boolean
        default: true
      comment-on-pr:
        description: 'Whether to comment on PR if validation fails'
        required: false
        type: boolean
        default: true
    outputs:
      total-concurrency:
        description: 'Total concurrency detected across workflows'
        value: ${{ jobs.validate.outputs.total-concurrency }}
      validation-passed:
        description: 'Whether validation passed'
        value: ${{ jobs.validate.outputs.validation-passed }}
    secrets:
      token:
        description: 'GitHub token for commenting on PRs'
        required: false

jobs:
  validate:
    runs-on: ubuntu-latest
    outputs:
      total-concurrency: ${{ steps.validate.outputs.total_concurrency }}
      validation-passed: ${{ steps.validate.outputs.validation_passed }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v3
        
      - name: Validate Workflow Concurrency
        id: validate
        uses: homeles/workflow-concurrency-validator@v1
        with:
          max-concurrency: ${{ inputs.max-concurrency }}
          workflow-path: ${{ inputs.workflow-path }}
          fail-on-error: ${{ inputs.fail-on-error }}
          comment-on-pr: ${{ inputs.comment-on-pr }}
          token: ${{ secrets.token || github.token }}
```

#### Call the Reusable Workflow

Then, you can call this workflow from another workflow:

```yaml
name: PR Checks

on:
  pull_request:
    paths:
      - '.github/workflows/**'

jobs:
  validate-concurrency:
    uses: ./.github/workflows/concurrency-validator-reusable.yml
    with:
      max-concurrency: 10
      comment-on-pr: true
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
      
  # Add other jobs that depend on the validation result
  additional-checks:
    needs: validate-concurrency
    if: needs.validate-concurrency.outputs.validation-passed == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Run additional checks
        run: echo "Running additional checks because concurrency validation passed"
```

## Inputs

| Input | Description | Required | Default |
| ----- | ----------- | -------- | ------- |
| `max-concurrency` | Maximum allowed concurrency across all workflows | No | `10` |
| `workflow-path` | Path to the workflows directory | No | `.github/workflows` |
| `fail-on-error` | Whether to fail the action if validation fails | No | `true` |
| `comment-on-pr` | Whether to comment on PR if validation fails | No | `true` |
| `token` | GitHub token for commenting on PRs | No | `${{ github.token }}` |

## Outputs

| Output | Description |
| ------ | ----------- |
| `total-concurrency` | Total concurrency detected across workflows |
| `validation-passed` | Whether validation passed (`true` or `false`) |
| `issues` | JSON array of issues found during validation |
| `details` | JSON object with detailed information about concurrency usage |

## Development and Building

This action uses [@vercel/ncc](https://github.com/vercel/ncc) to bundle all dependencies into a single file. If you make changes to the action, follow these steps to rebuild it:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Install development dependencies:
   ```bash
   npm install --save-dev @vercel/ncc
   ```

3. Make your changes to `validate-concurrency.js`

4. Build the bundled version:
   ```bash
   npm run build
   ```

5. Commit your changes, including the updated `dist/index.js` file

## Testing

You can test the action with various workflow patterns. The repository includes several example workflow files that demonstrate different concurrency patterns:

- Simple parallel jobs
- Jobs with dependencies
- Workflow-level concurrency
- Job-level concurrency
- Matrix workflows
- Cancel-in-progress workflows

Place these test files in your `.github/workflows/` directory to test the validation logic.

## Advanced Configuration

### Branch Protection Rules

To prevent merging PRs that would violate the concurrency limit, set up a [branch protection rule](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches) that requires the validation check to pass.

### Slack/Teams Notifications

You can enhance the action by adding notifications to Slack or Teams when validation fails:

```yaml
- name: Notify Slack
  if: steps.validate.outputs.validation_passed == 'false'
  uses: slackapi/slack-github-action@v1
  with:
    payload: |
      {
        "text": "⚠️ Workflow concurrency validation failed: ${{ steps.validate.outputs.total_concurrency }} exceeds limit of ${{ inputs.max-concurrency }}"
      }
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## Troubleshooting

### Dependencies Issues

This action uses a bundled approach to avoid dependency issues. If you encounter any problems:

1. Make sure you're using the latest version of the action
2. Check that the `dist/index.js` file is included in your repository
3. Verify the Node.js version in your workflow (Node.js 16+ is recommended)

### Output Not Working

The action uses the modern GitHub Actions output method with environment files. If you're seeing warnings about deprecated commands, make sure you're using the latest version of the action.

## How to Contribute

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.