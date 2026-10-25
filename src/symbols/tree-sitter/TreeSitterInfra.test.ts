/**
 * کش AST و مدیر parser — SE-SYM-14 و SE-SYM-15.
 *
 * دو نقص زیرساختی که هیچ‌کدام روی fixture کوچک دیده نمی‌شوند و هر دو
 * روی مخزن واقعی مهم‌اند:
 *
 *   SE-SYM-14 — کش هیچ سقفی نداشت. درخت‌های tree-sitter در حافظهٔ
 *   WASM زندگی می‌کنند و با GC جاوااسکریپت آزاد نمی‌شوند؛ روی مخزن
 *   بزرگ یعنی OOM.
 *
 *   SE-SYM-15 — `ensureInitialized` در برابر فراخوانی همزمان محافظت
 *   نشده بود، و `dispose` پرچم `initialized` را ریست نمی‌کرد.
 */

import * as path from 'path';
import { TreeSitterAstCache } from './TreeSitterAstCache';
import { TreeSitterParserManager } from './TreeSitterParserManager';

const GRAMMARS = path.join(__dirname, '..', '..', '..', 'tree-sitter-grammars');

/** یک درخت بدلی — فقط باید `delete()` قابل شمارش داشته باشد. */
function fakeTree(): { delete: jest.Mock } {
  return { delete: jest.fn() };
}

describe('TreeSitterAstCache', () => {

  it('returns a tree when the content hash matches', () => {
    const cache = new TreeSitterAstCache();
    const tree = fakeTree();

    cache.set('f1', 'hash-a', tree as never, 'typescript');

    expect(cache.get('f1', 'hash-a')?.tree).toBe(tree);
  });

  it('refuses a stale tree when the content changed', () => {
    const cache = new TreeSitterAstCache();
    cache.set('f1', 'hash-a', fakeTree() as never, 'typescript');

    expect(cache.get('f1', 'hash-b')).toBeUndefined();
  });

  it('deletes the old tree when a file is re-parsed', () => {
    const cache = new TreeSitterAstCache();
    const first = fakeTree();

    cache.set('f1', 'hash-a', first as never, 'typescript');
    cache.set('f1', 'hash-b', fakeTree() as never, 'typescript');

    expect(first.delete).toHaveBeenCalledTimes(1);
  });

  describe('bounded size (SE-SYM-14)', () => {

    /*
    | بدون سقف، کش یک درخت به‌ازای هر فایل نگه می‌دارد. روی مخزنی با
    | ده‌ها هزار فایل، حافظهٔ WASM پر می‌شود و پروسه می‌میرد — و چون
    | آزادسازی دست GC نیست، هیچ فشار حافظه‌ای هم آن را نجات نمی‌دهد.
    */
    it('never holds more than its limit', () => {
      const cache = new TreeSitterAstCache({ maxEntries: 3 });

      for (let index = 0; index < 10; index++) {
        cache.set(`f${index}`, 'h', fakeTree() as never, 'typescript');
      }

      expect(cache.size()).toBe(3);
    });

    it('frees the wasm tree of whatever it evicts', () => {
      const cache = new TreeSitterAstCache({ maxEntries: 2 });
      const first = fakeTree();

      cache.set('f1', 'h', first as never, 'typescript');
      cache.set('f2', 'h', fakeTree() as never, 'typescript');
      cache.set('f3', 'h', fakeTree() as never, 'typescript');

      expect(first.delete).toHaveBeenCalledTimes(1);
      expect(cache.get('f1', 'h')).toBeUndefined();
    });

    it('evicts the least recently used entry, not the oldest inserted', () => {
      const cache = new TreeSitterAstCache({ maxEntries: 2 });
      cache.set('f1', 'h', fakeTree() as never, 'typescript');
      cache.set('f2', 'h', fakeTree() as never, 'typescript');

      cache.get('f1', 'h');                                  // f1 دوباره استفاده شد
      cache.set('f3', 'h', fakeTree() as never, 'typescript');

      expect(cache.get('f1', 'h')).toBeDefined();
      expect(cache.get('f2', 'h')).toBeUndefined();
    });

    it('counts a getTree as a use as well', () => {
      const cache = new TreeSitterAstCache({ maxEntries: 2 });
      cache.set('f1', 'h', fakeTree() as never, 'typescript');
      cache.set('f2', 'h', fakeTree() as never, 'typescript');

      cache.getTree('f1');
      cache.set('f3', 'h', fakeTree() as never, 'typescript');

      expect(cache.getTree('f1')).toBeDefined();
      expect(cache.getTree('f2')).toBeUndefined();
    });

    it('has a default limit rather than none at all', () => {
      const cache = new TreeSitterAstCache();

      for (let index = 0; index < 1200; index++) {
        cache.set(`f${index}`, 'h', fakeTree() as never, 'typescript');
      }

      expect(cache.size()).toBeLessThanOrEqual(1024);
      expect(cache.size()).toBeGreaterThan(0);
    });

    it('frees everything on clear', () => {
      const cache = new TreeSitterAstCache({ maxEntries: 4 });
      const trees = [fakeTree(), fakeTree()];
      trees.forEach((tree, index) => cache.set(`f${index}`, 'h', tree as never, 'typescript'));

      cache.clear();

      expect(trees.every(tree => tree.delete.mock.calls.length === 1)).toBe(true);
      expect(cache.size()).toBe(0);
    });
  });
});

describe('TreeSitterParserManager', () => {

  let manager: TreeSitterParserManager;

  beforeEach(() => {
    manager = new TreeSitterParserManager({ grammarDir: GRAMMARS });
  });

  afterEach(async () => {
    await manager.dispose();
  });

  it('reports the languages it has grammars for', async () => {
    await expect(manager.isAvailable('typescript')).resolves.toBe(true);
    await expect(manager.isAvailable('javascript')).resolves.toBe(true);
    // Python/Ruby/PHP/C# حالا گرامر دارند. زبانی که ندارد (zig):
    await expect(manager.isAvailable('zig')).resolves.toBe(false);
    await expect(manager.isAvailable('python')).resolves.toBe(true);
  });

  /*
  | SE-SYM-15 — بدون محافظت، ده فایل که هم‌زمان شروع می‌شوند ده بار
  | `Parser.init()` را صدا می‌زنند. باید یک بار اتفاق بیفتد و بقیه
  | منتظر همان یکی بمانند.
  */
  it('initialises once even when called concurrently', async () => {
    const initSpy = jest.spyOn(manager as never, 'runInit');

    await Promise.all(Array.from({ length: 10 }, () => manager.isAvailable('typescript')));

    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('can be used again after dispose', async () => {
    await manager.getParser('typescript');
    await manager.dispose();

    await expect(manager.isAvailable('typescript')).resolves.toBe(true);
    expect(await manager.getParser('typescript')).not.toBeNull();
  });

  it('hands out one parser per language', async () => {
    const first = await manager.getParser('typescript');
    const second = await manager.getParser('typescript');

    expect(first).toBe(second);
  });

  it('returns null for a language it has no grammar for', async () => {
    expect(await manager.getParser('zig')).toBeNull();
  });
});
