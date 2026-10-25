#!/usr/bin/env node
"use strict";

/*
| Fixture generator
| -----------------
|
|   node scripts/gen-fixture.js [target]     default: ./test-fixture
|
| A small project that the whole pipeline runs against. It is generated
| rather than committed for two reasons: a byte-exact tree is easier to
| trust when it is produced by readable code than when it is a thousand
| files in git, and several cases the engine must survive cannot be
| committed comfortably at all - a BOM, CRLF endings, a NUL byte, a file
| large enough to cross the truncation threshold.
|
| Every group here exists because something in the audit went wrong on
| it. Adding a case means a bug found; removing one means a guarantee
| dropped.
*/

const fs = require("fs");
const path = require("path");

const TARGET =
    process.argv[2] ||
    path.join(__dirname, "..", "test-fixture");


function write(relative, content, encoding = "utf8") {

    const full = path.join(TARGET, relative);

    fs.mkdirSync(path.dirname(full), { recursive: true });

    fs.writeFileSync(
        full,
        Buffer.isBuffer(content) ? content : content,
        Buffer.isBuffer(content) ? undefined : encoding
    );
}


/*
| TypeScript. The dependency and graph tests read src/app.ts by name and
| expect it to have local imports that resolve, plus a package import.
*/

function typescript() {

    write("src/app.ts", `import { Logger } from './util/logger';
import { UserService } from './services/user.service';
import { CONFIG } from './config';
import { join } from 'path';

/** Wires the application together. */
export class Application {
    private readonly log = new Logger('app');

    constructor(private readonly users: UserService) {}

    async start(port: number = CONFIG.port): Promise<void> {
        this.log.info(\`listening on \${port}\`);
        await this.users.load(join(CONFIG.dataDir, 'users.json'));
    }

    stop(): void {
        this.log.info('stopping');
    }
}

export function createApplication(): Application {
    return new Application(new UserService());
}

export const VERSION = '1.0.0';
`);

    write("src/config.ts", `export interface AppConfig {
    readonly port: number;
    readonly dataDir: string;
    readonly debug?: boolean;
}

export const CONFIG: AppConfig = {
    port: Number(process.env.PORT ?? 8080),
    dataDir: process.env.DATA_DIR ?? './data'
};
`);

    write("src/util/logger.ts", `export type Level = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
    constructor(private readonly scope: string) {}

    info(message: string): void {
        this.emit('info', message);
    }

    warn(message: string): void {
        this.emit('warn', message);
    }

    private emit(level: Level, message: string): void {
        console.log(\`[\${level}] \${this.scope}: \${message}\`);
    }
}
`);

    write("src/util/index.ts", `export { Logger } from './logger';
export type { Level } from './logger';
export * from './strings';
`);

    write("src/util/strings.ts", `export function slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export const EMPTY = '';
`);

    write("src/services/user.service.ts", `import { Logger } from '../util/logger';
import type { User } from '../model/user';

export abstract class BaseService<T> {
    protected items: T[] = [];
    abstract load(source: string): Promise<void>;
}

export class UserService extends BaseService<User> {
    private readonly log = new Logger('users');

    async load(source: string): Promise<void> {
        this.log.info(\`loading from \${source}\`);
        this.items = [];
    }

    find(id: string): User | undefined {
        return this.items.find(user => user.id === id);
    }
}
`);

    write("src/model/user.ts", `export interface User {
    id: string;
    name: string;
    email?: string;
}

export enum Role {
    Admin = 'admin',
    Member = 'member'
}

export type UserWithRole = User & { role: Role };
`);

    /* Arrow functions, which the tree-sitter mapper loses today. */
    write("src/util/arrows.ts", `export const add = (a: number, b: number): number => a + b;

export const withCallback = (
    cb: (value: string) => void,
    retries: number = 3
): void => {
    for (let i = 0; i < retries; i++) {
        cb(String(i));
    }
};

export const noArgs = () => null;
`);

    /* An abstract class and a namespace, both missed today. */
    write("src/util/shapes.ts", `export abstract class Shape {
    abstract area(): number;
}

export class Circle extends Shape {
    constructor(private readonly r: number) { super(); }
    area(): number { return Math.PI * this.r ** 2; }
}

export namespace Geometry {
    export const ORIGIN = { x: 0, y: 0 };
    export function distance(a: number, b: number): number {
        return Math.abs(a - b);
    }
}
`);

    /* Overloads: two symbols that share a name and kind. */
    write("src/util/overloads.ts", `export function parse(value: string): number;
export function parse(value: number): string;
export function parse(value: string | number): string | number {
    return typeof value === 'string' ? Number(value) : String(value);
}

export class Repo {
    get(id: string): string;
    get(id: number): string;
    get(id: string | number): string { return String(id); }
}
`);

    write("src/extension.ts", `import { createApplication } from './app';

export function activate(): void {
    createApplication().start();
}

export function deactivate(): void {}
`);

    write("src/index.ts", `export * from './app';
export * from './config';
export { Logger } from './util/logger';
`);

    /*
    | Comments on purpose. tsconfig.json is JSONC - the TypeScript
    | compiler accepts comments in it, and real projects use them. The
    | scanner used to map .jsonc and tsconfig.json onto the strict
    | `json` language, so a file like this one parsed to zero symbols
    | and a "JSON parse error" warning (SE-SCAN-12).
    */
    write("tsconfig.json", `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    // strict is on everywhere; do not turn this off per-file
    "strict": true,
    "baseUrl": ".",
    "paths": { "@util/*": ["src/util/*"] }
  },
  /* only the sources, never the fixtures */
  "include": ["src"]
}
`);
}


function tsx() {

    write("src/ui/Panel.tsx", `import * as React from 'react';

export interface PanelProps {
    title: string;
    onClose?: () => void;
}

export const Panel: React.FC<PanelProps> = ({ title, onClose }) => (
    <div className="panel">
        <h2>{title}</h2>
        <button onClick={onClose}>close</button>
    </div>
);

export default Panel;
`);
}


function javascript() {

    write("lib/helpers.js", `'use strict';

const path = require('path');

function resolveAll(base, names) {
    return names.map(name => path.join(base, name));
}

class Cache {
    constructor(limit = 100) {
        this.limit = limit;
        this.entries = new Map();
    }

    get(key) { return this.entries.get(key); }

    set(key, value) {
        if (this.entries.size >= this.limit) {
            this.entries.delete(this.entries.keys().next().value);
        }
        this.entries.set(key, value);
    }
}

module.exports = { resolveAll, Cache };
`);

    write("lib/esm.mjs", `export const NAME = 'esm-module';

export async function load(url) {
    const response = await fetch(url);
    return response.json();
}
`);

    write("scripts/build.js", `#!/usr/bin/env node
const { Cache } = require('../lib/helpers');

const cache = new Cache(10);
cache.set('built', Date.now());
console.log('built');
`);
}


function python() {

    write("py/service.py", `"""User handling."""

import os
import json
from typing import Optional


class UserRepository:
    """Stores users in memory."""

    def __init__(self, source: str):
        self.source = source
        self.users = []

    def load(self) -> None:
        if os.path.exists(self.source):
            with open(self.source) as handle:
                self.users = json.load(handle)

    def find(self, user_id: str) -> Optional[dict]:
        for user in self.users:
            if user["id"] == user_id:
                return user
        return None


def build_repository(
    source: str,
    eager: bool = False,
) -> UserRepository:
    """A signature that spans several lines on purpose."""
    repo = UserRepository(source)
    if eager:
        repo.load()
    return repo


async def fetch_remote(url):
    return url


def outer(values):
    # A nested function. Its branches belong to it, not to outer() -
    # the TS path always worked that way; the pattern path did not
    # until phase 23 (SE-METRIC-01).
    def inner(value):
        if value:
            return 1
        return 0

    return [inner(v) for v in values]
`);

    write("py/__init__.py", `from .service import UserRepository, build_repository

__all__ = ["UserRepository", "build_repository"]
`);
}


function go() {

    /* Grouped imports: today only the first one is read. */
    write("go/server.go", `package server

import (
	"context"
	"fmt"
	"net/http"
)

type Handler interface {
	Serve(ctx context.Context) error
	Name() string
}

type Server struct {
	addr string
}

func New(addr string) *Server {
	return &Server{addr: addr}
}

func (s *Server) Serve(ctx context.Context) error {
	fmt.Println("serving on", s.addr)
	return http.ListenAndServe(s.addr, nil)
}

func (s *Server) Name() string {
	return "server"
}
`);
}


/*
| Files that carry the role names the blueprint and metadata layers look
| for: repository, controller, middleware, model. Without them those
| code paths never run against the fixture.
*/

function layered() {

    write("src/repository/user.repository.ts", `import type { User } from '../model/user';

export class UserRepository {
    private readonly rows = new Map<string, User>();

    findById(id: string): User | undefined {
        return this.rows.get(id);
    }

    save(user: User): void {
        this.rows.set(user.id, user);
    }
}
`);

    write("src/controller/user.controller.ts", `import { UserRepository } from '../repository/user.repository';
import { Logger } from '../util/logger';

/*
| A decorator on a method. node.getStart() lands on the decorator, not
| the name, so before phase 23 every decorated method resolved to no
| AST node at all and got complexity null (SE-METRIC-05). Angular,
| NestJS and TypeORM codebases are almost entirely decorated methods.
*/
function route(_path: string) {
    return (_t: unknown, _k: string, d: PropertyDescriptor) => d;
}

export class UserController {
    private readonly log = new Logger('controller');

    constructor(private readonly repo: UserRepository) {}

    @route('/user/:id')
    get(id: string) {
        this.log.info(\`get \${id}\`);
        if (!id) { return null; }
        return this.repo.findById(id);
    }
}
`);

    write("src/middleware/auth.middleware.ts", `import { CONFIG } from '../config';

export function requireAuth(token: string | undefined): boolean {
    if (!token) return false;
    return token.length > 8 && CONFIG.port > 0;
}

export const SKIP_PATHS = ['/health', '/metrics'];
`);

    write("src/services/order.service.ts", `import { Logger } from '../util/logger';

export interface Order {
    id: string;
    total: number;
}

export class OrderService {
    private readonly log = new Logger('orders');

    checkout(order: Order): boolean {
        if (order.total <= 0) {
            this.log.warn('empty order');
            return false;
        }
        return true;
    }
}
`);

    write("src/services/payment.service.ts", `export class PaymentService {
    charge(amount: number): Promise<boolean> {
        return Promise.resolve(amount > 0);
    }
}
`);

    write("src/api/routes.ts", `import { UserController } from '../controller/user.controller';

export interface Route {
    method: 'GET' | 'POST';
    path: string;
    handler: string;
}

export const ROUTES: Route[] = [
    { method: 'GET', path: '/users/:id', handler: 'UserController.get' },
    { method: 'POST', path: '/orders', handler: 'OrderService.checkout' }
];

export function register(controller: UserController): Route[] {
    void controller;
    return ROUTES;
}
`);

    /*
    | Phase 46 needs a fixture that actually declares HTTP routes. The
    | file above only holds a ROUTES array literal, which is data, not a
    | route registration — an apiMap built from it would be reading a
    | coincidence. These three cover the shapes the extractor claims to
    | understand.
    */
    write("src/api/express-app.ts", `import express from 'express';
import { UserController } from '../controller/user.controller';
import type { User } from '../model/user';

const app = express();
const router = express.Router();

app.get('/health', (_req, res) => res.send('ok'));
app.post('/users', createUser);

router.get('/users/:id', getUser);
router.delete('/users/:id', removeUser);
router.put("/users/:id/email", updateEmail);

app.use('/api/v1', router);

/*
| Phase 47 needs a handler that actually leads somewhere. A stub
| handler produces a one-step workflow, which is filtered out, so the
| fixture could not exercise the API-to-storage path at all.
*/
function createUser(req: unknown, res: unknown) { void res; return saveUser(req); }
function saveUser(req: unknown) { return persistUser(req); }
function persistUser(req: unknown): User | undefined { void req; return undefined; }
function getUser(req: unknown, res: unknown) { void req; void res; }
function removeUser(req: unknown, res: unknown) { void req; void res; }
function updateEmail(req: unknown, res: unknown) { void req; void res; }

export { app, router, createUser, saveUser, persistUser, getUser, removeUser, updateEmail };
export function boot(c: UserController) { void c; return app; }
`);

    write("src/api/fastify-app.ts", `import Fastify from 'fastify';

const fastify = Fastify();

fastify.get('/ping', pong);
fastify.post('/orders', placeOrder);
fastify.route({ method: 'PATCH', url: '/orders/:id', handler: patchOrder });

function pong() { return 'pong'; }
function placeOrder() { return null; }
function patchOrder() { return null; }

export { fastify, pong, placeOrder, patchOrder };
`);

    write("src/api/nest-users.controller.ts", `import { Controller, Get, Post } from '@nestjs/common';

@Controller('users')
export class NestUsersController {
    @Get(':id')
    findOne(id: string) { return id; }

    @Post()
    create() { return null; }
}
`);
}


function moreLanguages() {

    write("php/Repository.php", `<?php

namespace App;

interface Storage
{
    public function get(string $id);
}

class Repository implements Storage
{
    private array $rows = [];

    public function get(string $id)
    {
        return $this->rows[$id] ?? null;
    }

    public function put(string $id, $value): void
    {
        $this->rows[$id] = $value;
    }
}
`);

    write("rust/lib.rs", `pub struct Config {
    pub port: u16,
}

pub trait Handler {
    fn handle(&self, input: &str) -> String;
}

pub struct Echo;

impl Handler for Echo {
    fn handle(&self, input: &str) -> String {
        input.to_string()
    }
}

pub fn build(port: u16) -> Config {
    Config { port }
}
`);

    write("c/parser.c", `#include <stdio.h>
#include <string.h>

struct Token {
    int kind;
    char text[64];
};

static int count_tokens(const char *source) {
    int count = 0;
    for (const char *p = source; *p; p++) {
        if (*p == ' ') count++;
    }
    return count;
}

int parse(const char *source, struct Token *out) {
    int n = count_tokens(source);
    if (out != NULL) {
        out->kind = n;
    }
    return n;
}
`);

    write("cs/Service.cs", `namespace App
{
    public interface IService
    {
        string Get(string id);
    }

    public class Service : IService
    {
        public string Get(string id)
        {
            return id;
        }

        public string Get(int id)
        {
            return id.ToString();
        }
    }
}
`);

    write("kt/Model.kt", `package app

data class User(val id: String, val name: String)

interface Repository {
    fun find(id: String): User?
}

class InMemoryRepository : Repository {
    private val rows = mutableMapOf<String, User>()

    override fun find(id: String): User? = rows[id]
}
`);

    write("swift/Model.swift", `import Foundation

protocol Identifiable {
    var id: String { get }
}

struct User: Identifiable {
    let id: String
    let name: String
}

final class Store {
    private var rows: [String: User] = [:]

    func find(id: String) -> User? {
        return rows[id]
    }
}
`);

    write("sql/schema.sql", `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE INDEX idx_users_name ON users(name);
`);
}


function otherLanguages() {

    write("rb/parser.rb", `module Parsing
  class Parser
    def initialize(source)
      @source = source
    end

    def parse
      @source.split("\\n")
    end

    def self.build(source)
      new(source)
    end
  end
end
`);

    write("java/Main.java", `package app;

import java.util.List;
import java.util.ArrayList;

public class Main {
    private final List<String> items = new ArrayList<>();

    public void add(String value) {
        items.add(value);
    }

    public String get(int index) {
        return items.get(index);
    }

    public String get(String key) {
        return key;
    }
}
`);

    write("sh/deploy.sh", `#!/usr/bin/env bash
set -euo pipefail

deploy() {
    local target="\${1:-staging}"
    echo "deploying to \${target}"
}

rollback() {
    echo "rolling back"
}

deploy "\$@"
`);
}


function declarative() {

    /*
    | A URL inside a JSON string. The comment stripper cuts at the //
    | and the parse throws, so this file yields no symbols today.
    */

    write("package.json", JSON.stringify({
        name: "fixture-project",
        version: "1.0.0",
        homepage: "https://example.com/docs",
        repository: { type: "git", url: "https://github.com/example/fixture.git" },
        dependencies: { express: "^4.18.0" },
        scripts: { start: "node scripts/build.js" }
    }, null, 2) + "\n");

    write("config/settings.json", JSON.stringify({
        server: { host: "0.0.0.0", port: 8080 },
        database: { url: "postgres://localhost:5432/app" },
        features: { search: true, export: false }
    }, null, 2) + "\n");

    write("web/style.css", `:root {
    --primary: #0066cc;
}

.panel {
    display: flex;
    padding: 1rem;
}

.panel > h2 {
    margin: 0;
}

@media (max-width: 600px) {
    .panel {
        flex-direction: column;
    }
}
`);

    write("web/index.html", `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Fixture</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div id="root" class="panel wide"></div>
    <script src="app.js"></script>
</body>
</html>
`);

    write("README.md", `# Fixture project

A generated tree used by the semantic-engine tests.

## Layout

- \`src/\` TypeScript
- \`lib/\` JavaScript
- \`py/\` Python
- \`go/\` Go
`);

    write("config/app.yaml", `server:
  host: 0.0.0.0
  port: 8080
features:
  - search
  - export
`);
}


/*
| Cases that exist only because the audit found something wrong on them.
*/

function edgeCases() {

    /* NUL byte: must be detected as binary and reported with 0 lines. */
    write("assets/logo.png", Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01
    ]));

    /* UTF-8 BOM: must not leak into the first line or the first symbol. */
    write(
        "src/util/bom.ts",
        Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from("export const WITH_BOM = 'bom';\n", "utf8")
        ])
    );

    /* CRLF endings: line counts must not double. */
    write(
        "src/util/crlf.ts",
        "export const A = 1;\r\nexport const B = 2;\r\nexport const C = 3;\r\n"
    );

    /* No trailing newline: the last line must still be counted. */
    write("src/util/noeol.ts", "export const NO_EOL = true;");

    /* Empty file. */
    write("src/util/empty.ts", "");

    /*
    | Larger than the 8KB read window used for binary detection but
    | smaller than the 5MB cap, so the whole file is read. The truncated
    | branch is exercised by huge.txt below.
    */
    write(
        "src/util/large.ts",
        "export const LINES = [\n" +
        Array.from({ length: 400 }, (_, i) => `    'line ${i}',`).join("\n") +
        "\n];\n"
    );

    /*
    | Over the default 5MB threshold. Today the hash is computed from the
    | first 8KB only, so a change past that point is invisible.
    */
    write(
        "assets/huge.txt",
        "x".repeat(5 * 1024 * 1024 + 1024)
    );

    /* Non-ASCII identifiers and comments. */
    write("src/util/unicode.ts", `/** توضیح فارسی برای آزمون یونیکد. */
export const مقدار = 'value';

export function 计算(a: number): number {
    return a * 2;
}
`);

    /* A file the ignore rules must skip. */
    write("dist/bundle.js", "console.log('built output, must not be indexed');\n");
    write("node_modules/left-pad/index.js", "module.exports = () => {};\n");

    /* Env references, for the config usage mapper. */
    /*
    | Fake credentials in fallback position. They are here so the
    | snapshot locks in that ConfigUsageEntry.context is redacted before
    | it reaches project-index.json, which is written into the workspace
    | and can be committed.
    */

    write("src/env.ts", `export const PORT = process.env.PORT;
export const HOST = process.env['HOST'];
export const SECRET = process.env.API_SECRET || 'sk-live-4eC39HqLyjWDarjtT1zdp7dc';
export const GH = process.env.GH_TOKEN || 'ghp_16C7e42F292c6912E7710c838347Ae178B4a';
export const DSN = process.env.DATABASE_URL || 'postgres://admin:hunter2@db:5432/app';
`);

    write(".env.example", `PORT=8080
DATA_DIR=./data
`);

    /* A test file, so testFile detection and the test mapper have input. */
    write("src/util/logger.test.ts", `import { Logger } from './logger';

describe('Logger', () => {
    it('emits', () => {
        new Logger('t').info('hello');
    });
});
`);

    write("py/test_service.py", `from py.service import UserRepository


def test_find_returns_none():
    assert UserRepository("missing.json").find("1") is None
`);
}


/*
| .gitignore is part of the fixture: the scanner reads it, and patterns
| with a path separator are the ones that do not work today.
*/

function ignoreRules() {

    write(".gitignore", `node_modules/
dist/
*.log
src/generated/*.ts
`);

    write("src/generated/api.ts", "export const GENERATED = true;\n");
    write("debug.log", "should be ignored\n");
}


function main() {

    fs.rmSync(TARGET, { recursive: true, force: true });
    fs.mkdirSync(TARGET, { recursive: true });

    typescript();
    tsx();
    layered();
    moreLanguages();
    javascript();
    python();
    go();
    otherLanguages();
    declarative();
    edgeCases();
    ignoreRules();

    let count = 0;

    const walk = directory => {

        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {

            const full = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(full);
            } else {
                count++;
            }
        }
    };

    walk(TARGET);

    console.log(`fixture written to ${TARGET} (${count} files)`);
}


main();
