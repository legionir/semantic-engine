/**
 * همگامی contracts/*.schema.json با تایپ‌های TypeScript.
 *
 * سرآمد project-index.types.ts می‌گوید schema منبع حقیقت است و تایپ‌ها از
 * آن derive می‌شوند. هیچ‌چیز این قاعده را اجرا نمی‌کرد، و دو انحراف واقعی
 * در ارزیابی پیدا شد (SE-DATA-03).
 *
 * تایپ‌ها با خودِ کامپایلر TypeScript خوانده می‌شوند، نه با regex: تجزیهٔ
 * متنی روی تایپ‌های تودرتو می‌شکند و خطای کاذب می‌دهد.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

interface SchemaObject {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, unknown>;
  $defs?: Record<string, SchemaObject>;
}

interface TypeShape {
  readonly name: string;
  /** نام هر property → آیا اختیاری است */
  readonly properties: Map<string, boolean>;
}

const CONTRACTS = path.join(__dirname, '..', '..', '..', 'contracts');
const TYPES_DIR = __dirname;

/** نگاشت `$defs` در schema → نام interface در TypeScript. */
const PROJECT_INDEX_MAP: Record<string, string> = {
  fileEntry: 'FileEntry',
  exportEntry: 'ExportEntry',
  importEntry: 'ImportEntry',
  symbolEntry: 'SymbolEntry',
  parameter: 'Parameter',
  callEdge: 'CallEdge',
  typeEdge: 'TypeEdge',
  dependencyEdge: 'DependencyEdge',
  reverseDependencyEdge: 'ReverseDependencyEdge',
  diagnostic: 'Diagnostic',
  edgeProvenance: 'EdgeProvenance',
  lspInfo: 'LspInfo',
  gitFileMetrics: 'GitFileMetrics',
  configUsageEntry: 'ConfigUsageEntry',
  fileMetrics: 'FileMetrics',
  projectMetrics: 'ProjectMetrics',
  aiMetadata: 'AiMetadata',
  vectorChunk: 'VectorChunk',
};

const BLUEPRINT_MAP: Record<string, string> = {
  folderNode: 'FolderNode',
  graphNode: 'GraphNode',
  graphEdge: 'GraphEdge',
  symbolIndexEntry: 'BlueprintSymbolIndexEntry',
};

/*
| blueprint.schema.json بیشتر شکل‌هایش را به‌جای $defs، inline زیر
| properties ریشه تعریف می‌کند. آن‌ها هم باید سنجیده شوند وگرنه محافظ
| فقط چهار تعریف از پانزده شکل را می‌بیند.
*/

const BLUEPRINT_INLINE_MAP: Record<string, string> = {
  meta: 'BlueprintMeta',
  architectureOverview: 'ArchitectureOverview',
  moduleMap: 'ModuleEntry',
  dependencyGraph: 'BlueprintDependencyGraph',
  entityTechnicalMapping: 'EntityTechnicalMapping',
  apiMap: 'ApiEntry',
  workflowExecutionMap: 'WorkflowExecutionEntry',
  technicalConstraints: 'TechnicalConstraint',
};

/**
 * شکل یک property ریشه را برمی‌گرداند: خودِ آن اگر object باشد، یا
 * items آن اگر آرایه باشد.
 */
function inlineShape(root: SchemaObject, property: string): SchemaObject | null {
  const node = (root.properties ?? {})[property] as SchemaObject & {
    items?: SchemaObject;
  } | undefined;

  if (!node) return null;

  if (node.type === 'array') {
    return node.items && node.items.properties ? node.items : null;
  }

  return node.properties ? node : null;
}

/**
 * استخراج شکل هر interface از یک فایل تایپ، با AST کامپایلر.
 */
function readTypes(file: string): Map<string, TypeShape> {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );

  const shapes = new Map<string, TypeShape>();

  source.forEachChild(node => {
    if (!ts.isInterfaceDeclaration(node)) return;

    const properties = new Map<string, boolean>();

    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      properties.set(member.name.getText(source), member.questionToken !== undefined);
    }

    shapes.set(node.name.text, { name: node.name.text, properties });
  });

  return shapes;
}

function loadSchema(name: string): SchemaObject {
  return JSON.parse(
    fs.readFileSync(path.join(CONTRACTS, name), 'utf8')
  ) as SchemaObject;
}

/**
 * یک تعریف schema را با interface متناظرش مقایسه می‌کند.
 * سه چیز را می‌سنجد: property گمشده، property اضافی، و عدم تطابق اجباری‌بودن.
 */
function compare(
  defName: string,
  schema: SchemaObject,
  shape: TypeShape
): string[] {
  const problems: string[] = [];

  const schemaProps = Object.keys(schema.properties ?? {});
  const requiredInSchema = new Set(schema.required ?? []);

  for (const prop of schemaProps) {
    if (!shape.properties.has(prop)) {
      problems.push(
        `${defName}.${prop} در schema هست ولی در ${shape.name} نیست`
      );
      continue;
    }

    const optionalInType = shape.properties.get(prop)!;
    const requiredInJson = requiredInSchema.has(prop);

    if (requiredInJson && optionalInType) {
      problems.push(
        `${defName}.${prop} در schema اجباری است ولی در ${shape.name} اختیاری`
      );
    }

    if (!requiredInJson && !optionalInType) {
      problems.push(
        `${defName}.${prop} در schema اختیاری است ولی در ${shape.name} اجباری`
      );
    }
  }

  for (const prop of shape.properties.keys()) {
    if (!schemaProps.includes(prop)) {
      problems.push(
        `${shape.name}.${prop} در تایپ هست ولی در schema (${defName}) نیست`
      );
    }
  }

  return problems;
}

describe('schema and type synchronisation', () => {
  const projectIndexTypes = readTypes(
    path.join(TYPES_DIR, 'project-index.types.ts')
  );

  const blueprintTypes = readTypes(
    path.join(TYPES_DIR, 'blueprint.types.ts')
  );

  const projectIndexSchema = loadSchema('project-index.schema.json');
  const blueprintSchema = loadSchema('blueprint.schema.json');

  it('parses both type files', () => {
    expect(projectIndexTypes.size).toBeGreaterThan(10);
    expect(blueprintTypes.size).toBeGreaterThan(10);
  });

  it('maps every $defs entry in project-index.schema.json to a type', () => {
    const defs = Object.keys(projectIndexSchema.$defs ?? {});
    const unmapped = defs.filter(name => !PROJECT_INDEX_MAP[name]);

    expect(unmapped).toEqual([]);
  });

  it('maps every $defs entry in blueprint.schema.json to a type', () => {
    const defs = Object.keys(blueprintSchema.$defs ?? {});
    const unmapped = defs.filter(name => !BLUEPRINT_MAP[name]);

    expect(unmapped).toEqual([]);
  });

  it('maps every inline shape in blueprint.schema.json to a type', () => {
    const inline =
      Object.keys(blueprintSchema.properties ?? {})
        .filter(name => inlineShape(blueprintSchema, name) !== null);

    const unmapped =
      inline.filter(name => !BLUEPRINT_INLINE_MAP[name]);

    expect(unmapped).toEqual([]);
  });

  it('keeps ProjectIndex itself in step with the schema root', () => {
    const shape = projectIndexTypes.get('ProjectIndex');
    expect(shape).toBeDefined();

    expect(compare('(root)', projectIndexSchema, shape!)).toEqual([]);
  });

  it('keeps Blueprint itself in step with the schema root', () => {
    const shape = blueprintTypes.get('Blueprint');
    expect(shape).toBeDefined();

    expect(compare('(root)', blueprintSchema, shape!)).toEqual([]);
  });

  it('keeps every project-index definition in step with its type', () => {
    const problems: string[] = [];

    for (const [defName, typeName] of Object.entries(PROJECT_INDEX_MAP)) {
      const def = projectIndexSchema.$defs?.[defName];
      const shape = projectIndexTypes.get(typeName);

      if (!def) {
        problems.push(`$defs.${defName} در schema نیست`);
        continue;
      }

      if (!shape) {
        problems.push(`interface ${typeName} در تایپ‌ها نیست`);
        continue;
      }

      problems.push(...compare(defName, def, shape));
    }

    expect(problems).toEqual([]);
  });

  it('keeps every blueprint definition in step with its type', () => {
    const problems: string[] = [];

    for (const [defName, typeName] of Object.entries(BLUEPRINT_MAP)) {
      const def = blueprintSchema.$defs?.[defName];
      const shape = blueprintTypes.get(typeName);

      if (!def) {
        problems.push(`$defs.${defName} در schema نیست`);
        continue;
      }

      if (!shape) {
        problems.push(`interface ${typeName} در تایپ‌ها نیست`);
        continue;
      }

      problems.push(...compare(defName, def, shape));
    }

    for (const [property, typeName] of Object.entries(BLUEPRINT_INLINE_MAP)) {
      const def = inlineShape(blueprintSchema, property);
      const shape = blueprintTypes.get(typeName);

      if (!def) {
        problems.push(`properties.${property} شکل inline ندارد`);
        continue;
      }

      if (!shape) {
        problems.push(`interface ${typeName} در تایپ‌ها نیست`);
        continue;
      }

      problems.push(...compare(property, def, shape));
    }

    expect(problems).toEqual([]);
  });

  /*
  | محافظ خودِ محافظ: اگر compare() روزی از کار بیفتد و همیشه آرایهٔ خالی
  | بدهد، شش تست بالا بی‌صدا بی‌اثر می‌شوند و کسی متوجه نمی‌شود.
  */
  it('reports a mismatch that is introduced on purpose', () => {
    const shape: TypeShape = {
      name: 'Fake',
      properties: new Map([
        ['present', false],
        ['extra', false],
        ['wronglyOptional', true],
      ]),
    };

    const def: SchemaObject = {
      required: ['present', 'wronglyOptional'],
      properties: { present: {}, wronglyOptional: {}, missing: {} },
    };

    const problems = compare('fake', def, shape);

    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/missing/);
    expect(problems.join('\n')).toMatch(/extra/);
    expect(problems.join('\n')).toMatch(/wronglyOptional/);
  });
});
