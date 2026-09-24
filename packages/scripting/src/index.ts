import type {
  CompiledScriptBundle, Diagnostic, DiagnosticReport, ScriptCompilerApi, ScriptIR,
  ScriptSourceReference, WorldDocument,
} from '@dungeon-scrivener/model';
import { parseJavaScript } from './frontends/js/index.js';
import { parseLua } from './frontends/lua/index.js';
import { parsePython } from './frontends/python/index.js';
import { validateScriptIR } from './ir/index.js';

const COMPILER_DIAGNOSTIC = 'DS-SCRIPT-API-001';

function report(diagnostics: readonly Diagnostic[]): DiagnosticReport {
  return Object.freeze({
    format: 'dungeon-scrivener-diagnostics',
    schemaVersion: 1,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function metadataDiagnostic(reference: ScriptSourceReference, message: string): Diagnostic {
  return {
    code: COMPILER_DIAGNOSTIC,
    severity: 'error',
    message,
    path: reference.path,
    entityId: reference.id,
    blocks: ['script-execution', 'play', 'export'],
  };
}

function compile(source: string, reference: ScriptSourceReference): ScriptIR | DiagnosticReport {
  let result: { readonly ok: true; readonly ir: ScriptIR } | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };
  switch (reference.language) {
    case 'javascript':
      result = parseJavaScript(source, { scriptId: reference.id, sourcePath: reference.path });
      break;
    case 'lua':
      result = parseLua(source, { scriptId: reference.id, sourcePath: reference.path });
      break;
    case 'python':
      result = parsePython(source, { scriptId: reference.id, sourcePath: reference.path });
      break;
    default:
      return report([metadataDiagnostic(reference, `Unsupported script language ${String(reference.language)}.`)]);
  }

  if (!result.ok) return report(result.diagnostics);
  const { ir } = result;
  if (ir.scriptId !== reference.id || ir.sourcePath !== reference.path
      || ir.sourceLanguage !== reference.language || ir.entrypoint !== reference.entrypoint) {
    return report([metadataDiagnostic(reference, 'Compiled script metadata does not match its world declaration.')]);
  }
  const validation = validateScriptIR(ir);
  if (!validation.ok) return report(validation.diagnostics);
  return ir;
}

/** Implements the canonical compiler interface used by Studio and export builds. */
export const scriptCompiler: ScriptCompilerApi = Object.freeze({ compileScript: compile });

/** Convenience function with the public ScriptCompilerApi signature. */
export const compileScript: ScriptCompilerApi['compileScript'] = scriptCompiler.compileScript;

/**
 * Compile every declaration in a world into the exact bundle shape consumed by the engine.
 * `sourceForPath` must return the source bytes for the declared virtual path or undefined.
 */
export function compileWorldScripts(
  world: Pick<WorldDocument, 'scripts'>,
  sourceForPath: (path: string) => string | undefined,
): CompiledScriptBundle | DiagnosticReport {
  const compiled: ScriptIR[] = [];
  const diagnostics: Diagnostic[] = [];
  const declarations = new Set<string>();
  for (const reference of world.scripts) {
    if (declarations.has(reference.id)) {
      diagnostics.push(metadataDiagnostic(reference, `World declares script ID ${reference.id} more than once.`));
      continue;
    }
    declarations.add(reference.id);
    const source = sourceForPath(reference.path);
    if (source === undefined) {
      diagnostics.push(metadataDiagnostic(reference, `Declared script source ${reference.path} is missing.`));
      continue;
    }
    const result = scriptCompiler.compileScript(source, reference);
    if ('diagnostics' in result) diagnostics.push(...result.diagnostics);
    else compiled.push(result);
  }
  if (diagnostics.length > 0) return report(diagnostics);
  return Object.freeze({
    format: 'dungeon-scrivener-compiled-script-bundle',
    schemaVersion: 1,
    scripts: Object.freeze(compiled),
  });
}

export { ScriptExecutor, scriptExecutor } from './executor/index.js';
export { SCRIPT_IR_LIMITS, validateScriptIR } from './ir/index.js';
export type {
  CompiledScriptBundle, DiagnosticReport, ScriptCompilerApi, ScriptExecutionContext,
  ScriptExecutionResult, ScriptExecutionTraceRecord, ScriptIR, ScriptSourceReference, WorldDocument,
} from '@dungeon-scrivener/model';
