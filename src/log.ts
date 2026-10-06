import pino from "pino";
import { config, ensureDirs } from "./config.js";

ensureDirs();

// Never stdout: in stdio MCP mode stdout carries JSON-RPC and nothing else.
export const log = pino(
  { level: config.logLevel },
  pino.multistream([
    { stream: pino.destination(2) },
    { stream: pino.destination({ dest: config.logFile, append: true, sync: false }) },
  ]),
);
