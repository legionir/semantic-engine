/**
 * معیار پذیرش فاز ۴۶.
 *
 * > روی fixture دارای Express، `apiMap` مسیرها را با متد و handler
 * > درست بدهد.
 *
 * `apiMap` تا امروز `[]` هاردکد بود با کامنت «فاز ۷ (AI Metadata)» —
 * یعنی منتظر LLM. ولی ثبتِ مسیر در Express و Fastify یک الگوی نحوی
 * روشن است و به مدل نیازی ندارد؛ LLM را برای جایی نگه می‌داریم که
 * واقعاً ابهام هست.
 */

import { ApiMapExtractor } from './ApiMapExtractor';

const EXPRESS = `import express from 'express';

const app = express();
const router = express.Router();

app.get('/health', (_req, res) => res.send('ok'));
app.post('/users', createUser);

router.get('/users/:id', getUser);
router.delete('/users/:id', removeUser);
router.put("/users/:id/email", updateEmail);

app.use('/api/v1', router);
`;

const FASTIFY = `import Fastify from 'fastify';

const fastify = Fastify();

fastify.get('/ping', pong);
fastify.post('/orders', placeOrder);
fastify.route({ method: 'PATCH', url: '/orders/:id', handler: patchOrder });
`;

const NEST = `import { Controller, Get, Post } from '@nestjs/common';

@Controller('users')
export class NestUsersController {
    @Get(':id')
    findOne(id: string) { return id; }

    @Post()
    create() { return null; }
}
`;

function extract(path: string, source: string) {
  return new ApiMapExtractor().extract(path, source);
}

describe('ApiMapExtractor — Express (معیار پذیرش فاز ۴۶)', () => {
  const routes = extract('src/api/express-app.ts', EXPRESS);

  it('همهٔ مسیرها پیدا می‌شوند', () => {
    expect(routes).toHaveLength(5);
  });

  it('متد درست است', () => {
    const byPath = new Map(routes.map(r => [r.path, r.method]));

    expect(byPath.get('/health')).toBe('GET');
    expect(byPath.get('/users')).toBe('POST');
    expect(byPath.get('/users/:id/email')).toBe('PUT');
  });

  it('دو مسیر با یک path و متد متفاوت، هر دو می‌آیند', () => {
    const forId = routes.filter(r => r.path === '/users/:id').map(r => r.method).sort();

    expect(forId).toEqual(['DELETE', 'GET']);
  });

  it('handler درست است', () => {
    const byKey = new Map(routes.map(r => [`${r.method} ${r.path}`, r.handlerName]));

    expect(byKey.get('POST /users')).toBe('createUser');
    expect(byKey.get('GET /users/:id')).toBe('getUser');
    expect(byKey.get('DELETE /users/:id')).toBe('removeUser');
  });

  it('handler ناشناس، به‌عنوان ناشناس گزارش می‌شود نه حدس', () => {
    const health = routes.find(r => r.path === '/health')!;

    expect(health.handlerName).toBeNull();
  });

  it('گیومهٔ دوتایی هم مثل تکی کار می‌کند', () => {
    expect(routes.some(r => r.path === '/users/:id/email')).toBe(true);
  });

  it('`app.use` مسیر حساب نمی‌شود', () => {
    expect(routes.some(r => r.path === '/api/v1')).toBe(false);
  });

  it('شمارهٔ خط ثبت می‌شود', () => {
    for (const route of routes) {
      expect(route.line).toBeGreaterThan(0);
    }
  });

  it('framework اعلام می‌شود', () => {
    expect(routes.every(r => r.framework === 'express')).toBe(true);
  });
});

describe('ApiMapExtractor — Fastify', () => {
  const routes = extract('src/api/fastify-app.ts', FASTIFY);

  it('فراخوانی‌های متدی پیدا می‌شوند', () => {
    const byKey = new Map(routes.map(r => [`${r.method} ${r.path}`, r.handlerName]));

    expect(byKey.get('GET /ping')).toBe('pong');
    expect(byKey.get('POST /orders')).toBe('placeOrder');
  });

  it('شکل شیئیِ `route({ method, url, handler })` هم پیدا می‌شود', () => {
    const patch = routes.find(r => r.method === 'PATCH')!;

    expect(patch).toBeDefined();
    expect(patch.path).toBe('/orders/:id');
    expect(patch.handlerName).toBe('patchOrder');
  });

  it('framework اعلام می‌شود', () => {
    expect(routes.every(r => r.framework === 'fastify')).toBe(true);
  });
});

describe('ApiMapExtractor — NestJS', () => {
  const routes = extract('src/api/nest-users.controller.ts', NEST);

  it('پیشوندِ کنترلر با مسیرِ متد ترکیب می‌شود', () => {
    const paths = routes.map(r => r.path).sort();

    expect(paths).toEqual(['/users', '/users/:id']);
  });

  it('متد از نامِ دکوراتور می‌آید', () => {
    const byPath = new Map(routes.map(r => [r.path, r.method]));

    expect(byPath.get('/users/:id')).toBe('GET');
    expect(byPath.get('/users')).toBe('POST');
  });

  it('handler نامِ متد است', () => {
    const byPath = new Map(routes.map(r => [r.path, r.handlerName]));

    expect(byPath.get('/users/:id')).toBe('findOne');
    expect(byPath.get('/users')).toBe('create');
  });
});

describe('ApiMapExtractor — چیزی که نباید تطابق بدهد', () => {
  it('آرایهٔ دادهٔ ROUTES مسیر تولید نمی‌کند', () => {
    /*
    | فایلِ `src/api/routes.ts` در fixture فقط یک آرایهٔ داده دارد.
    | استخراجی که آن را «مسیر» بشمارد، تصادف را می‌خواند نه ثبت را.
    */
    const source = `export const ROUTES = [
  { method: 'GET', path: '/users/:id', handler: 'UserController.get' },
];`;

    expect(extract('src/api/routes.ts', source)).toEqual([]);
  });

  it('نامِ متغیرِ بی‌ربط با متد http تطابق نمی‌دهد', () => {
    const source = `const widget = { get: (k: string) => k };\nwidget.get('color');`;

    expect(extract('src/a.ts', source)).toEqual([]);
  });

  it('فایل بدون مسیر، فهرست خالی می‌دهد', () => {
    expect(extract('src/a.ts', 'export const x = 1;')).toEqual([]);
  });

  it('کامنت مسیر تولید نمی‌کند', () => {
    const source = `// app.get('/commented-out', handler)\nexport const x = 1;`;

    expect(extract('src/a.ts', source)).toEqual([]);
  });

  it('زبان غیر JS/TS نادیده گرفته می‌شود', () => {
    expect(extract('main.py', "app.get('/x', handler)")).toEqual([]);
  });

  it('نتیجه دترمینیستیک است', () => {
    expect(extract('src/api/express-app.ts', EXPRESS)).toEqual(
      extract('src/api/express-app.ts', EXPRESS)
    );
  });
});
