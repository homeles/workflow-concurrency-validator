import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Workflow Concurrency Validator', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'));
  const workflowDir = path.join(tmpDir, '.github', 'workflows');
  const outputFile = path.join(tmpDir, 'github-output');
  const validatorPath = require.resolve('../validate-concurrency');

  beforeAll(() => {
    fs.mkdirSync(workflowDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Reset environment variables
    process.env.GITHUB_WORKSPACE = tmpDir;
    process.env.GITHUB_OUTPUT = outputFile;
    delete process.env.INPUT_MAX_CONCURRENCY;
    delete process.env.INPUT_WORKFLOW_PATH;
    delete process.env.INPUT_FAIL_ON_ERROR;
    delete process.env.INPUT_COMMENT_ON_PR;

    // Clear workflow directory
    fs.readdirSync(workflowDir).forEach(file => {
      fs.unlinkSync(path.join(workflowDir, file));
    });

    // Reset output file
    fs.writeFileSync(outputFile, '', { mode: 0o666 });

    // Clear require cache
    jest.resetModules();
  });

  function getGitHubOutput(): string {
    return fs.readFileSync(outputFile, 'utf8');
  }

  // Helper to run validator in isolation
  async function runValidator() {
    jest.isolateModules(() => {
      require('../validate-concurrency');
    });
    // Give file system a moment to write
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  test('validates workflow with parallel jobs', async () => {
    const workflow = `
name: Test Workflow
on: push
jobs:
  test1:
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"
  test2:
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"
`;
    fs.writeFileSync(path.join(workflowDir, 'test1.yml'), workflow);
    
    await runValidator();
    
    const output = getGitHubOutput();
    expect(JSON.parse(output.match(/workflow_results<<.*\n(.*)\n/)?.[1] || '')[0]).toEqual(
      expect.objectContaining({
        file: '.github/workflows/test1.yml',
        concurrencyCount: 2,
        passed: true
      })
    );
    expect(output).toMatch(/validation_passed<<.*\ntrue\n/);
    expect(output).toMatch(/total_concurrency<<.*\n0\n/);
  });

  test('validates implicit concurrency from parallel jobs', async () => {
    const workflow = `
name: Test Workflow
on: push
jobs:
  test1:
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"
  test2:
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"
  test3:
    runs-on: ubuntu-latest
    needs: [test1]
    steps:
      - run: echo "test"
`;
    fs.writeFileSync(path.join(workflowDir, 'test2.yml'), workflow);
    
    await runValidator();
    
    const output = getGitHubOutput();
    expect(JSON.parse(output.match(/workflow_results<<.*\n(.*)\n/)?.[1] || '')[0]).toEqual(
      expect.objectContaining({
        file: '.github/workflows/test2.yml',
        concurrencyCount: 2,
        passed: true
      })
    );
    expect(output).toMatch(/validation_passed<<.*\ntrue\n/);
    expect(output).toMatch(/total_concurrency<<.*\n0\n/);
  });

  test('fails when a single workflow exceeds max concurrency', async () => {
    process.env.INPUT_MAX_CONCURRENCY = '1';
    
    const workflow = `
name: Test Workflow
on: push
jobs:
  test1:
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"
  test2:
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"
`;
    fs.writeFileSync(path.join(workflowDir, 'test3.yml'), workflow);
    
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    
    await runValidator();
    
    const output = getGitHubOutput();
    expect(JSON.parse(output.match(/workflow_results<<.*\n(.*)\n/)?.[1] || '')[0]).toEqual(
      expect.objectContaining({
        file: '.github/workflows/test3.yml',
        concurrencyCount: 2,
        passed: false
      })
    );
    expect(output).toMatch(/validation_passed<<.*\nfalse\n/);
    expect(output).toMatch(/total_concurrency<<.*\n0\n/);
    expect(mockExit).toHaveBeenCalledWith(1);
    
    mockExit.mockRestore();
  });

  test('validates multiple workflows independently', async () => {
    const workflow1 = `
name: Workflow 1
on: push
jobs:
  test1:
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"
`;

    const workflow2 = `
name: Workflow 2
on: push
jobs:
  test1:
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"
  test2:
    runs-on: ubuntu-latest
    steps:
      - run: echo "test"
`;

    fs.writeFileSync(path.join(workflowDir, 'workflow1.yml'), workflow1);
    fs.writeFileSync(path.join(workflowDir, 'workflow2.yml'), workflow2);
    
    await runValidator();
    
    const output = getGitHubOutput();
    const results = JSON.parse(output.match(/workflow_results<<.*\n(.*)\n/)?.[1] || '');
    
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: '.github/workflows/workflow1.yml',
          concurrencyCount: 1,
          passed: true
        }),
        expect.objectContaining({
          file: '.github/workflows/workflow2.yml',
          concurrencyCount: 2,
          passed: true
        })
      ])
    );
    expect(output).toMatch(/validation_passed<<.*\ntrue\n/);
    expect(output).toMatch(/total_concurrency<<.*\n0\n/);
  });

  test('validates matrix jobs correctly', async () => {
    const workflow = `
name: Matrix Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu, windows]
        node: [14, 16]
    steps:
      - run: echo "test"
`;
    fs.writeFileSync(path.join(workflowDir, 'matrix.yml'), workflow);
    
    await runValidator();
    
    const output = getGitHubOutput();
    expect(JSON.parse(output.match(/workflow_results<<.*\n(.*)\n/)?.[1] || '')[0]).toEqual(
      expect.objectContaining({
        file: '.github/workflows/matrix.yml',
        concurrencyCount: 4,
        passed: true
      })
    );
    expect(output).toMatch(/validation_passed<<.*\ntrue\n/);
    expect(output).toMatch(/total_concurrency<<.*\n0\n/);
  });
});