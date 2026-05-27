import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createServer } from "node:http";

const root = process.cwd();
const port = Number(process.env.PORT || 5178);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const requestPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(join(root, safePath));
  const fallbackPath = resolve(join(root, "index.html"));
  const target =
    filePath.startsWith(resolve(root)) && existsSync(filePath) && !statSync(filePath).isDirectory()
      ? filePath
      : fallbackPath;
  const type = mimeTypes[extname(target)] || "application/octet-stream";

  response.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  createReadStream(target).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Hide and Seek control: http://127.0.0.1:${port}`);
});
