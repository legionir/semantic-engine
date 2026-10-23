/**
 * Architecture overview, layers and technical constraints of the blueprint
 * (split from BlueprintGenerator.ts, behavior unchanged).
 */

import { ProjectIndex } from '../core/types/project-index.types';
import {
  ArchitectureLayer,
  ArchitectureOverview,
  DataFlowEdge,
  ModuleEntry,
  TechnicalConstraint,
} from '../core/types/blueprint.types';
import { ARCHITECTURE_LAYERS, matchesSegment } from './blueprintCategories';

export function buildArchitectureOverview(modules: ModuleEntry[]): ArchitectureOverview {
  const dataFlow: DataFlowEdge[] = [];

  for (const mod of modules) {
    for (const dep of mod.dependsOnModuleIds ?? []) {
      dataFlow.push({
        from: mod.id,
        to: dep,
        description: `${mod.name} depends on ${dep}`,
      });
    }
  }

  return {
    layers: buildLayers(modules),
    dataFlow,
  };
}

/**
 * لایه‌ها از ساختار پوشه — SE-BP-02.
 *
 * تطابق روی **قطعه‌های** مسیر است نه زیررشته، به همان دلیلی که
 * SE-VEC-11 و SE-BP-05 توضیح دادند: `src/models` قطعهٔ `model` دارد
 * ولی `src/remodeling` ندارد.
 *
 * ماژولی که با هیچ الگویی نخواند، در هیچ لایه‌ای قرار نمی‌گیرد. یک
 * لایهٔ «other» که همه چیز را جمع کند، اطلاعاتی حمل نمی‌کند و فقط
 * وانمود می‌کند معماری کشف شده.
 */
export function buildLayers(modules: ModuleEntry[]): ArchitectureLayer[] {
  const byLayer = new Map<string, string[]>();

  for (const mod of modules) {
    const segments = new Set(
      mod.path
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
    );
    // نامِ ماژول هم یک قطعه است؛ `src/api` باید با «api» بخورد.
    for (const part of mod.name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (part) segments.add(part);
    }

    for (const layer of ARCHITECTURE_LAYERS) {
      if (!layer.patterns.some(pattern => matchesSegment(pattern, segments))) continue;
      const list = byLayer.get(layer.name) ?? [];
      list.push(mod.id);
      byLayer.set(layer.name, list);
      break; // اولین تطابق برنده است — هیچ ماژولی در دو لایه نیست.
    }
  }

  return ARCHITECTURE_LAYERS.filter(layer => byLayer.has(layer.name)).map(layer => ({
    name: layer.name,
    responsibility: layer.responsibility,
    moduleIds: (byLayer.get(layer.name) ?? []).sort(),
    derivedFrom: 'heuristic' as const,
  }));
}

export function buildTechnicalConstraints(projectIndex: ProjectIndex): TechnicalConstraint[] {
  const constraints: TechnicalConstraint[] = [
    {
      id: 'tc-layered-architecture',
      pattern: 'Layered Architecture',
      description: 'Modules should respect directory-level separation of concerns (services, controllers, repositories, etc.).',
      enforcement: 'code-review',
    },
    {
      id: 'tc-no-circular-dependencies',
      pattern: 'No Circular Dependencies',
      description: 'File-level import cycles should be avoided to keep coupling low.',
      enforcement: 'ci-check',
    },
  ];

  /*
  | SE-BP-03 — تشخیص واقعیِ حلقه.
  |
  | جای این حلقه قبلاً کدِ مرده بود: روی فایل‌ها می‌چرخید و تنها
  | دستور مؤثرش `continue` بود، پس `violatingFileIds` هرگز پر
  | نمی‌شد. و قانونِ «No Circular Dependencies» اعلام می‌شد بی‌آنکه
  | هیچ حلقه‌ای تشخیص داده شود — با اینکه گراف کامل در دسترس بود.
  */
  const cyclic = filesInCycles(projectIndex);
  if (cyclic.length > 0) {
    constraints[1] = { ...constraints[1]!, violatingFileIds: cyclic };
  }

  return constraints;
}

/**
 * فایل‌هایی که در دست‌کم یک حلقهٔ import هستند.
 *
 * الگوریتم Tarjan برای مؤلفه‌های قویاً همبند: هر مؤلفه با بیش از
 * یک عضو یک حلقه است، و یک عضو با یالِ به‌خودش هم.
 *
 * فقط یال‌هایی شمرده می‌شوند که **هر دو سرشان فایلِ واقعی** باشد؛
 * یال به یک پکیج خارجی حلقه نمی‌سازد چون آن سر، گرهی در پروژه
 * نیست.
 */
export function filesInCycles(projectIndex: ProjectIndex): string[] {
  const fileIds = new Set(projectIndex.files.map(f => f.id));
  const out = new Map<string, string[]>();

  for (const edge of projectIndex.graphs.dependencyGraph) {
    if (!fileIds.has(edge.from) || !fileIds.has(edge.to)) continue;
    const list = out.get(edge.from) ?? [];
    list.push(edge.to);
    out.set(edge.from, list);
  }

  let counter = 0;
  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const inCycle = new Set<string>();

  /*
  | پیمایش صریح با پشته، نه بازگشتی. روی مخزنی با هزاران فایل،
  | Tarjan بازگشتی به سقفِ پشتهٔ Node می‌خورد — همان درسی که فاز
  | ۳۹ دربارهٔ پیمایش گراف گرفت.
  */
  for (const start of fileIds) {
    if (indexOf.has(start)) continue;

    const work: { node: string; edge: number }[] = [{ node: start, edge: 0 }];
    indexOf.set(start, counter);
    lowLink.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const neighbours = out.get(frame.node) ?? [];

      if (frame.edge < neighbours.length) {
        const next = neighbours[frame.edge]!;
        frame.edge++;

        if (next === frame.node) {
          inCycle.add(next); // یال به خودش
          continue;
        }

        if (!indexOf.has(next)) {
          indexOf.set(next, counter);
          lowLink.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edge: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, indexOf.get(next)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!));
      }

      if (lowLink.get(frame.node) === indexOf.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        if (component.length > 1) for (const id of component) inCycle.add(id);
      }
    }
  }

  return [...inCycle].sort();
}
