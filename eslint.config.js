import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-test/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // stdout is the MCP JSON-RPC channel. Anything else written there breaks the client.
      "no-console": ["error", { allow: ["error"] }],
    },
  },
);
