/* eslint-disable no-console -- this file is the one place allowed to reassign console methods */
// Imported first by index.ts so it runs before any other module is evaluated:
// stdout is the MCP JSON-RPC channel, so stray console output from dependencies goes to stderr.
const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;
