/**
 * Target-repo scaffold generator.
 *
 * Reads compilation-units.json produced by the migration-planner and creates
 * the target repository skeleton: directory tree, build manifests (Cargo.toml,
 * package.json, .csproj, go.mod, etc.), and module declarations.
 *
 * The scaffold is *compilable but empty* — it establishes structure so that
 * code-migrator agents can write implementations into existing modules rather
 * than inventing the build layout on the fly.
 *
 * @module core/scaffold
 */

import { join, basename, relative } from 'node:path';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import type { CompilationUnit } from '../agents/types.js';
import type { Logger } from '../logging/logger.js';

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ScaffoldOptions {
  /** Absolute path to the target output root. */
  outputPath: string;
  /** Target language (e.g. "rust", "csharp", "go", "typescript"). */
  targetLanguage: string;
  /** Target framework hint, if any. */
  targetFramework?: string;
  /** Project name for root-level manifests. */
  projectName: string;
  /** The compilation units to scaffold. */
  compilationUnits: CompilationUnit[];
  /** Optional build command — if set the scaffold can be verified by running it. */
  buildCommand?: string;
}

export interface ScaffoldResult {
  /** Total files created. */
  filesCreated: number;
  /** Total directories created. */
  dirsCreated: number;
  /** Files that were skipped because they already exist. */
  filesSkipped: number;
}

/**
 * Generate the target-repo scaffold from compilation units.
 *
 * Idempotent: existing files are never overwritten, so re-running after a
 * partial scaffold (or after code-migrator has already written files) is safe.
 */
export async function generateScaffold(
  options: ScaffoldOptions,
  logger: Logger,
): Promise<ScaffoldResult> {
  const { outputPath, targetLanguage, compilationUnits, projectName } = options;
  const lang = targetLanguage.toLowerCase();

  const result: ScaffoldResult = { filesCreated: 0, dirsCreated: 0, filesSkipped: 0 };

  if (compilationUnits.length === 0) {
    logger.info('No compilation units — skipping scaffold');
    return result;
  }

  // 1. Create root output directory
  await mkdirSafe(outputPath, result);

  // 2. Generate language-specific scaffolding
  switch (lang) {
    case 'rust':
      await scaffoldRust(options, result, logger);
      break;
    case 'csharp':
    case 'c#':
      await scaffoldCSharp(options, result, logger);
      break;
    case 'go':
    case 'golang':
      await scaffoldGo(options, result, logger);
      break;
    case 'typescript':
    case 'javascript':
      await scaffoldTypeScript(options, result, logger);
      break;
    default:
      // For unknown languages, just create directory structure
      await scaffoldGeneric(options, result, logger);
      break;
  }

  logger.info(
    `Scaffold complete: ${result.filesCreated} files created, ` +
    `${result.dirsCreated} dirs created, ${result.filesSkipped} files skipped (already exist)`,
  );
  return result;
}

// ─── Language-Specific Scaffolders ───────────────────────────────────────────

async function scaffoldRust(
  options: ScaffoldOptions,
  result: ScaffoldResult,
  logger: Logger,
): Promise<void> {
  const { outputPath, compilationUnits, projectName } = options;

  // Root Cargo.toml (workspace)
  const workspaceMembers = compilationUnits
    .map(u => `  "${u.targetPath}"`)
    .join(',\n');

  const rootCargo = `[workspace]
resolver = "2"
members = [
${workspaceMembers},
]

[workspace.package]
edition = "2021"
`;
  await writeFileSafe(join(outputPath, 'Cargo.toml'), rootCargo, result);

  // Per-unit crate scaffolding
  for (const unit of compilationUnits) {
    const cratePath = join(outputPath, unit.targetPath);
    await mkdirSafe(cratePath, result);
    await mkdirSafe(join(cratePath, 'src'), result);

    // Crate Cargo.toml
    const deps = unit.dependsOn
      .map(depId => {
        const dep = compilationUnits.find(u => u.id === depId);
        if (!dep) return '';
        const depCrateName = basename(dep.targetPath);
        const relPath = relative(cratePath, join(outputPath, dep.targetPath));
        return `${depCrateName} = { path = "${relPath}" }`;
      })
      .filter(Boolean)
      .join('\n');

    const crateName = basename(unit.targetPath);
    const crateCargo = `[package]
name = "${crateName}"
version = "0.1.0"
edition.workspace = true

[dependencies]
${deps}
`;
    await writeFileSafe(join(cratePath, 'Cargo.toml'), crateCargo, result);

    // lib.rs stub
    const libRs = `//! ${unit.name}
//!
//! Auto-generated scaffold — implementations will be filled by migration tasks.
`;
    await writeFileSafe(join(cratePath, 'src', 'lib.rs'), libRs, result);

    logger.debug(`Scaffolded Rust crate: ${unit.targetPath} (${unit.name})`);
  }
}

async function scaffoldCSharp(
  options: ScaffoldOptions,
  result: ScaffoldResult,
  logger: Logger,
): Promise<void> {
  const { outputPath, compilationUnits, projectName } = options;

  // Root solution file
  const slnProjects = compilationUnits
    .map(u => {
      const projName = basename(u.targetPath);
      return `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${projName}", "${u.targetPath}/${projName}.csproj", "{${pseudoGuid(u.id)}}"
EndProject`;
    })
    .join('\n');

  const sln = `
Microsoft Visual Studio Solution File, Format Version 12.00
${slnProjects}
Global
EndGlobal
`;
  await writeFileSafe(join(outputPath, `${projectName}.sln`), sln.trimStart(), result);

  for (const unit of compilationUnits) {
    const projPath = join(outputPath, unit.targetPath);
    await mkdirSafe(projPath, result);

    const projName = basename(unit.targetPath);
    const projRefs = unit.dependsOn
      .map(depId => {
        const dep = compilationUnits.find(u => u.id === depId);
        if (!dep) return '';
        const relPath = relative(projPath, join(outputPath, dep.targetPath));
        return `    <ProjectReference Include="${relPath}/${basename(dep.targetPath)}.csproj" />`;
      })
      .filter(Boolean)
      .join('\n');

    const fw = options.targetFramework ?? 'net8.0';
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${fw}</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
${projRefs ? `  <ItemGroup>\n${projRefs}\n  </ItemGroup>` : ''}
</Project>
`;
    await writeFileSafe(join(projPath, `${projName}.csproj`), csproj, result);

    logger.debug(`Scaffolded C# project: ${unit.targetPath} (${unit.name})`);
  }
}

async function scaffoldGo(
  options: ScaffoldOptions,
  result: ScaffoldResult,
  logger: Logger,
): Promise<void> {
  const { outputPath, compilationUnits, projectName } = options;

  // Root go.mod
  const goMod = `module ${projectName}

go 1.22
`;
  await writeFileSafe(join(outputPath, 'go.mod'), goMod, result);

  for (const unit of compilationUnits) {
    const pkgPath = join(outputPath, unit.targetPath);
    await mkdirSafe(pkgPath, result);

    const pkgName = basename(unit.targetPath);
    const docGo = `// Package ${pkgName} — ${unit.name}.
//
// Auto-generated scaffold — implementations will be filled by migration tasks.
package ${pkgName}
`;
    await writeFileSafe(join(pkgPath, 'doc.go'), docGo, result);

    logger.debug(`Scaffolded Go package: ${unit.targetPath} (${unit.name})`);
  }
}

async function scaffoldTypeScript(
  options: ScaffoldOptions,
  result: ScaffoldResult,
  logger: Logger,
): Promise<void> {
  const { outputPath, compilationUnits, projectName } = options;

  // Root package.json (workspace)
  const workspaces = compilationUnits.map(u => u.targetPath);
  const rootPkg = JSON.stringify({
    name: projectName,
    private: true,
    workspaces,
  }, null, 2) + '\n';
  await writeFileSafe(join(outputPath, 'package.json'), rootPkg, result);

  // Root tsconfig.json
  const rootTsConfig = JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'node16',
      moduleResolution: 'node16',
      declaration: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
    },
    references: compilationUnits.map(u => ({ path: u.targetPath })),
  }, null, 2) + '\n';
  await writeFileSafe(join(outputPath, 'tsconfig.json'), rootTsConfig, result);

  for (const unit of compilationUnits) {
    const pkgPath = join(outputPath, unit.targetPath);
    await mkdirSafe(pkgPath, result);
    await mkdirSafe(join(pkgPath, 'src'), result);

    const pkgName = basename(unit.targetPath);
    const pkg = JSON.stringify({
      name: `@${projectName}/${pkgName}`,
      version: '0.1.0',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      dependencies: Object.fromEntries(
        unit.dependsOn
          .map(depId => {
            const dep = compilationUnits.find(u => u.id === depId);
            if (!dep) return null;
            return [`@${projectName}/${basename(dep.targetPath)}`, 'workspace:*'];
          })
          .filter((e): e is [string, string] => e !== null),
      ),
    }, null, 2) + '\n';
    await writeFileSafe(join(pkgPath, 'package.json'), pkg, result);

    // index.ts stub
    const indexTs = `// ${unit.name}\n// Auto-generated scaffold — implementations will be filled by migration tasks.\n`;
    await writeFileSafe(join(pkgPath, 'src', 'index.ts'), indexTs, result);

    logger.debug(`Scaffolded TypeScript package: ${unit.targetPath} (${unit.name})`);
  }
}

async function scaffoldGeneric(
  options: ScaffoldOptions,
  result: ScaffoldResult,
  logger: Logger,
): Promise<void> {
  const { outputPath, compilationUnits } = options;

  for (const unit of compilationUnits) {
    const unitPath = join(outputPath, unit.targetPath);
    await mkdirSafe(unitPath, result);

    // Write a README stub documenting the unit
    const readme = `# ${unit.name}

Auto-generated scaffold for compilation unit \`${unit.id}\`.

## Dependencies

${unit.dependsOn.length > 0 ? unit.dependsOn.map(d => `- ${d}`).join('\n') : 'None'}

## Source Files

${unit.sourceFiles.length} source file(s) will be migrated into this unit.
`;
    await writeFileSafe(join(unitPath, 'README.md'), readme, result);

    logger.debug(`Scaffolded generic unit: ${unit.targetPath} (${unit.name})`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function writeFileSafe(
  filePath: string,
  content: string,
  result: ScaffoldResult,
): Promise<void> {
  if (await exists(filePath)) {
    result.filesSkipped++;
    return;
  }
  await writeFile(filePath, content, 'utf-8');
  result.filesCreated++;
}

async function mkdirSafe(dirPath: string, result: ScaffoldResult): Promise<void> {
  if (await exists(dirPath)) return;
  await mkdir(dirPath, { recursive: true });
  result.dirsCreated++;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Produce a deterministic pseudo-GUID from a string (for .sln files). */
function pseudoGuid(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `${hex.slice(0, 8)}-0000-0000-0000-${hex.padEnd(12, '0').slice(0, 12)}`.toUpperCase();
}
