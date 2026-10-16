/**
 * فاز ۳ — process state used to be written into the checkout
 * (`<projectsRoot>/.agent/jobs.json` and `.agent/telemetry/spans.json`, two of
 * which are even committed in this repository). It now belongs to the data
 * root, and when no data root is configured nothing is written at all.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpServer } from './HttpServer';

describe('HttpServer — process state stays out of the source tree', () => {
  let base: string;
  let projectsRoot: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-runtime-')));
    projectsRoot = path.join(base, 'workspace');
    fs.mkdirSync(projectsRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('writes jobs and telemetry under <dataRoot>/runtime', async () => {
    const dataRoot = path.join(base, 'data');
    const server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: 'runtime-token',
      projectsRoot,
      dataRoot,
    });

    await server.start();
    await server.stop();

    expect(fs.existsSync(path.join(dataRoot, 'runtime', 'telemetry', 'spans.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectsRoot, '.agent'))).toBe(false);
    expect(fs.readdirSync(projectsRoot)).toEqual([]);
  });

  it('persists nothing when no data root is configured', async () => {
    const server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: 'runtime-token',
      projectsRoot,
    });

    await server.start();
    await server.stop();

    expect(fs.existsSync(path.join(projectsRoot, '.agent'))).toBe(false);
    expect(fs.readdirSync(projectsRoot)).toEqual([]);
  });
});
