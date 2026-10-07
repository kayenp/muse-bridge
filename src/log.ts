import { chmodSync, closeSync, openSync } from "node:fs";
import pino from "pino";
import { config, ensureDirs, PRIVATE_FILE_MODE } from "./config.js";

ensureDirs();
// Create the log owner-only, and tighten one left over from an older run.
closeSync(openSync(config.logFile, "a", PRIVATE_FILE_MODE));
chmodSync(config.logFile, PRIVATE_FILE_MODE);

// Never stdout: in stdio MCP mode stdout carries JSON-RPC and nothing else.
// stderr also ends up in the MCP client's own logs, so never log URLs, cookies, headers or page/chat content:
// log only small, fixed fields (mode, display, error codes).
export const log = pino(
  { level: config.logLevel },
  pino.multistream([
    { stream: pino.destination(2) },
    { stream: pino.destination({ dest: config.logFile, append: true, sync: false, mode: PRIVATE_FILE_MODE }) },
  ]),
);
