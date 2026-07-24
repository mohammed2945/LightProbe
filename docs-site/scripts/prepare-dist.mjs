import { access, rename, rm } from "node:fs/promises";

await access("out");
await rm("dist", { recursive: true, force: true });
await rename("out", "dist");
