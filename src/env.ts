import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Minimal, dependency-free `.env` loader.
 *
 * Loads the first `.env` found and copies any keys that are NOT already present
 * in the environment, so an MCP client's `env` block always wins over the file.
 * Search order:
 *   1. $HYPEDEXER_ENV_FILE (explicit override, if set)
 *   2. <cwd>/.env
 *   3. the package root next to dist/ (robust when the launcher sets an
 *      unrelated cwd, e.g. Claude Desktop spawning via wsl.exe)
 *
 * Missing/unreadable files are ignored. Nothing is ever written to stdout —
 * the stdio transport owns it; diagnostics go to stderr only.
 */
export function loadDotenv(): void {
  for (const file of candidateFiles()) {
    if (tryLoad(file)) return
  }
}

function candidateFiles(): string[] {
  const files: string[] = []
  const override = process.env.HYPEDEXER_ENV_FILE?.trim()
  if (override) files.push(resolve(override))
  files.push(resolve(process.cwd(), '.env'))
  // Bundled output lives at dist/index.js, so the package root is one level up.
  const here = dirname(fileURLToPath(import.meta.url))
  files.push(resolve(here, '..', '.env'))
  return files
}

function tryLoad(file: string): boolean {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  for (const [key, value] of parseDotenv(text)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
  return true
}

/** Parse `.env` text into [key, value] pairs. Tolerant: skips blanks/comments. */
export function parseDotenv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const body = line.startsWith('export ') ? line.slice(7).trimStart() : line
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out.push([key, unquote(body.slice(eq + 1).trim())])
  }
  return out
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const q = value[0]
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      const inner = value.slice(1, -1)
      // Only double quotes get backslash-escape expansion.
      return q === '"' ? inner.replace(/\\n/g, '\n') : inner
    }
  }
  // Unquoted: drop a trailing ` #inline comment`.
  const hash = value.indexOf(' #')
  return hash === -1 ? value : value.slice(0, hash).trimEnd()
}
