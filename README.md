# Workflow Concurrency Validator
This GitHub Action validates that the concurrency usage across workflows in a repository does not exceed a specified limit. It helps prevent abuse of GitHub's concurrent job limits by analyzing workflow files and detecting potential parallel execution.

## What it checks
- Top-level concurrency settings in workflows
- Job-level concurrency settings
- Implicit concurrency from jobs that run in parallel (no dependencies)
- Matrix job combinations
- Jobs within the same workflow run that can execute in parallel

## Important Notes
- Jobs within the same workflow run can execute in parallel even with `cancel-in-progress: true`
- `cancel-in-progress` only affects concurrent workflow runs, not jobs within the same workflow
- Matrix jobs are counted by their total number of combinations
- Dependencies between jobs (`needs:`) are properly analyzed to identify truly parallel execution paths

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
This action is written in TypeScript and uses [@vercel/ncc](https://github.com/vercel/ncc) to bundle all dependencies into a single file.

### Setting Up Development Environment
1. Install dependencies:
   ```bash
   npm install
   ```
2. Install development dependencies:
   ```bash
   npm install --save-dev @vercel/ncc
   ```

### Development Workflow
1. Make changes to files in the `src/` directory
2. Run type checking:
   ```bash
   npm run type-check
   ```
3. Run tests:
   ```bash
   npm test
   ```
4. Build the bundled version:
   ```bash
   npm run build
   ```
5. Commit your changes, including the updated `dist/index.js` file

### TypeScript Implementation Details
The action's core functionality is implemented with the following TypeScript interfaces:
- `WorkflowConcurrency`: Defines the structure of concurrency settings
- `WorkflowJob`: Represents a job in a workflow file
- `WorkflowFile`: Describes the overall workflow file structure
- `ConcurrencyDetail`: Contains detailed information about concurrency usage

### Output Format Examples
The action provides detailed output in JSON format. Here are examples of the output structure:

#### Details Output
```json
[
  {
    "file": ".github/workflows/build.yml",
    "level": "workflow",
    "type": "standard",
    "counted": true
  },
  {
    "file": ".github/workflows/test.yml",
    "level": "workflow",
    "type": "cancel-in-progress",
    "counted": false,
    "note": "Only affects concurrent workflow runs"
  },
  {
    "file": ".github/workflows/matrix.yml",
    "level": "implicit",
    "jobs": ["test"],
    "count": 6,
    "counted": true,
    "note": "Matrix job with 6 combinations"
  },
  {
    "file": ".github/workflows/deploy.yml",
    "level": "implicit",
    "jobs": ["deploy-staging", "deploy-prod"],
    "count": 2,
    "counted": true,
    "note": "Jobs running in parallel"
  }
]
```

### Issues Output
```json
[
  "Error processing .github/workflows/invalid.yml: Unexpected token in YAML",
  "Total concurrency (12) exceeds maximum allowed (10)"
]
```

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

### Debugging TypeScript Issues
1. Check the TypeScript configuration in `tsconfig.json`
2. Run `npm run type-check` to verify types
3. Ensure all imported modules have proper type definitions
4. Check the `lib` directory for compiled JavaScript files

### Understanding Concurrency Detection
The action detects concurrency in several ways:

1. **Explicit workflow-level concurrency**: Set via `concurrency:` at the workflow root
   - Simple string format: `concurrency: group1`
   - Object format with cancel-in-progress: 
     ```yaml
     concurrency:
       group: build-group
       cancel-in-progress: true
     ```
   Note: cancel-in-progress only affects concurrent workflow runs, not jobs within the same workflow

2. **Explicit job-level concurrency**: Set via `concurrency:` in individual jobs
   ```yaml
   jobs:
     job1:
       concurrency: group1
     job2:
       concurrency: group2
   ```

3. **Implicit parallel jobs**: Jobs that can run in parallel based on:
   - No `needs:` dependencies between them
   - Being in the same dependency level
   Example:
   ```yaml
   jobs:
     build:
       runs-on: ubuntu-latest
       steps: [...]
     test:
       runs-on: ubuntu-latest
       steps: [...]
     deploy:
       needs: [build, test]
       runs-on: ubuntu-latest
       steps: [...]
   ```
   Here, `build` and `test` can run in parallel (count: 2), while `deploy` runs after them (different level)

4. **Matrix jobs**: Count based on total combinations
   ```yaml
   jobs:
     test:
       strategy:
         matrix:
           os: [ubuntu, windows, macos]
           node: [14, 16]
       runs-on: ${{ matrix.os }}
       steps: [...]
   ```
   This counts as 6 concurrent jobs (3 OS × 2 Node.js versions)

#### Example Concurrency Calculations

1. Simple workflow with two parallel jobs:
   ```yaml
   jobs:
     job1:
       runs-on: ubuntu-latest
     job2:
       runs-on: ubuntu-latest
   ```
   Total concurrency: 2 (both jobs can run in parallel)

2. Workflow with cancel-in-progress and parallel jobs:
   ```yaml
   concurrency:
     group: build
     cancel-in-progress: true
   jobs:
     job1:
       runs-on: ubuntu-latest
     job2:
       runs-on: ubuntu-latest
   ```
   Total concurrency: 2 (jobs can still run in parallel within the same workflow)

3. Matrix job with dependencies:
   ```yaml
   jobs:
     test:
       strategy:
         matrix:
           os: [ubuntu, windows]
           node: [14, 16]
     deploy:
       needs: [test]
   ```
   Total concurrency: 4 (2 OS × 2 Node.js versions in parallel, deploy runs after)

## How to Contribute

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.