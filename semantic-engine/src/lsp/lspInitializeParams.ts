/**
 * The `initialize` request parameters this client sends: identity, workspace
 * folders and the capabilities it implements.
 */

import { pathToFileURL } from 'url';

/** نام و نسخه‌ای که به سرور معرفی می‌کنیم. */
export const CLIENT_NAME = 'semantic-engine';

export function buildInitializeParams(
  rootPath: string,
  initializationOptions: unknown
): Record<string, unknown> {
  const rootUri = pathToFileURL(rootPath).toString();
  return {
    processId: process.pid,
    clientInfo: { name: CLIENT_NAME },
    locale: 'en',
    // `rootPath` منسوخ است ولی چند سرور هنوز فقط همان را می‌خوانند.
    rootPath: rootPath,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: CLIENT_NAME }],
    initializationOptions: initializationOptions,
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      workspace: {
        workspaceFolders: true,
        configuration: true,
        didChangeConfiguration: { dynamicRegistration: true },
        didChangeWatchedFiles: { dynamicRegistration: true },
      },
      window: { workDoneProgress: true },
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: true },
        documentSymbol: {
          dynamicRegistration: false,
          hierarchicalDocumentSymbolSupport: true,
          symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) },
        },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
        publishDiagnostics: { relatedInformation: true },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
      },
    },
  };
}
