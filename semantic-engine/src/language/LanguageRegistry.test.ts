import { LanguageRegistry } from './LanguageRegistry';
import { getSymbolExtractionMethod, ALL_LANGUAGES } from './languageMap';

describe('LanguageRegistry', () => {
  const registry = new LanguageRegistry();

  it('should detect typescript and javascript', () => {
    expect(registry.detect('src/app.ts')?.id).toBe('typescript');
    expect(registry.detect('src/app.js')?.id).toBe('javascript');
    expect(registry.detect('src/app.tsx')?.id).toBe('typescriptreact');
    expect(registry.detect('src/app.jsx')?.id).toBe('javascriptreact');
  });

  it('should detect imperative languages', () => {
    expect(registry.detect('src/User.java')?.id).toBe('java');
    expect(registry.detect('src/lib.rs')?.id).toBe('rust');
    expect(registry.detect('src/Program.cs')?.id).toBe('csharp');
    expect(registry.detect('src/main.cpp')?.id).toBe('cpp');
    expect(registry.detect('src/main.rb')?.id).toBe('ruby');
  });

  it('should detect declarative languages', () => {
    expect(registry.detect('src/index.html')?.id).toBe('html');
    expect(registry.detect('src/styles.css')?.id).toBe('css');
    expect(registry.detect('src/config.json')?.id).toBe('json');
  });

  it('should support deep analysis for all languages with extractors', () => {
    const supportedIds = [
      'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
      'python', 'go', 'php', 'shellscript',
      'java', 'rust', 'csharp', 'c', 'cpp', 'ruby', 'swift', 'kotlin',
      'json', 'html', 'css', 'scss', 'less',
    ];

    for (const id of supportedIds) {
      const lang = ALL_LANGUAGES.find(l => l.id === id);
      expect(lang?.deepAnalysisSupported).toBe(true);
    }
  });

  it('should return correct extraction method', () => {
    expect(getSymbolExtractionMethod('typescript')).toBe('lsp');
    expect(getSymbolExtractionMethod('python')).toBe('heuristic');
    expect(getSymbolExtractionMethod('java')).toBe('imperative');
    expect(getSymbolExtractionMethod('json')).toBe('declarative');
    expect(getSymbolExtractionMethod('yaml')).toBeNull();
  });
});
