import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const composeFile = resolve(root, "demo/docker-compose.yml");

const configuration = {
  mcpServers: {
    liveprobe: {
      command: "docker",
      args: [
        "compose",
        "-f",
        composeFile,
        "--profile",
        "mcp",
        "run",
        "--rm",
        "-T",
        "--no-deps",
        "mcp-server",
      ],
    },
  },
};

const prompt =
  "List the live services, then investigate the failing free-tier payments, " +
  "legacy billing renewals, and inventory reservations. Use one-hit snapshot " +
  "probes, report only redacted evidence, and remove every probe when finished.";

process.stdout.write(
  `\nExact stdio MCP configuration:\n${JSON.stringify(configuration, null, 2)}\n` +
    `\nFirst diagnostic prompt:\n${prompt}\n`,
);
