#!/usr/bin/env node
import { buildRepositoryIndex } from "./lib/repository-index.mjs";
const index = await buildRepositoryIndex();
console.log(`Indexed ${Object.keys(index.files).length} repository files at ${index.commit}.`);
