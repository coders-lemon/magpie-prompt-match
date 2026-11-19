import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");
const entryPath = path.join(rootDir, "src", "middleware-entry.ts");
const outDir = path.join(rootDir, "dist");

fs.mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [entryPath],
  outdir: outDir,
  naming: "middleware.js",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const outFile = path.join(outDir, "middleware.js");
const code = fs.readFileSync(outFile, "utf8");

// Guard against accidental Node/Bun imports that would fail in Magpie's moejs runtime
if (/\bfrom\s+["']node:|require\(["']node:/.test(code)) {
  console.error("ERROR: dist/middleware.js contains node:* imports, which moejs forbids.");
  process.exit(1);
}

console.log(`Built ${outFile} (${code.length} bytes)`);
