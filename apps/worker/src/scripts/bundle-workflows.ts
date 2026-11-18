/**
 * Prebundles the workflow code at build time (dist/workflow-bundle.js), so the worker container starts without
 * running webpack and every replica runs byte-identical workflow code.
 */
import { writeFile } from 'node:fs/promises';
import { bundleWorkflowCode } from '@temporalio/worker';

const workflowsPath = new URL('../workflows/index.js', import.meta.url).pathname;
const output = new URL('../workflow-bundle.js', import.meta.url).pathname;

const { code } = await bundleWorkflowCode({ workflowsPath });
await writeFile(output, code);
console.log(`Workflow bundle written to ${output} (${Math.round(code.length / 1024)} KiB)`);
