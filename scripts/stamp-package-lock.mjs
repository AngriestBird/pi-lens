#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const lock = new URL("package-lock.json", root);
const stamp = new URL("node_modules/.pi-lens-package-lock-sha256", root);
const hash = createHash("sha256").update(readFileSync(lock)).digest("hex");
writeFileSync(stamp, `${hash}\n`);
