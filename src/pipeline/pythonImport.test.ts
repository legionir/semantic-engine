import { resolvePythonImport, resolveGoImport, resolveRustImport, resolveJavaImport, resolveProjectImport } from './IndexPipeline';
import type { FileEntry } from '../core/types/project-index.types';

/*
| Regression for Python import resolution: dotted relative (PEP-328) and
| absolute module paths must map to real project files, so cross-module
| dependencies stop collapsing to `pkg:..models.user` and get_dependencies /
| impact_analysis become correct for Python.
*/

const paths = [
  'models/user.py',
  'models/__init__.py',
  'services/payment_service.py',
  'services/sibling.py',
  'auth/jwt_handler.py',
  'pkg/deep/mod.py',
];
const files = paths.map((p, i) => ({ id: `f${i}`, path: p })) as unknown as FileEntry[];

function targetOf(spec: string, fromFile: string): string | undefined {
  return resolvePythonImport(spec, fromFile, files)?.path;
}

describe('resolvePythonImport', () => {
  it('resolves a two-dot relative import to the sibling package file', () => {
    expect(targetOf('..models.user', 'services/payment_service.py')).toBe('models/user.py');
  });

  it('resolves a one-dot relative import within the current package', () => {
    expect(targetOf('.sibling', 'services/payment_service.py')).toBe('services/sibling.py');
  });

  it('resolves a package (directory) import to __init__.py', () => {
    expect(targetOf('..models', 'services/payment_service.py')).toBe('models/__init__.py');
  });

  it('resolves an absolute dotted module to its file', () => {
    expect(targetOf('pkg.deep.mod', 'auth/jwt_handler.py')).toBe('pkg/deep/mod.py');
  });

  it('returns undefined for an external/unmatched import', () => {
    expect(targetOf('typing', 'models/user.py')).toBeUndefined();
    expect(targetOf('..nonexistent', 'services/payment_service.py')).toBeUndefined();
  });
});

/*
| Go imports reference a package (directory) via a module path, not a file.
| They were previously typed `builtin` and never resolved, so intra-repo Go
| dependencies (get_dependencies / impact) were silently wrong. resolveGoImport
| maps a module path to the package directory's representative file.
*/
const goFiles = [
  'main.go',
  'handlers/auth.go',
  'store/db.go',
  'store/store.go',
].map((p, i) => ({ id: `g${i}`, path: p })) as unknown as FileEntry[];

describe('resolveGoImport', () => {
  it('resolves a module-path package import to the package file (prefers <pkg>/<pkg>.go)', () => {
    expect(resolveGoImport('go-microservice/store', goFiles)?.path).toBe('store/store.go');
    expect(resolveGoImport('go-microservice/handlers', goFiles)?.path).toBe('handlers/auth.go');
  });

  it('does not resolve stdlib / external imports to a repo file', () => {
    expect(resolveGoImport('net/http', goFiles)).toBeUndefined();
    expect(resolveGoImport('fmt', goFiles)).toBeUndefined();
  });
});

/*
| Rust wires files together with `mod`/`use`; the heuristic extractor emits the
| module name as a bare local import (and `use a::B` as a package), which
| TSPathResolver cannot map, so intra-crate deps were lost. resolveRustImport
| walks the module path to `<dir>/<mod>.rs` / `<dir>/<mod>/mod.rs`.
*/
const rustFiles = [
  'src/main.rs',
  'src/engine.rs',
  'src/parser/mod.rs',
  'src/parser/helpers.rs',
  'src/security/crypto.rs',
].map((p, i) => ({ id: `r${i}`, path: p })) as unknown as FileEntry[];

describe('resolveRustImport', () => {
  it('resolves `mod parser;` to the module file (dir/mod.rs form)', () => {
    expect(resolveRustImport('parser', 'src/main.rs', rustFiles)?.path).toBe('src/parser/mod.rs');
  });

  it('resolves `use parser::Parser` by the longest module prefix', () => {
    expect(resolveRustImport('parser::Parser', 'src/main.rs', rustFiles)?.path).toBe('src/parser/mod.rs');
  });

  it('honours self:: and super:: relative to the importing file', () => {
    expect(resolveRustImport('self::helpers', 'src/parser/mod.rs', rustFiles)?.path).toBe('src/parser/helpers.rs');
    expect(resolveRustImport('super::engine', 'src/parser/mod.rs', rustFiles)?.path).toBe('src/engine.rs');
  });

  it('honours crate:: from the crate root', () => {
    expect(resolveRustImport('crate::parser::helpers', 'src/engine.rs', rustFiles)?.path).toBe('src/parser/helpers.rs');
  });

  it('leaves external / not-a-module imports unresolved', () => {
    expect(resolveRustImport('serde', 'src/main.rs', rustFiles)).toBeUndefined();
    // `security` has only crypto.rs (no mod.rs) — an honest non-match, not a guess
    expect(resolveRustImport('security', 'src/main.rs', rustFiles)).toBeUndefined();
  });
});

/*
| Java imports are fully-qualified class names; the heuristic extractor typed
| them `package`, so intra-project `import com.example.service.UserService`
| never resolved and UserController -> UserService was lost. resolveJavaImport
| maps the FQN to a `<pkg>/Class.java` file by suffix (source-root agnostic).
*/
const javaFiles = [
  'src/main/java/com/example/Application.java',
  'src/main/java/com/example/controller/UserController.java',
  'src/main/java/com/example/service/UserService.java',
  'src/main/java/com/example/service/AuditService.java',
].map((p, i) => ({ id: `j${i}`, path: p })) as unknown as FileEntry[];

describe('resolveJavaImport', () => {
  it('resolves a fully-qualified class import to its file, ignoring the source root', () => {
    expect(resolveJavaImport('com.example.service.UserService', javaFiles)?.path)
      .toBe('src/main/java/com/example/service/UserService.java');
  });

  it('resolves a static import to the owning class via the longest prefix', () => {
    expect(resolveJavaImport('com.example.service.UserService.NAME', javaFiles)?.path)
      .toBe('src/main/java/com/example/service/UserService.java');
  });

  it('resolves a wildcard package import to a file in that package', () => {
    const r = resolveJavaImport('com.example.service.*', javaFiles)?.path ?? '';
    expect(r).toContain('/com/example/service/');
    expect(r.endsWith('.java')).toBe(true);
  });

  it('leaves JDK / unknown classes unresolved', () => {
    expect(resolveJavaImport('java.util.List', javaFiles)).toBeUndefined();
    expect(resolveJavaImport('com.example.service.Missing', javaFiles)).toBeUndefined();
  });
});

/*
| C/C++, Ruby, PHP, Kotlin wired through the shared resolveProjectImport
| dispatcher: each encodes an intra-project file reference that TSPathResolver
| could not map (quoted include, require_relative, relative require, FQN .kt).
*/
function mk(paths: string[]) {
  return paths.map((p, i) => ({ id: `x${i}`, path: p })) as unknown as FileEntry[];
}

describe('resolveProjectImport — C/C++, Ruby, PHP, Kotlin', () => {
  const cppFiles = mk(['include/engine.hpp', 'src/engine.cpp', 'src/main.cpp']);
  it('C/C++ resolves a quoted relative include to the header file', () => {
    expect(resolveProjectImport('cpp', '../include/engine.hpp', 'src/engine.cpp', cppFiles)?.path).toBe('include/engine.hpp');
    expect(resolveProjectImport('c', 'engine.hpp', 'src/main.cpp', cppFiles)?.path).toBe('include/engine.hpp');
  });

  const rubyFiles = mk(['app/models/order.rb', 'app/services/order_processor.rb']);
  it('Ruby resolves require_relative to the .rb file', () => {
    expect(resolveProjectImport('ruby', '../models/order', 'app/services/order_processor.rb', rubyFiles)?.path).toBe('app/models/order.rb');
  });

  const phpFiles = mk(['src/Foo.php', 'src/Controller/AuthController.php']);
  it('PHP resolves a relative require to the .php file', () => {
    expect(resolveProjectImport('php', './src/Foo.php', 'index.php', phpFiles)?.path).toBe('src/Foo.php');
  });

  const ktFiles = mk(['src/main/kotlin/com/example/App.kt']);
  it('Kotlin resolves a fully-qualified import to its .kt file', () => {
    expect(resolveProjectImport('kotlin', 'com.example.App', 'src/main/kotlin/com/example/Main.kt', ktFiles)?.path).toBe('src/main/kotlin/com/example/App.kt');
    expect(resolveProjectImport('kotlin', 'kotlin.collections.List', 'src/main/kotlin/com/example/App.kt', ktFiles)).toBeUndefined();
  });

  it('leaves TS/JS to the caller (dispatcher returns undefined, not a guess)', () => {
    expect(resolveProjectImport('typescript', './x', 'src/a.ts', cppFiles)).toBeUndefined();
  });
});
