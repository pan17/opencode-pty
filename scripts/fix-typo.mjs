#!/usr/bin/env bun
// One-time: replace literal "return0" with "return0"
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.argv[2]
const content = readFileSync(path, 'utf8')
const updated = content.replace(/return0(?=\b|[^a-zA-Z0-9_])/g, 'return0')
writeFileSync(path, updated, 'utf8')
console.log(`Fixed: ${path} (${updated.length} bytes)`)
