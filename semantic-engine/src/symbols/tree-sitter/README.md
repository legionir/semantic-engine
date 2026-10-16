# Tree-sitter Symbol Extractor

پیاده‌سازی استخراج symbol مبتنی بر tree-sitter برای TypeScript / JavaScript / TSX / JSX.

## وضعیت

- ✅ WASM grammar ها از `tree-sitter-grammars/` بارگذاری می‌شوند.
- ✅ `TreeSitterParserManager` parser ها را init و cache می‌کند.
- ✅ `TreeSitterAstCache` parse tree ها را بر اساس hash محتوا cache می‌کند.
- ✅ `TreeSitterIncrementalParser` reparse incremental با API tree-sitter را پشتیبانی می‌کند.
- ✅ `TreeSitterSymbolExtractor` اینترفیس `ISymbolExtractor` را implement کرده و در fallback chain بین LSP (priority=100) و heuristic (priority=10) با priority=50 ثبت شده است.

## fallback chain

```
LSP (100) → tree-sitter (50) → heuristic (10)
```

## زبان‌های پشتیبانی‌شده

`full` — نماد، امضا، پارامتر، پیچیدگی و گراف فراخوانی:

- `typescript`
- `javascript`
- `typescriptreact` (tsx)
- `javascriptreact` (jsx)

`structural` — نماد و ساختار از AST، بدون گراف فراخوانی (اعلام می‌شود:
`describeLanguageSupport`):

- `python` · `go` · `java` · `rust` · `csharp` · `php` · `ruby`
- `kotlin` · `swift` — AI-06 (cycle-7). این دو گرامر با همان محیطی که
  پروژه اجرا می‌شود build و validate شدند: `tree-sitter-cli@0.24.7` +
  `emsdk` (0.26 به GLIBC 2.39 نیاز دارد؛ host این CI 2.35 است) از
  پکیج‌های رسمی `tree-sitter-kotlin@0.3.8` / `tree-sitter-swift@0.7.1`،
  و روی همان `web-tree-sitter@0.26.11` بارگذاری/پارس می‌شوند. نام گره‌ها
  از probe روی همین wasmها گرفته شده، نه از حدس؛ تفکیک
  class/interface/enum/struct/protocol با `kindFromKeyword` انجام می‌شود
  (قبلاً هر دو ادعا می‌شدند ABI سازگار ندارند — با اندازه‌گیری ابطال
  شد: `audit/DECISIONS.md` D-19).

## provenance گرامرها

فایل‌های `tree-sitter-grammars/*.wasm` باینری‌های commit‌شده‌اند. برای
بازتولید kotlin/swift:

```bash
npm i -g tree-sitter-cli@0.24.7   # یا npx tree-sitter-cli@0.24.7
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
# grammarها را از npm دانلود و در پوشهٔ منبع استخراج کنید
tree-sitter build --wasm -o tree-sitter-grammars/tree-sitter-kotlin.wasm <kotlin-src>
tree-sitter build --wasm -o tree-sitter-grammars/tree-sitter-swift.wasm <swift-src>
```

## استخراج‌شونده‌ها

- class / interface / enum / type-alias / namespace / module
- function / method / constructor / property
- variable / constant
- nested symbols با `parentId`
- parameters / signature / return type
- visibility (public/private/protected) از modifier ها و `#private` fields
- modifiers: async / generator / abstract / static / readonly
- extends / implements / generics
- documentation از leading comments
- exported بودن از `export_statement`

## تنظیمات

مسیر دایرکتوری WASM grammar ها از طریق تنظیم VSCode `semanticEngine.treeSitter.grammarDir` قابل پیکربندی است. پیش‌فرض: `tree-sitter-grammars/` در workspace root.

## `TreeSitterIncrementalParser` — حذف شد (فاز ۱۷، SE-SYM-17)

۱۱۲ خط کامل و بی‌استفاده. تصمیم: **حذف، نه اتصال.** سه دلیل:

۱. مسیر incremental، *ویرایش متنی* ندارد. `FileChangeQueue` رویداد سطح
   فایل می‌دهد (`created/modified/deleted/renamed`)، نه دلتا. برای
   استفاده از `tree.edit()` باید موقعیت دقیق تغییر در دست باشد که
   هیچ‌جای این خط لوله تولید نمی‌شود.
۲. هرگز اجرا نشده و هیچ تستی نداشت. کدی که *کامل به نظر می‌رسد* ولی
   اجرا نشده، از نبودِ کد بدتر است: نفر بعدی فرض می‌کند کار می‌کند.
۳. کش AST با hash محتوا از قبل کار اصلی را می‌کند — فایل تغییرنکرده
   دوباره parse نمی‌شود.

اگر روزی ویرایش‌های متنی واقعی در دسترس بود (مثلاً از
`textDocument/didChange` در بلوک E)، این دوباره نوشته می‌شود — آن‌وقت
با تستی که واقعاً اجرایش می‌کند.
