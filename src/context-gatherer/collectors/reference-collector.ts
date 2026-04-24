// src/context-gatherer/collectors/reference-collector.ts
import { spawnSync } from 'child_process'
import type { RawReference } from '../types.js'

/**
 * Common keywords to exclude from symbol extraction (language-spanning)
 */
const STOP_SYMBOLS = new Set([
  // JS/TS
  'get', 'set', 'new', 'for', 'if', 'do', 'var', 'let', 'const', 'return',
  'else', 'case', 'break', 'continue', 'switch', 'while', 'try', 'catch',
  'throw', 'typeof', 'void', 'delete', 'import', 'export', 'default', 'from',
  'async', 'await', 'yield', 'class', 'extends', 'super', 'this',
  // Go
  'func', 'type', 'struct', 'interface', 'map', 'chan', 'range', 'defer',
  'select', 'nil', 'err', 'error', 'string', 'bool', 'int', 'int32', 'int64',
  'uint', 'uint32', 'uint64', 'float32', 'float64', 'byte', 'rune', 'len',
  'cap', 'make', 'append', 'copy', 'close', 'panic', 'recover', 'println',
  'true', 'false', 'init', 'main',
  // C/C++
  'void', 'int', 'char', 'bool', 'auto', 'long', 'short', 'unsigned',
  'signed', 'float', 'double', 'size_t', 'nullptr', 'static', 'const',
  'virtual', 'override', 'inline', 'explicit', 'template', 'typename',
  'namespace', 'using', 'public', 'private', 'protected',
  // Proto
  'message', 'service', 'rpc', 'enum', 'oneof', 'optional', 'repeated',
  'required', 'reserved', 'returns', 'option',
  // Python
  'def', 'self', 'cls', 'None', 'True', 'False', 'pass', 'with', 'lambda',
  // Java/Scala
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized',
  'val', 'var', 'object', 'trait', 'extends', 'with', 'override',
])

/**
 * Extract function/class/struct names from diff (multi-language)
 */
export function extractSymbolsFromDiff(diff: string): string[] {
  const symbols: Set<string> = new Set()

  const patterns: RegExp[] = [
    // JS/TS: function name(, async function name(
    /^\+.*(?:function|async function)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm,
    // JS/TS: const name = (, const name = async (
    /^\+.*(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\(/gm,
    // JS/TS: const name = (...) =>
    /^\+.*(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
    // JS/TS: class Name
    /^\+.*class\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
    // JS/TS: method definitions in classes
    /^\+\s+(?:async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*[:{]/gm,
    // JS/TS: export declarations
    /^\+.*export\s+(?:const|let|var|function|class|async function)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
    // Go: func Name(, func (receiver) Name(
    /^\+.*func\s+(?:\([^)]*\)\s+)?([A-Z][a-zA-Z0-9_]*)\s*\(/gm,
    // Go: type Name struct/interface
    /^\+.*type\s+([A-Z][a-zA-Z0-9_]*)\s+(?:struct|interface)\b/gm,
    // C/C++: return-type FunctionName(
    /^\+.*(?:void|int|bool|char|auto|Status|string|std::string|size_t|int32_t|int64_t|uint32_t|uint64_t|float|double)\s+([A-Z][a-zA-Z0-9_]*)\s*\(/gm,
    // C/C++: ClassName::MethodName(
    /^\+.*([A-Z][a-zA-Z0-9_]*)::\s*([A-Z][a-zA-Z0-9_]*)\s*\(/gm,
    // C/C++: class/struct Name
    /^\+.*(?:class|struct)\s+([A-Z][a-zA-Z0-9_]*)/gm,
    // Proto: message Name, service Name, rpc Name
    /^\+\s*(?:message|service)\s+([A-Z][a-zA-Z0-9_]*)/gm,
    /^\+\s*rpc\s+([A-Z][a-zA-Z0-9_]*)\s*\(/gm,
    // Python: def name(, class Name
    /^\+\s*def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm,
    /^\+\s*class\s+([A-Z][a-zA-Z0-9_]*)/gm,
    // Java/Scala: public/private type Name(
    /^\+\s*(?:public|private|protected)?\s*(?:static\s+)?(?:def|void|int|boolean|String|long|double|float|[A-Z][a-zA-Z0-9_<>]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(diff)) !== null) {
      // For C++ ClassName::MethodName pattern, capture both parts
      const name = match[2] || match[1]
      if (name && name.length > 2 && !STOP_SYMBOLS.has(name)) {
        symbols.add(name)
      }
      // Also add the class name for Class::Method patterns
      if (match[2] && match[1] && match[1].length > 2 && !STOP_SYMBOLS.has(match[1])) {
        symbols.add(match[1])
      }
    }
  }

  return Array.from(symbols)
}

/**
 * Find references to symbols using ripgrep
 */
export function findReferences(symbols: string[], cwd: string = process.cwd()): RawReference[] {
  const references: RawReference[] = []

  for (const symbol of symbols) {
    try {
      // Use ripgrep to find all occurrences
      // -n: line numbers, -H: filename, --no-heading: no grouping
      // -F: fixed-string (literal match, no regex), -e: explicitly marks pattern argument
      const result = spawnSync('rg', [
        '-n', '-H', '--no-heading',
        '-F',
        '-e', symbol,
        '--type-add', 'code:*.{go,cpp,cc,cxx,h,hpp,hxx,c,py,java,scala,ts,tsx,js,jsx,rs,proto,cs}',
        '--type', 'code',
      ], { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 })

      const output = result.stdout || ''
      if (!output.trim()) continue

      const foundInFiles: { file: string; line: number; content: string }[] = []
      const lines = output.trim().split('\n')

      for (const line of lines) {
        // Format: file:line:content
        const match = line.match(/^([^:]+):(\d+):(.*)$/)
        if (match) {
          foundInFiles.push({
            file: match[1],
            line: parseInt(match[2], 10),
            content: match[3].trim()
          })
        }
      }

      if (foundInFiles.length > 0) {
        references.push({ symbol, foundInFiles })
      }
    } catch {
      // Ignore errors (e.g., ripgrep not found)
    }
  }

  return references
}

/**
 * Format raw references into a structured call chain text for reviewers.
 * Shows each changed symbol with its callers and code snippets.
 */
export function formatCallChainForReviewer(references: RawReference[]): string {
  if (references.length === 0) return ''

  const sections = references.map(ref => {
    const callers = ref.foundInFiles.slice(0, 10) // Limit to 10 callers
    const callerLines = callers.map((f, i) =>
      `${i + 1}. ${f.file}:${f.line}\n   > ${f.content.slice(0, 150)}`
    ).join('\n\n')

    return `### Callers of \`${ref.symbol}\`
Found in ${ref.foundInFiles.length} locations:

${callerLines}`
  })

  return `## Call Chain Context\n\n${sections.join('\n\n---\n\n')}`
}

/**
 * Collect all references for changed files
 */
export function collectReferences(diff: string, cwd: string = process.cwd()): RawReference[] {
  const symbols = extractSymbolsFromDiff(diff)
  return findReferences(symbols, cwd)
}
