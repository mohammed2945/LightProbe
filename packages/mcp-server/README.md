# LiveProbe MCP

Laptop-friendly stdio MCP server for connecting AI tools to a running
LiveProbe broker.

## Run with npx

```sh
npx -y @doomslayer2945/liveprobe-mcp@0.1.0 --broker-url http://HOST:7070
```

`--broker-url` takes precedence over `BROKER_URL`. If neither is supplied, the
server connects to `http://127.0.0.1:7070`.

## Cursor configuration

Add this server to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "liveprobe": {
      "command": "npx",
      "args": [
        "-y",
        "@doomslayer2945/liveprobe-mcp@0.1.0",
        "--broker-url",
        "http://HOST:7070"
      ]
    }
  }
}
```

Run `npx -y @doomslayer2945/liveprobe-mcp@0.1.0 --help` for CLI options.
