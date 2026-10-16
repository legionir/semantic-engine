/**
 * تست HeuristicDependencyExtractor برای Python, Go, PHP, Bash.
 */

import { HeuristicDependencyExtractor } from './HeuristicDependencyExtractor';

const extractor = new HeuristicDependencyExtractor();

describe('HeuristicDependencyExtractor', () => {
  it('should extract Python imports', async () => {
    const content = `
import os
from typing import List
from .models import User
`;
    const result = await extractor.extractDependencies('f1', 'src/app.py', content, 'python');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('os');
    expect(imports.map(i => i.from)).toContain('typing');
    expect(imports.map(i => i.from)).toContain('.models');
  });

  it('should extract Go imports', async () => {
    const content = `
import "fmt"
import (
    "os"
    "github.com/gin-gonic/gin"
)
`;
    const result = await extractor.extractDependencies('f1', 'src/main.go', content, 'go');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('fmt');
  });

  it('should extract PHP use statements', async () => {
    const content = `
<?php
use App\\Controller\\UserController;
require 'vendor/autoload.php';
`;
    const result = await extractor.extractDependencies('f1', 'src/app.php', content, 'php');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('App\\Controller\\UserController');
    expect(imports.map(i => i.from)).toContain('vendor/autoload.php');
  });

  it('should extract Bash sources', async () => {
    const content = `
#!/bin/bash
source ./utils.sh
. /etc/profile
`;
    const result = await extractor.extractDependencies('f1', 'scripts/deploy.sh', content, 'shellscript');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('./utils.sh');
  });

  it('should extract Java imports', async () => {
    const content = `
import java.util.List;
import static org.junit.Assert.assertEquals;
`;
    const result = await extractor.extractDependencies('f1', 'src/App.java', content, 'java');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('java.util.List');
    expect(imports.map(i => i.from)).toContain('org.junit.Assert.assertEquals');
  });

  it('should extract Rust imports', async () => {
    const content = `
use std::collections::HashMap;
use crate::models::User;
mod auth;
extern crate serde;
`;
    const result = await extractor.extractDependencies('f1', 'src/lib.rs', content, 'rust');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('std::collections::HashMap');
    expect(imports.map(i => i.from)).toContain('crate::models::User');
    expect(imports.map(i => i.from)).toContain('auth');
    expect(imports.map(i => i.from)).toContain('serde');
  });

  it('should extract C# usings', async () => {
    const content = `
using System;
using Newtonsoft.Json;
`;
    const result = await extractor.extractDependencies('f1', 'src/Program.cs', content, 'csharp');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('System');
    expect(imports.map(i => i.from)).toContain('Newtonsoft.Json');
  });

  it('should extract C/C++ includes', async () => {
    const content = `
#include <iostream>
#include "utils.h"
`;
    const result = await extractor.extractDependencies('f1', 'src/main.cpp', content, 'cpp');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('iostream');
    expect(imports.map(i => i.from)).toContain('utils.h');
    expect(imports.find(i => i.from === 'iostream')?.type).toBe('builtin');
    expect(imports.find(i => i.from === 'utils.h')?.type).toBe('local');
  });

  it('should extract Ruby requires', async () => {
    const content = `
require 'json'
require_relative './helpers'
`;
    const result = await extractor.extractDependencies('f1', 'src/app.rb', content, 'ruby');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('json');
    expect(imports.map(i => i.from)).toContain('./helpers');
  });

  it('should extract Swift imports', async () => {
    const content = `
import Foundation
import UIKit
`;
    const result = await extractor.extractDependencies('f1', 'src/App.swift', content, 'swift');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('Foundation');
  });

  it('should extract Kotlin imports', async () => {
    const content = `
import kotlin.collections.List
import androidx.appcompat.app.AppCompatActivity
`;
    const result = await extractor.extractDependencies('f1', 'src/App.kt', content, 'kotlin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const imports = result.value.imports;
    expect(imports.map(i => i.from)).toContain('kotlin.collections.List');
  });
});
