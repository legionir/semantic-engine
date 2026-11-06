#!/usr/bin/env node
/**
 * Installs the `semantic-engine` skill into Claude Code.
 *
 *   node scripts/install-claude-skill.js                 user scope: ~/.claude/skills/semantic-engine
 *   node scripts/install-claude-skill.js --scope project project scope: ./.claude/skills/semantic-engine
 *   node scripts/install-claude-skill.js --dir <path>    any skills directory
 *   node scripts/install-claude-skill.js --uninstall     remove it
 *
 * The skill is a single SKILL.md; installing means copying it. It does not
 * register the MCP server — the skill's first section prints the command.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function parse(argv) {
  const out = { scope: 'user', dir: undefined, uninstall: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--scope') out.scope = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--uninstall') out.uninstall = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!['user', 'project'].includes(out.scope)) throw new Error('--scope must be "user" or "project"');
  return out;
}

function targetDir(options) {
  if (options.dir) return path.resolve(options.dir, 'semantic-engine');
  const base = options.scope === 'project' ? path.join(process.cwd(), '.claude') : path.join(os.homedir(), '.claude');
  return path.join(base, 'skills', 'semantic-engine');
}

function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\nusage: install-claude-skill.js [--scope user|project] [--dir <skills dir>] [--uninstall]`);
    return 2;
  }
  if (options.help) {
    console.log('usage: install-claude-skill.js [--scope user|project] [--dir <skills dir>] [--uninstall]');
    return 0;
  }

  const target = targetDir(options);
  if (options.uninstall) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`removed ${target}`);
    return 0;
  }

  const source = path.join(__dirname, '..', 'skills', 'semantic-engine', 'SKILL.md');
  if (!fs.existsSync(source)) {
    console.error(`skill source not found: ${source}`);
    return 1;
  }
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(source, path.join(target, 'SKILL.md'));
  console.log(`installed ${path.join(target, 'SKILL.md')}`);
  console.log('Start a new Claude Code session; the skill is listed as "semantic-engine".');
  console.log('Connect the tools once (see section 1 of the skill), e.g.:');
  console.log('  claude mcp add semantic-engine -- semantic-engine serve --stdio --root <project>');
  return 0;
}

process.exitCode = main();
