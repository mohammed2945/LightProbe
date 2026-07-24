import { access, copyFile, mkdir, writeFile } from "node:fs/promises";

await mkdir("dist/.openai", { recursive: true });
await copyFile(".openai/hosting.json", "dist/.openai/hosting.json");

try {
  await access("dist/server/index.js");
} catch {
  await access("dist/server/index.mjs");
  await writeFile(
    "dist/server/index.js",
    'export { default } from "./index.mjs";\nexport * from "./index.mjs";\n',
  );
}
