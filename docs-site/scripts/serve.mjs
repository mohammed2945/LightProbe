import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist");
const host = process.env.HOSTNAME ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

async function resolvePath(pathname) {
  const safePath = normalize(decodeURIComponent(pathname)).replace(
    /^(\.\.(\/|\\|$))+/,
    "",
  );
  const candidate = join(root, safePath);
  const attempts = extname(candidate)
    ? [candidate]
    : [join(candidate, "index.html"), `${candidate}.html`];

  for (const attempt of attempts) {
    try {
      await access(attempt);
      if ((await stat(attempt)).isFile()) return attempt;
    } catch {
      // Try the next static route form.
    }
  }
  return join(root, "404.html");
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const file = await resolvePath(url.pathname);

  try {
    const fileStat = await stat(file);
    response.writeHead(file.endsWith("404.html") ? 404 : 200, {
      "content-length": fileStat.size,
      "content-type":
        contentTypes[extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(500).end("Unable to read static output.");
  }
}).listen(port, host, () => {
  console.log(`LiveProbe docs listening on http://${host}:${port}`);
});
