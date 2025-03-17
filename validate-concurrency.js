const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const glob = require('glob');

// Get inputs
const MAX_CONCURRENCY = parseInt(process.env.INPUT_MAX_CONCURRENCY || '10');
const WORKFLOW_DIR = process.env.INPUT_WORKFLOW_PATH || '.github/workflows';
const FAIL_ON_ERROR = (process.env.INPUT_FAIL_ON_ERROR || 'true') === 'true';
const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();

// Path to workflow directory
const workflowPath = path.join(WORKSPACE, WORKFLOW_DIR);

// Initialize counters and issues array
let totalConcurrency = 0;
let issues = [];
let workflowConcurrencyDetails = [];

// Function to set GitHub Actions outputs
function setOutput(name, value) {
  const outputFilePath = process.env.GITHUB_OUTPUT;
  if (outputFilePath) {
    // Multi-line value handling for GitHub Actions
    if (typeof value === 'object') {
      value = JSON.stringify(value);
    }
    const delimiter = `ghadelimiter_${Date.now()}`;
    fs.appendFileSync(outputFilePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    // Fallback for older runners, but this will show deprecation warnings
    console.log(`::set-output name=${name}::${value}`);
  }
}

try {
  // Get all workflow files
  const workflowFiles = glob.sync(`${workflowPath}/**/*.{yml,yaml}`);
  
  if (workflowFiles.length === 0) {
    console.log(`No workflow files found in ${workflowPath}`);
  }
  
  workflowFiles.forEach(file => {
    try {
      const relativeFilePath = path.relative(WORKSPACE, file);
      const fileContent = fs.readFileSync(file, 'utf8');
      const workflow = yaml.load(fileContent);
      
      // Check for top-level concurrency settings
      if (workflow.concurrency) {
        // Check for group+cancel-in-progress pattern which doesn't limit concurrency
        if (typeof workflow.concurrency === 'object' && 
            workflow.concurrency['cancel-in-progress'] === true) {
          console.log(`${relativeFilePath}: Has cancel-in-progress concurrency, not counting toward limit`);
          workflowConcurrencyDetails.push({
            file: relativeFilePath,
            level: 'workflow',
            type: 'cancel-in-progress',
            counted: false
          });
        } else {
          totalConcurrency++;
          console.log(`${relativeFilePath}: Found top-level concurrency, count: ${totalConcurrency}`);
          workflowConcurrencyDetails.push({
            file: relativeFilePath,
            level: 'workflow',
            type: 'standard',
            counted: true
          });
        }
      }
      
      // Check for job-level concurrency settings
      if (workflow.jobs) {
        Object.keys(workflow.jobs).forEach(jobKey => {
          const job = workflow.jobs[jobKey];
          if (job.concurrency) {
            // Check for group+cancel-in-progress pattern which doesn't limit concurrency
            if (typeof job.concurrency === 'object' && 
                job.concurrency['cancel-in-progress'] === true) {
              console.log(`${relativeFilePath}/${jobKey}: Has cancel-in-progress concurrency, not counting toward limit`);
              workflowConcurrencyDetails.push({
                file: relativeFilePath,
                job: jobKey,
                level: 'job',
                type: 'cancel-in-progress',
                counted: false
              });
            } else {
              totalConcurrency++;
              console.log(`${relativeFilePath}/${jobKey}: Found job-level concurrency, count: ${totalConcurrency}`);
              workflowConcurrencyDetails.push({
                file: relativeFilePath,
                job: jobKey,
                level: 'job',
                type: 'standard',
                counted: true
              });
            }
          }
        });
      }
      
      // Check for max parallel jobs when concurrency isn't explicitly defined
      if (!workflow.concurrency) {
        let jobCount = 0;
        if (workflow.jobs) {
          jobCount = Object.keys(workflow.jobs).length;
          // Only count workflows that don't have explicit needs dependencies
          // as those would run in parallel
          let independentJobs = 0;
          let independentJobNames = [];
          
          Object.keys(workflow.jobs).forEach(jobKey => {
            const job = workflow.jobs[jobKey];
            if (!job.needs) {
              independentJobs++;
              independentJobNames.push(jobKey);
            }
          });
          
          if (independentJobs > 1) {
            totalConcurrency += independentJobs;
            console.log(`${relativeFilePath}: Found ${independentJobs} independent jobs that could run in parallel, count: ${totalConcurrency}`);
            workflowConcurrencyDetails.push({
              file: relativeFilePath,
              level: 'implicit',
              jobs: independentJobNames,
              count: independentJobs,
              counted: true
            });
          }
        }
      }
      
    } catch (error) {
      const errorMsg = `Error processing ${file}: ${error.message}`;
      issues.push(errorMsg);
      console.error(errorMsg);
    }
  });
  
  console.log(`\nTotal concurrency usage across all workflows: ${totalConcurrency}`);
  console.log(`Maximum allowed concurrency: ${MAX_CONCURRENCY}`);
  
  const validationPassed = totalConcurrency <= MAX_CONCURRENCY;
  
  if (!validationPassed) {
    const errorMsg = `Total concurrency (${totalConcurrency}) exceeds maximum allowed (${MAX_CONCURRENCY})`;
    issues.push(errorMsg);
    console.log('Concurrency validation FAILED');
    
    // Output error message for GitHub Actions
    console.log(`::error::${errorMsg}`);
    
    if (FAIL_ON_ERROR) {
      process.exit(1);
    }
  } else {
    console.log('Concurrency validation PASSED');
  }
  
  if (issues.length > 0) {
    console.log('\nIssues found:');
    issues.forEach(issue => console.log(` - ${issue}`));
  }
  
  // Set outputs for GitHub Actions
  setOutput('total_concurrency', totalConcurrency.toString());
  setOutput('validation_passed', validationPassed.toString());
  setOutput('issues', JSON.stringify(issues));
  setOutput('details', JSON.stringify(workflowConcurrencyDetails));
  
} catch (error) {
  console.error(`Fatal error: ${error.message}`);
  issues.push(`Fatal error: ${error.message}`);
  setOutput('total_concurrency', '0');
  setOutput('validation_passed', 'false');
  setOutput('issues', JSON.stringify(issues));
  
  if (FAIL_ON_ERROR) {
    process.exit(1);
  }
}