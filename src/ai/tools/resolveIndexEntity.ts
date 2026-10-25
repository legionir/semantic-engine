import { ProjectIndexReader } from '../ProjectIndexReader';

/**
 * Resolve the identifiers accepted by graph tools.
 *
 * The index stores stable file/symbol ids, while an MCP client often has a
 * path or a fully-qualified `path::Symbol` from a previous tool result. All
 * of those are unambiguous enough to resolve locally and accepting them
 * avoids a misleading successful empty result.
 */
export function resolveFileOrSymbolId(
  reader: ProjectIndexReader,
  value: string
): string | null {
  if (reader.getFileById(value) || reader.getSymbolById(value)) return value;

  const file = reader.getFileByPath(value);
  if (file) return file.id;

  const separator = value.lastIndexOf('::');
  if (separator > 0) {
    const filePath = value.slice(0, separator);
    const symbolName = value.slice(separator + 2);
    const owner = reader.getFileByPath(filePath);
    if (owner) {
      const symbol = reader
        .getSymbolsForFile(owner.id)
        .find(candidate => candidate.name === symbolName || candidate.fullyQualifiedName === value);
      if (symbol) return symbol.id;
    }
  }

  const symbols = reader.getSymbolsByName(value);
  return symbols.length === 1 ? symbols[0]!.id : null;
}

export function resolveSymbolId(
  reader: ProjectIndexReader,
  value: string
): string | null {
  if (reader.getSymbolById(value)) return value;

  const separator = value.lastIndexOf('::');
  if (separator > 0) {
    const owner = reader.getFileByPath(value.slice(0, separator));
    const name = value.slice(separator + 2);
    const symbol = owner
      ? reader.getSymbolsForFile(owner.id).find(candidate => candidate.name === name)
      : undefined;
    if (symbol) return symbol.id;
  }

  const symbols = reader.getSymbolsByName(value);
  return symbols.length === 1 ? symbols[0]!.id : null;
}
