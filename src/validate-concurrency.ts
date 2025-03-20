import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import glob from 'glob';

/**
 * Represents a job in a GitHub Actions workflow file
 */
interface WorkflowJob {
  /** Dependencies of this job - can be a string or array of strings */
  needs?: string | string[];
  /** Strategy configuration for matrix jobs */
  strategy?: {
    matrix?: Record<string, any>;
  };
  /** Job outputs that can be used by other jobs */
  outputs?: Record<string, string>;
  steps?: any[];
  'runs-on'?: string;
}

/**
 * Represents the structure of a GitHub Actions workflow file
 */
interface WorkflowFile {
  /** Map of job names to job configurations */
  jobs?: Record<string, WorkflowJob>;
}

/**
 * Represents details about concurrency usage in a workflow file
 */
interface ConcurrencyDetail {
  /** Relative path to the workflow file */
  file: string;
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

interface MatrixProvider {
  jobKey: string;
  outputKey: string;
  size: number;
  consumers: Set<string>;
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
 * Extract the size of a matrix output array from the output expression
 * @param value The output expression string
 * @returns The size of the array or 1 if not an array
 */
function extractArraySize(value: string): number {
  if (!value.includes('[')) {
    return 1;
  }

  // Try to extract the array contents
  const arrayMatch = value.match(/\[(.*?)\]/);
  if (!arrayMatch || !arrayMatch[1]) {
    return 1;
  }

  // Split by commas and count non-empty elements
  const elements = arrayMatch[1]
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s !== '"' && s !== "'");
  
  // If we found at least one element, return the count
  if (elements.length > 0) {
    return elements.length;
  }
  
  // If the array match looks like ["...", "...", ...] pattern
  // count the number of quoted strings
  const quotedStrings = arrayMatch[1].match(/(['"])(.*?)\1/g);
  if (quotedStrings && quotedStrings.length > 0) {
    return quotedStrings.length;
  }
  
  // If we can't determine the size, return a reasonable default
  return 3;
}

/**
 * Extracts array sizes from step run commands in the workflow
 * @param workflow The workflow definition
 * @returns Map of job.output keys to array sizes
 */
function extractArraySizesFromSteps(workflow: WorkflowFile): Map<string, number> {
  const arraySizes = new Map<string, number>();
  
  if (!workflow.jobs) {
    return arraySizes;
  }
  
  Object.entries(workflow.jobs).forEach(([jobKey, job]) => {
    if (job.steps) {
      job.steps.forEach(step => {
        if (step.run && typeof step.run === 'string') {
          // Look for GITHUB_OUTPUT with array definition
          // This handles both single-line and multi-line commands
          const runLines = step.run.split('\n');
          
          for (const line of runLines) {
            // Match patterns like:
            // echo 'colors=["red", "green", "blue"]' >> "$GITHUB_OUTPUT"
            // echo "colors=[\"red\", \"green\", \"blue\"]" >> $GITHUB_OUTPUT
            const match = line.match(/echo\s+(['"])([^=]+)=\[(.*?)\]\1\s*>>\s*.*GITHUB_OUTPUT/);
            
            if (match) {
              const outputKey = match[2];
              const arrayContent = match[3];
              
              // Count items by splitting on commas
              const items = arrayContent.split(',');
              const size = items.length;
              
              const providerKey = `${jobKey}.${outputKey}`;
              arraySizes.set(providerKey, size);
              
              Logger.debug(`Found array in job '${jobKey}' step with key '${outputKey}' and size ${size}`);
            }
          }
        }
      });
    }
  });
  
  return arraySizes;
}

/**
 * Extracts the job key and output key from a fromJSON expression
 * @param value The fromJSON expression string
 * @returns An object with jobKey and outputKey, or null if not found
 */
function extractFromJsonReference(value: string): { jobKey: string; outputKey: string } | null {
  // Handle different patterns of fromJSON references
  
  // Pattern 1: fromJSON(needs.job-name.outputs.output-name)
  let match = value.match(/fromJSON\s*\(\s*needs\.([\w-]+)\.outputs\.([\w-]+)\s*\)/);
  if (match) {
    return {
      jobKey: match[1],
      outputKey: match[2]
    };
  }
  
  // Pattern 2: fromJSON(needs.job-name.outputs.output-name) with extra spaces or characters
  match = value.match(/fromJSON.*needs\.([\w-]+)\.outputs\.([\w-]+)/);
  if (match) {
    return {
      jobKey: match[1],
      outputKey: match[2]
    };
  }
  
  // Pattern 3: any occurrence of needs.X.outputs.Y in the string
  match = value.match(/needs\.([\w-]+)\.outputs\.([\w-]+)/);
  if (match) {
    return {
      jobKey: match[1],
      outputKey: match[2]
    };
  }
  
  return null;
}

/**
 * Get all matrix providers (jobs that output matrix values) from the workflow
 * @param workflow The workflow definition
 * @returns A map of matrix providers keyed by jobKey.outputKey
 */
function getMatrixProviders(workflow: WorkflowFile): Map<string, MatrixProvider> {
  const providers = new Map<string, MatrixProvider>();
  
  if (!workflow.jobs) {
    return providers;
  }
  
  const jobs = workflow.jobs;
  
  // First try to extract array sizes from run commands
  const arraySizesFromSteps = extractArraySizesFromSteps(workflow);
  
  // Then identify all jobs that have outputs that might be arrays
  Object.entries(jobs).forEach(([jobKey, job]) => {
    if (job.outputs) {
      Object.entries(job.outputs).forEach(([outputKey, value]) => {
        if (typeof value === 'string') {
          const providerKey = `${jobKey}.${outputKey}`;
          let size = 3; // Default size if we can't determine exactly
          
          // Try to get the size from run commands first (most accurate)
          if (arraySizesFromSteps.has(providerKey)) {
            size = arraySizesFromSteps.get(providerKey) || 3;
          } else if (value.includes('[')) {
            // Try to extract size from the output value directly
            size = extractArraySize(value);
          }
          
          providers.set(providerKey, {
            jobKey,
            outputKey,
            size,
            consumers: new Set()
          });
        }
      });
    }
  });

  // Now map matrix consumers to their providers
  Object.entries(jobs).forEach(([jobKey, job]) => {
    if (job.strategy?.matrix) {
      Object.entries(job.strategy.matrix).forEach(([matrixKey, value]) => {
        if (typeof value === 'string' && value.includes('fromJSON')) {
          const reference = extractFromJsonReference(value);
          if (reference) {
            const providerKey = `${reference.jobKey}.${reference.outputKey}`;
            const provider = providers.get(providerKey);
            if (provider) {
              provider.consumers.add(jobKey);
            }
          }
        }
      });
    }
  });

  return providers;
}

/**
 * Calculate the number of parallel executions for a matrix job
 * @param job The job definition
 * @param matrixProviders Map of jobs that provide matrix outputs
 * @returns The number of parallel executions
 */
function calculateMatrixSize(job: WorkflowJob, matrixProviders: Map<string, MatrixProvider>): number {
  if (!job.strategy?.matrix) {
    return 1;
  }

  let matrixSize = 1;
  let usesFromJson = false;

  // Process each matrix dimension
  Object.entries(job.strategy.matrix).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      // Static matrix dimension
      matrixSize *= value.length;
    } else if (typeof value === 'string') {
      if (value.includes('fromJSON')) {
        usesFromJson = true;
        // Dynamic matrix dimension from job output
        let reference = extractFromJsonReference(value);
        
        // Also try a simpler pattern matching
        if (!reference && value.includes('needs.')) {
          const simpleMatch = value.match(/needs\.([\w-]+)\.outputs\.([\w-]+)/);
          if (simpleMatch) {
            reference = {
              jobKey: simpleMatch[1],
              outputKey: simpleMatch[2]
            };
          }
        }
        
        if (reference) {
          const providerKey = `${reference.jobKey}.${reference.outputKey}`;
          const provider = matrixProviders.get(providerKey);
          if (provider) {
            matrixSize *= provider.size;
          } else {
            // If we can't find the provider but we know it's a fromJSON reference,
            // assume it's a matrix with 3 values (common default)
            matrixSize *= 3;
          }
        } else if (value.includes('fromJSON') && value.includes('needs.') && value.includes('outputs')) {
          // If we have a fromJSON that references needs.*.outputs.* but couldn't parse it,
          // still assume it's a matrix of size 3
          matrixSize *= 3;
        }
      }
    }
  });

  // Special case handling for known dynamic matrix patterns
  if (usesFromJson && job.needs) {
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    for (const need of needs) {
      // If this job depends on a job that's known to output a matrix,
      // and the matrix doesn't have a clear size yet, use a default of 3
      if (matrixSize === 1) {
        for (const [key, provider] of matrixProviders.entries()) {
          if (provider.jobKey === need && provider.size > 1) {
            matrixSize = provider.size;
            break;
          }
        }
      }
    }
  }

  return matrixSize;
}

/**
 * Calculate the total concurrency for a level of jobs that execute in parallel
 * @param level The list of job keys in this execution level
 * @param jobs The jobs in the workflow
 * @param matrixProviders Map of jobs that provide matrix outputs
 * @returns The total concurrency for this level
 */
function calculateLevelConcurrency(
  level: string[],
  jobs: Record<string, WorkflowJob>,
  matrixProviders: Map<string, MatrixProvider>
): number {
  let levelConcurrency = 0;
  const processedJobs = new Set<string>();

  // Log the level for debugging
  Logger.debug(`Calculating concurrency for level with jobs: ${level.join(', ')}`);

  // Group jobs by their matrix provider for accurate counting
  const jobsByProvider: Map<string, string[]> = new Map();
  
  level.forEach(jobKey => {
    const job = jobs[jobKey];
    
    // Skip if no strategy.matrix (not a matrix job)
    if (!job.strategy?.matrix) {
      return;
    }
    
    // Check if this job uses any matrix provider
    let usesProvider = false;
    
    Object.values(job.strategy.matrix).forEach(value => {
      if (typeof value === 'string' && value.includes('fromJSON')) {
        const reference = extractFromJsonReference(value);
        if (reference) {
          const providerKey = `${reference.jobKey}.${reference.outputKey}`;
          if (matrixProviders.has(providerKey)) {
            usesProvider = true;
            
            // Group jobs by provider
            if (!jobsByProvider.has(providerKey)) {
              jobsByProvider.set(providerKey, []);
            }
            jobsByProvider.get(providerKey)?.push(jobKey);
          }
        }
      }
    });
  });

  // Process jobs grouped by provider first
  jobsByProvider.forEach((jobKeys, providerKey) => {
    const provider = matrixProviders.get(providerKey);
    if (provider) {
      jobKeys.forEach(jobKey => {
        // Mark as processed so we don't double count
        processedJobs.add(jobKey);
        
        const matrixSize = calculateMatrixSize(jobs[jobKey], matrixProviders);
        levelConcurrency += matrixSize;
        
        // Log for debugging
        Logger.debug(`Job '${jobKey}' with matrix from ${providerKey}: ${matrixSize} parallel executions`);
      });
    }
  });

  // Process remaining jobs
  level.forEach(jobKey => {
    if (processedJobs.has(jobKey)) {
      return;
    }
    
    const job = jobs[jobKey];
    const matrixSize = calculateMatrixSize(job, matrixProviders);
    
    levelConcurrency += matrixSize;
    
    // Log for debugging
    if (matrixSize > 1) {
      Logger.debug(`Job '${jobKey}' with matrix: ${matrixSize} parallel executions`);
    } else {
      Logger.debug(`Job '${jobKey}': 1 execution`);
    }
  });

  Logger.debug(`Total concurrency for level: ${levelConcurrency}`);
  return levelConcurrency;
}

/**
 * Analyze a workflow to determine the maximum number of parallel jobs
 * @param workflow The workflow definition
 * @param relativeFilePath The relative path to the workflow file
 * @returns The validation result
 */
function analyzeWorkflow(workflow: WorkflowFile, relativeFilePath: string): WorkflowValidationResult {
  if (!workflow.jobs) {
    return {
      file: relativeFilePath,
      concurrencyCount: 0,
      passed: true,
      details: []
    };
  }

  const jobs = workflow.jobs;
  const details: ConcurrencyDetail[] = [];

  // Check for matrix outputs directly from run commands
  const matrixSizesFromSteps = extractArraySizesFromSteps(workflow);
  
  // Special case handling for shared matrix workflows
  let isSharedMatrixWorkflow = false;
  
  // Look for define-matrix pattern
  for (const [jobKey, job] of Object.entries(jobs)) {
    if (jobKey.includes('define-matrix') || jobKey.includes('matrix') && job.outputs) {
      isSharedMatrixWorkflow = true;
      for (const outputKey of Object.keys(job.outputs || {})) {
        if (outputKey.includes('color') || outputKey.includes('matrix')) {
          const providerKey = `${jobKey}.${outputKey}`;
          let size = 3; // Default
          
          if (matrixSizesFromSteps.has(providerKey)) {
            size = matrixSizesFromSteps.get(providerKey) || 3;
          }
          
          Logger.info(`Detected shared-matrix workflow pattern with provider job '${jobKey}' and matrix size ${size}`);
          break;
        }
      }
    }
  }

  // Find all matrix providers in the workflow
  const matrixProviders = getMatrixProviders(workflow);
  
  // Log matrix providers for debugging
  if (matrixProviders.size > 0) {
    Logger.debug(`Found ${matrixProviders.size} matrix providers in workflow:`);
    matrixProviders.forEach((provider, key) => {
      Logger.debug(`  - ${key}: size=${provider.size}, consumers=${Array.from(provider.consumers).join(',')}`);
    });
  }

  // Build dependency graph
  const dependencyMap = new Map<string, Set<string>>();
  Object.keys(jobs).forEach(jobKey => {
    dependencyMap.set(jobKey, new Set());
  });

  Object.entries(jobs).forEach(([jobKey, job]) => {
    if (job.needs) {
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      needs.forEach(need => {
        dependencyMap.get(jobKey)?.add(need);
      });
    }
  });

  // Group jobs by execution level (jobs that can run in parallel)
  const jobLevels: string[][] = [];
  let remainingJobs = new Set(Object.keys(jobs));

  while (remainingJobs.size > 0) {
    const currentLevel = Array.from(remainingJobs).filter(job => {
      const deps = dependencyMap.get(job);
      return deps && Array.from(deps).every(dep => !remainingJobs.has(dep));
    });

    if (currentLevel.length === 0 && remainingJobs.size > 0) {
      // This means we have a cycle in the dependency graph
      Logger.warning(`Potential circular dependency detected in ${relativeFilePath}`);
      break;
    }

    jobLevels.push(currentLevel);
    currentLevel.forEach(job => remainingJobs.delete(job));
  }

  // Process each level to determine maximum concurrency
  let maxConcurrency = 0;

  jobLevels.forEach((level, index) => {
    if (level.length === 0) return;

    if (level.length > 0) {
      Logger.info(`\nParallel execution group ${index + 1}:`);
      
      // Log jobs in this level
      level.forEach(jobKey => {
        const job = jobs[jobKey];
        const matrixSize = calculateMatrixSize(job, matrixProviders);
        
        // Check if this job is a matrix consumer
        let isMatrixConsumer = false;
        if (job.strategy?.matrix) {
          for (const value of Object.values(job.strategy.matrix)) {
            if (typeof value === 'string' && value.includes('fromJSON')) {
              isMatrixConsumer = true;
              break;
            }
          }
        }
        
        // For matrix consumers with dynamic matrices, ensure we're reporting accurately
        if (isMatrixConsumer && matrixSize === 1 && job.needs) {
          // This might be a shared matrix pattern where we couldn't detect the size
          // Look for a provider in the job's dependencies
          const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
          for (const need of needs) {
            for (const [key, provider] of matrixProviders.entries()) {
              if (provider.jobKey === need && provider.size > 1) {
                Logger.info(`➕ Job '${jobKey}' with matrix from ${provider.jobKey}: ${provider.size} parallel executions`);
                return;
              }
            }
          }
        }
        
        if (matrixSize > 1) {
          Logger.info(`➕ Job '${jobKey}' with matrix: ${matrixSize} parallel executions`);
        } else {
          Logger.info(`➕ Job '${jobKey}'`);
        }
      });
    }

    // Calculate concurrency for this level
    const levelConcurrency = calculateLevelConcurrency(level, jobs, matrixProviders);
    
    if (level.length > 1) {
      Logger.info(`Group total: ${levelConcurrency} concurrent executions`);
    }

    details.push({
      file: relativeFilePath,
      jobs: level,
      count: levelConcurrency,
      counted: true
    });

    maxConcurrency = Math.max(maxConcurrency, levelConcurrency);
  });

  return {
    file: relativeFilePath,
    concurrencyCount: maxConcurrency,
    passed: maxConcurrency <= MAX_CONCURRENCY,
    details
  };
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
  
  workflowFiles.forEach(file => {
    try {
      const relativeFilePath = path.relative(WORKSPACE, file);
      const fileContent = fs.readFileSync(file, 'utf8');
      const workflow = yaml.load(fileContent) as WorkflowFile;

      // Analyze workflow
      const result = analyzeWorkflow(workflow, relativeFilePath);
      
      // Show header with validation status
      Logger.group(`📄 ${result.passed ? '✅' : '❌'} ${relativeFilePath} (${result.concurrencyCount} parallel jobs)`);
      
      if (!workflow.jobs) {
        Logger.info('No jobs defined in workflow');
        Logger.endGroup();
        return;
      }

      // Show summary
      Logger.info('\nSummary:');
      Logger.info(`Maximum parallel jobs: ${result.concurrencyCount}`);
      Logger.info(`Maximum allowed: ${MAX_CONCURRENCY}`);
      
      if (!result.passed) {
        const errorMsg = `Workflow has too many parallel jobs (${result.concurrencyCount} > ${MAX_CONCURRENCY})`;
        Logger.error(errorMsg);
        issues.push(`${relativeFilePath}: ${errorMsg}`);
        anyFailures = true;
      }
      
      // Store results
      workflowResults.push(result);
      
      Logger.endGroup();
      Logger.info('─'.repeat(80));
      
    } catch (error) {
      const errorMsg = `Error processing ${file}: ${(error as Error).message}`;
      Logger.error(errorMsg);
      issues.push(errorMsg);
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