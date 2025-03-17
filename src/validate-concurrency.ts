import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import glob from 'glob';

/**
 * Represents the concurrency configuration in a workflow file
 */
interface WorkflowConcurrency {
  /** The concurrency group name */
  group?: string;
  /** Whether to cancel in-progress runs */
  'cancel-in-progress'?: boolean;
}

/**
 * Represents a job in a GitHub Actions workflow file
 */
interface WorkflowJob {
  /** Dependencies of this job - can be a string or array of strings */
  needs?: string | string[];
  /** Concurrency configuration for this job */
  concurrency?: WorkflowConcurrency | string;
  /** Strategy configuration for matrix jobs */
  strategy?: {
    matrix?: Record<string, any>;
  };
}

/**
 * Represents the structure of a GitHub Actions workflow file
 */
interface WorkflowFile {
  /** Top-level concurrency configuration */
  concurrency?: WorkflowConcurrency | string;
  /** Map of job names to job configurations */
  jobs?: Record<string, WorkflowJob>;
}

/**
 * Represents details about concurrency usage in a workflow file
 */
interface ConcurrencyDetail {
  /** Relative path to the workflow file */
  file: string;
  /** Name of the job (if job-level concurrency) */
  job?: string;
  /** The level at which concurrency is defined */
  level: 'workflow' | 'job' | 'implicit';
  /** The type of concurrency configuration */
  type?: 'standard' | 'cancel-in-progress';
  /** List of job names (for implicit concurrency) */
  jobs?: string[];
  /** Number of concurrent jobs (for implicit concurrency) */
  count?: number;
  /** Whether this concurrency setting counts towards the total */
  counted: boolean;
}

interface WorkflowValidationResult {
  file: string;
  concurrencyCount: number;
  passed: boolean;
  details: ConcurrencyDetail[];
}

/**
 * Utility class for formatted logging in GitHub Actions
 */
class Logger {
  static group(name: string): void {
    console.log(`::group::${name}`);
  }

  static endGroup(): void {
    console.log('::endgroup::');
  }

  static error(message: string): void {
    console.log(`::error::${message}`);
  }

  static warning(message: string): void {
    console.log(`::warning::${message}`);
  }

  static notice(message: string): void {
    console.log(`::notice::${message}`);
  }

  static debug(message: string): void {
    console.log(`::debug::${message}`);
  }

  static info(message: string): void {
    console.log(message);
  }

  static success(message: string): void {
    console.log(`✅ ${message}`);
  }

  static fail(message: string): void {
    console.log(`❌ ${message}`);
  }

  static summary(title: string, content: string): void {
    Logger.group(title);
    Logger.info(content);
    Logger.endGroup();
  }
}

/**
 * Validates the action inputs to ensure they are valid
 * @throws {Error} If max-concurrency is not a positive number
 */
function validateInputs(): void {
  const maxConcurrency = parseInt(process.env.INPUT_MAX_CONCURRENCY || '10');
  if (isNaN(maxConcurrency) || maxConcurrency <= 0) {
    throw new Error('max-concurrency must be a positive number');
  }
}

/**
 * Sets an output variable for the GitHub Action
 * @param name - The name of the output variable
 * @param value - The value to set
 */
function setOutput(name: string, value: string): void {
  const outputFilePath = process.env.GITHUB_OUTPUT;
  if (outputFilePath) {
    const delimiter = `ghadelimiter_${Date.now()}`;
    fs.appendFileSync(outputFilePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    console.log(`::set-output name=${name}::${value}`);
  }
}

// Get and validate inputs
const MAX_CONCURRENCY = parseInt(process.env.INPUT_MAX_CONCURRENCY || '10');
const WORKFLOW_DIR = process.env.INPUT_WORKFLOW_PATH || '.github/workflows';
const FAIL_ON_ERROR = (process.env.INPUT_FAIL_ON_ERROR || 'true') === 'true';
const COMMENT_ON_PR = (process.env.INPUT_COMMENT_ON_PR || 'true') === 'true';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();

// Initialize state
const issues: string[] = [];
const workflowResults: WorkflowValidationResult[] = [];
let totalConcurrency = 0;

/**
 * Helper function to build a dependency graph of jobs and identify parallel execution paths
 */
function analyzeJobDependencies(jobs: Record<string, WorkflowJob>): {
  parallelJobs: string[][];
  maxConcurrency: number;
} {
  // Build dependency graph
  const dependencyMap = new Map<string, Set<string>>();
  const allJobs = new Set<string>();
  
  // Initialize maps
  Object.keys(jobs).forEach(jobKey => {
    dependencyMap.set(jobKey, new Set());
    allJobs.add(jobKey);
  });
  
  // Build dependency relationships
  Object.entries(jobs).forEach(([jobKey, job]) => {
    if (job.needs) {
      // Handle both string and array cases for needs
      const jobNeeds = Array.isArray(job.needs) ? job.needs : [job.needs];
      jobNeeds.forEach(need => {
        dependencyMap.get(jobKey)?.add(need);
      });
    }
  });
  
  // Find jobs that can run in parallel (same level in dependency tree)
  const jobLevels: string[][] = [];
  let remainingJobs = new Set(allJobs);
  
  while (remainingJobs.size > 0) {
    // Find all jobs that have no unresolved dependencies
    const currentLevel = Array.from(remainingJobs).filter(job => {
      const deps = dependencyMap.get(job);
      return deps && Array.from(deps).every(dep => !remainingJobs.has(dep));
    });
    
    if (currentLevel.length === 0 && remainingJobs.size > 0) {
      // Circular dependency or invalid configuration
      break;
    }
    
    // Even a single job at a level should be counted
    jobLevels.push(currentLevel);
    currentLevel.forEach(job => remainingJobs.delete(job));
  }
  
  // Find the level with maximum parallel jobs
  const maxConcurrency = Math.max(...jobLevels.map(level => {
    let levelCount = 0;
    level.forEach(jobName => {
      const job = jobs[jobName];
      levelCount += countMatrixExecutions(job);
    });
    return levelCount;
  }));
  
  return {
    parallelJobs: jobLevels,
    maxConcurrency
  };
}

/**
 * Analyze a matrix job to count its parallel executions
 */
function countMatrixExecutions(job: WorkflowJob): number {
  if (!job.strategy?.matrix) {
    return 1;
  }
  
  // Count combinations of matrix values
  return Object.values(job.strategy.matrix).reduce((total, values) => {
    if (Array.isArray(values)) {
      return total * values.length;
    }
    return total;
  }, 1);
}

try {
  validateInputs();
  const workflowPath = path.join(WORKSPACE, WORKFLOW_DIR);
  const workflowFiles = glob.sync(`${workflowPath}/**/*.{yml,yaml}`);
  
  Logger.notice(`Found ${workflowFiles.length} workflow files to validate`);
  Logger.info('Maximum allowed parallel jobs per workflow: ' + MAX_CONCURRENCY);
  Logger.info('─'.repeat(80));
  
  if (workflowFiles.length === 0) {
    Logger.warning(`No workflow files found in ${workflowPath}`);
  }
  
  let anyFailures = false;
  
  workflowFiles.forEach((file: string) => {
    try {
      const relativeFilePath = path.relative(WORKSPACE, file);
      const fileContent = fs.readFileSync(file, 'utf8');
      const workflow = yaml.load(fileContent) as WorkflowFile;

      // Analyze workflow first before showing header
      const { parallelJobs, maxConcurrency } = workflow.jobs ? analyzeJobDependencies(workflow.jobs) : { parallelJobs: [], maxConcurrency: 0 };
      const workflowPassed = maxConcurrency <= MAX_CONCURRENCY;
      
      // Show header with validation status
      Logger.group(`📄 ${workflowPassed ? '✅' : '❌'} ${relativeFilePath} (${maxConcurrency} parallel jobs)`);
      
      if (!workflow.jobs) {
        Logger.info('No jobs defined in workflow');
        Logger.endGroup();
        return;
      }

      let details: ConcurrencyDetail[] = [];
      
      // Check if workflow has cancel-in-progress concurrency
      if (typeof workflow.concurrency === 'object' && workflow.concurrency['cancel-in-progress'] === true) {
        Logger.info('Note: Workflow has cancel-in-progress concurrency (only affects concurrent workflow runs)');
        details.push({
          file: relativeFilePath,
          level: 'workflow',
          type: 'cancel-in-progress',
          counted: false
        });
      }
      
      // Process each level of parallel jobs for logging
      parallelJobs.forEach((level, index) => {
        if (level.length > 0) {
          if (level.length > 1) {
            Logger.info(`\nParallel execution group ${index + 1}:`);
          }
          
          let levelConcurrency = 0;
          level.forEach(jobKey => {
            const job = workflow.jobs![jobKey];
            const matrixCount = countMatrixExecutions(job);
            levelConcurrency += matrixCount;
            
            if (matrixCount > 1) {
              Logger.info(`➕ Job '${jobKey}' with matrix: ${matrixCount} parallel executions`);
            } else {
              Logger.info(`➕ Job '${jobKey}'`);
            }
          });
          
          if (level.length > 1) {
            Logger.info(`Group total: ${levelConcurrency} concurrent executions`);
          }

          details.push({
            file: relativeFilePath,
            level: 'implicit',
            type: 'standard',
            jobs: level,
            count: levelConcurrency,
            counted: true
          });
        }
      });
      
      Logger.info('\nSummary:');
      Logger.info(`Maximum parallel jobs: ${maxConcurrency}`);
      Logger.info(`Maximum allowed: ${MAX_CONCURRENCY}`);
      
      if (!workflowPassed) {
        const errorMsg = `Workflow has too many parallel jobs (${maxConcurrency} > ${MAX_CONCURRENCY})`;
        Logger.error(errorMsg);
        issues.push(`${relativeFilePath}: ${errorMsg}`);
        anyFailures = true;
      }
      
      // Store results
      workflowResults.push({
        file: relativeFilePath,
        concurrencyCount: maxConcurrency,
        passed: workflowPassed,
        details
      });
      
      Logger.endGroup();
      Logger.info('─'.repeat(80));
      
    } catch (error) {
      const errorMsg = `Error processing ${file}: ${(error as Error).message}`;
      Logger.error(errorMsg);
      issues.push(errorMsg);
      Logger.endGroup();
    }
  });
  
  // Final summary
  Logger.group('🔍 Validation Summary');
  Logger.info(`\nTotal workflows analyzed: ${workflowFiles.length}`);
  Logger.info(`Workflows with issues: ${issues.length}`);
  
  if (issues.length > 0) {
    Logger.info('\nIssues found:');
    issues.forEach(issue => Logger.error(issue));
  }
  
  if (!anyFailures) {
    Logger.success('\nAll workflows passed validation!');
  } else {
    Logger.fail('\nSome workflows have too many parallel jobs.');
  }
  Logger.endGroup();
  
  // Set outputs for GitHub Actions
  const overallPassed = !anyFailures;
  setOutput('validation_passed', overallPassed.toString());
  setOutput('workflow_results', JSON.stringify(workflowResults));
  setOutput('issues', JSON.stringify(issues));
  setOutput('total_concurrency', totalConcurrency.toString());
  // Add validation_result output with the format expected by the PR comment
  setOutput('validation_result', JSON.stringify({
    passed: overallPassed,
    total: totalConcurrency,
    max: MAX_CONCURRENCY,
    issues: issues
  }));
  
  if (!overallPassed && FAIL_ON_ERROR) {
    process.exit(1);
  }
  
} catch (error) {
  Logger.error(`Fatal error: ${(error as Error).message}`);
  issues.push(`Fatal error: ${(error as Error).message}`);
  setOutput('validation_passed', 'false');
  setOutput('workflow_results', '[]');
  setOutput('issues', JSON.stringify(issues));
  setOutput('total_concurrency', '0');
  
  if (FAIL_ON_ERROR) {
    process.exit(1);
  }
}