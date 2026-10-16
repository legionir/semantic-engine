/**
 * استخراج وابستگی heuristic — فاز ۱۸.
 *
 * دو موردی که ارزیابی «گراف را بی‌اعتبار می‌کند» توصیف کرده بود، اینجا
 * آزموده می‌شوند:
 *
 *   Go   : import ( "a" "b" "c" )        → فقط اولی ثبت می‌شد
 *   Rust : use std::collections::{A, B}  → یک رشتهٔ خام
 */

import { HeuristicDependencyExtractor } from './HeuristicDependencyExtractor';
import { ImportEntry, ExportEntry } from '../../core/types/project-index.types';

const extractor = new HeuristicDependencyExtractor();

async function run(
  source: string,
  language: string,
  file = 'a'
): Promise<{ imports: readonly ImportEntry[]; exports: readonly ExportEntry[] }> {
  const result = await extractor.extractDependencies('f1', file, source, language);
  if (!result.ok) throw result.error;
  return { imports: result.value.imports, exports: result.value.exports };
}

describe('go import blocks (SE-DEP-02)', () => {

  /*
  | معیار پذیرش فاز: «فایل Go با ۵ import گروهی، ۵ یال بدهد.»
  |
  | کد قبلی روی بلوک چندخطی `block.match(/"([^"]+)"/)` می‌زد — یعنی
  | *اولین* رشته و بس. و بلوک چندخطی شکل استاندارد Go است، نه استثنا،
  | پس گراف وابستگی Go عملاً بی‌اعتبار بود.
  */
  it('records every import in a grouped block', async () => {
    const { imports } = await run(`package main

import (
	"fmt"
	"os"
	"strings"
	"net/http"
	"encoding/json"
)
`, 'go', 'a.go');

    expect(imports.map(i => i.from)).toEqual([
      'fmt', 'os', 'strings', 'net/http', 'encoding/json',
    ]);
  });

  it('classifies each one on its own', async () => {
    const { imports } = await run(`import (
	"fmt"
	"github.com/pkg/errors"
	"./local"
)
`, 'go', 'a.go');

    expect(imports.map(i => [i.from, i.type])).toEqual([
      ['fmt', 'builtin'],
      ['github.com/pkg/errors', 'package'],
      ['./local', 'local'],
    ]);
  });

  it('reads a named import in a block', async () => {
    const { imports } = await run(`import (
	json "encoding/json"
	_ "github.com/lib/pq"
)
`, 'go', 'a.go');

    expect(imports.map(i => i.from)).toEqual(['encoding/json', 'github.com/lib/pq']);
  });

  it('ignores comments inside a block', async () => {
    const { imports } = await run(`import (
	// the standard ones
	"fmt"
	"os" // trailing note
)
`, 'go', 'a.go');

    expect(imports.map(i => i.from)).toEqual(['fmt', 'os']);
  });

  it('still handles a single-line import', async () => {
    const { imports } = await run('import "fmt"\n', 'go', 'a.go');

    expect(imports.map(i => i.from)).toEqual(['fmt']);
  });

  it('handles two blocks in one file', async () => {
    const { imports } = await run(`import (
	"fmt"
)

import (
	"os"
)
`, 'go', 'a.go');

    expect(imports.map(i => i.from)).toEqual(['fmt', 'os']);
  });

  it('produces nothing for an empty block', async () => {
    const { imports } = await run('import (\n)\n', 'go', 'a.go');

    expect(imports).toEqual([]);
  });
});

describe('rust use groups (SE-DEP-09)', () => {

  /*
  | `use std::collections::{HashMap, HashSet};` به‌صورت یک رشتهٔ خام
  | ثبت می‌شد — که نه یک مسیر ماژول معتبر است و نه قابل resolve.
  */
  it('expands a braced group into one import per item', async () => {
    const { imports } = await run('use std::collections::{HashMap, HashSet};\n', 'rust', 'a.rs');

    expect(imports.map(i => i.from)).toEqual([
      'std::collections::HashMap',
      'std::collections::HashSet',
    ]);
  });

  it('keeps a plain use as it is', async () => {
    const { imports } = await run('use std::fmt::Display;\n', 'rust', 'a.rs');

    expect(imports.map(i => i.from)).toEqual(['std::fmt::Display']);
  });

  it('handles self inside a group', async () => {
    const { imports } = await run('use std::io::{self, Read};\n', 'rust', 'a.rs');

    expect(imports.map(i => i.from)).toEqual(['std::io', 'std::io::Read']);
  });

  it('never leaves a brace in a module path', async () => {
    const { imports } = await run(`use std::collections::{HashMap, HashSet};
use serde::{Serialize, Deserialize};
`, 'rust', 'a.rs');

    for (const entry of imports) {
      expect(entry.from).not.toMatch(/[{}]/);
    }
  });

  it('classifies a crate import as a package', async () => {
    const { imports } = await run('use serde::{Serialize};\n', 'rust', 'a.rs');

    expect(imports[0].type).toBe('package');
  });
});

describe('php exports (SE-DEP-09)', () => {

  /*
  | الگوی `(?:public\\s+|function\\s+)(\\w+)` روی `public $name;` هم
  | می‌افتد و یک پراپرتی را «صادرات» ثبت می‌کند. در PHP صادرات یعنی
  | چیزی که بیرون قابل ارجاع است — کلاس، interface، trait، تابع.
  */
  it('does not record a property as an export', async () => {
    const { exports } = await run(`<?php
class Repo {
    public $items = [];
    public function find($id) { return null; }
}
`, 'php', 'a.php');

    expect(exports.map(e => e.name)).not.toContain('items');
  });

  it('records a class as an export', async () => {
    const { exports } = await run("<?php\nclass Repo {}\n", 'php', 'a.php');

    expect(exports.map(e => e.name)).toContain('Repo');
  });

  it('records a top-level function as an export', async () => {
    const { exports } = await run("<?php\nfunction helper() {}\n", 'php', 'a.php');

    expect(exports.map(e => e.name)).toContain('helper');
  });

  it('records an interface and a trait', async () => {
    const { exports } = await run("<?php\ninterface Storage {}\ntrait Loggable {}\n", 'php', 'a.php');

    expect(exports.map(e => e.name)).toEqual(expect.arrayContaining(['Storage', 'Loggable']));
  });
});

describe('python imports still work', () => {

  it('reads a plain import', async () => {
    const { imports } = await run('import os\n', 'python', 'a.py');

    expect(imports.map(i => i.from)).toEqual(['os']);
  });

  it('reads a from-import with specifiers', async () => {
    const { imports } = await run('from pathlib import Path, PurePath\n', 'python', 'a.py');

    expect(imports[0].from).toBe('pathlib');
    expect(imports[0].specifiers?.map(s => s.imported)).toEqual(['Path', 'PurePath']);
  });
});
