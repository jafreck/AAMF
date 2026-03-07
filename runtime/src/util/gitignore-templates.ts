/**
 * Language-specific `.gitignore` templates for AAMF-generated output repos.
 *
 * When the orchestrator initialises a fresh git repository at
 * `target.outputPath`, it writes a `.gitignore` derived from the
 * `target.language` so that build artifacts are never committed.
 *
 * Every template ends with a shared COMMON block covering OS-level temp
 * files, editor/IDE artifacts, and environment files.
 */

const COMMON = `
# ── OS-level temp / metadata files ──────────────────────────────────
.DS_Store
._*
Thumbs.db
ehthumbs.db
Desktop.ini
$RECYCLE.BIN/
*.lnk

# Spotlight (macOS)
.Spotlight-V100
.Trashes
.fseventsd

# ── Editor / IDE artifacts ──────────────────────────────────────────
.vscode/
.idea/
*.swp
*.swo
*~
*.bak
*.orig
*.rej
\#*\#
.#*
*.sublime-workspace
*.sublime-project
*.code-workspace
.settings/
.project
.classpath
*.iml
nbproject/

# ── Environment / secrets ──────────────────────────────────────────
.env
.env.*
!.env.example
`;

const TEMPLATES: Record<string, string> = {

  // ─── Rust ──────────────────────────────────────────────────────────
  rust: `# Rust build output
target/
**/target/

# Profiling / coverage
*.profraw
*.profdata
*.gcda
*.gcno
*.dSYM/

# Compiled artifacts
*.rlib
*.rmeta
*.d
*.o
*.a
*.so
*.dylib
*.dll
*.exe
${COMMON}`,

  // ─── C# / .NET ────────────────────────────────────────────────────
  csharp: `# .NET build output
bin/
obj/
**/bin/
**/obj/
out/

# NuGet
*.nupkg
.nuget/
packages/
project.lock.json

# User / IDE
*.user
*.suo
*.userprefs
*.rsuser
*.DotSettings.user

# Build results / debug
*.dll
*.exe
*.pdb
*.ilk
*.exp
*.lib
*.cache
*.manifest

# Publish
publish/
${COMMON}`,

  // ─── Go ────────────────────────────────────────────────────────────
  go: `# Go build output
/bin/
/dist/
*.exe
*.test
*.out

# Dependency management
vendor/

# Go workspace
go.work
go.work.sum

# Coverage
*.coverprofile
coverage.out
coverage.html
${COMMON}`,

  // ─── TypeScript ────────────────────────────────────────────────────
  typescript: `# Node / TypeScript
node_modules/
dist/
build/
out/
*.tsbuildinfo
.npm/

# Package manager lock files (keep whichever your project uses)
# package-lock.json
# yarn.lock
# pnpm-lock.yaml

# Coverage
coverage/
.nyc_output/

# Cache
.cache/
.parcel-cache/
.turbo/
${COMMON}`,

  // ─── JavaScript ────────────────────────────────────────────────────
  javascript: `# Node / JavaScript
node_modules/
dist/
build/
out/
.npm/

# Coverage
coverage/
.nyc_output/

# Cache
.cache/
.parcel-cache/
.turbo/
${COMMON}`,

  // ─── Python ────────────────────────────────────────────────────────
  python: `# Byte-compiled / bytecode
__pycache__/
*.py[cod]
*$py.class

# Distribution / packaging
dist/
build/
*.egg-info/
*.egg
.eggs/
sdist/
wheels/

# Virtual environments
.venv/
venv/
env/
ENV/

# Coverage / testing
.coverage
.coverage.*
htmlcov/
.pytest_cache/
.tox/
.nox/

# Type stubs / mypy
.mypy_cache/
.pytype/

# Jupyter
.ipynb_checkpoints/
${COMMON}`,

  // ─── Java ──────────────────────────────────────────────────────────
  java: `# Compiled class files
*.class

# Package files
*.jar
*.war
*.ear
*.nar

# Build systems
target/
build/
.gradle/
!gradle/wrapper/gradle-wrapper.jar

# Eclipse
.metadata/
.classpath
.project
.settings/
bin/

# IntelliJ
*.iml
.idea/
out/

# Maven
pom.xml.tag
pom.xml.releaseBackup
pom.xml.versionsBackup
pom.xml.next
release.properties

# Annotation processing
.apt_generated/
.factorypath
${COMMON}`,

  // ─── Kotlin ────────────────────────────────────────────────────────
  kotlin: `# Compiled class files
*.class

# Package files
*.jar
*.war
*.ear

# Gradle
.gradle/
build/
!gradle/wrapper/gradle-wrapper.jar

# IntelliJ
*.iml
.idea/
out/

# Kotlin-specific
.kotlin/
${COMMON}`,

  // ─── C++ ───────────────────────────────────────────────────────────
  cpp: `# Compiled objects / libraries
*.o
*.obj
*.a
*.lib
*.so
*.so.*
*.dll
*.dylib
*.exe
*.out

# Build directories
build/
cmake-build-*/
CMakeFiles/
CMakeCache.txt
cmake_install.cmake
Makefile
compile_commands.json

# Dependency / PCH files
*.d
*.gch
*.pch

# Debug
*.dSYM/
*.dmp
core
${COMMON}`,

  // ─── C ─────────────────────────────────────────────────────────────
  c: `# Compiled objects / libraries
*.o
*.obj
*.a
*.lib
*.so
*.so.*
*.dll
*.dylib
*.exe
*.out

# Build directories
build/
cmake-build-*/
CMakeFiles/
CMakeCache.txt
cmake_install.cmake
Makefile
compile_commands.json

# Dependency files
*.d
*.gch
*.pch

# Debug
*.dSYM/
*.dmp
core
${COMMON}`,

  // ─── Swift ─────────────────────────────────────────────────────────
  swift: `# Xcode / Swift
.build/
DerivedData/
xcuserdata/
*.xccheckout
*.xcscmblueprint
*.playground/

# Swift Package Manager
.swiftpm/
Package.resolved
Packages/

# CocoaPods
Pods/

# Carthage
Carthage/Build/

# Compiled
*.o
*.dSYM/
${COMMON}`,

  // ─── Ruby ──────────────────────────────────────────────────────────
  ruby: `# Bundler
vendor/bundle/
.bundle/

# Gem build
*.gem
pkg/

# RVM / rbenv / asdf
.ruby-version
.ruby-gemset

# Coverage
coverage/

# Byebug
.byebug_history

# Temp / cache
tmp/
log/
.cache/
${COMMON}`,

  // ─── PHP ───────────────────────────────────────────────────────────
  php: `# Composer
vendor/
composer.phar

# PHPUnit
.phpunit.result.cache
.phpunit.cache/

# Coverage
coverage/

# Cache
.php_cs.cache
.php-cs-fixer.cache

# Laravel / Symfony
storage/*.key
bootstrap/cache/
${COMMON}`,

  // ─── Scala ─────────────────────────────────────────────────────────
  scala: `# sbt
target/
project/target/
project/project/

# Metals / Bloop
.bloop/
.metals/
.bsp/

# Compiled
*.class
*.jar

# IntelliJ
.idea/
*.iml
out/
${COMMON}`,

  // ─── Elixir ────────────────────────────────────────────────────────
  elixir: `# Build / deps
_build/
deps/

# Generated on crash
erl_crash.dump

# Mix archives
*.ez

# Cover
cover/

# Dialyzer
.dialyzer/
${COMMON}`,

  // ─── Haskell ───────────────────────────────────────────────────────
  haskell: `# Stack / Cabal
.stack-work/
dist/
dist-newstyle/
cabal-dev/

# Compiled
*.hi
*.o
*.dyn_hi
*.dyn_o
*.p_hi
*.p_o
${COMMON}`,

  // ─── Zig ───────────────────────────────────────────────────────────
  zig: `# Zig build
zig-out/
zig-cache/
.zig-cache/

# Compiled
*.o
*.a
*.so
*.dll
*.dylib
*.exe
${COMMON}`,

  // ─── Dart / Flutter ────────────────────────────────────────────────
  dart: `# Dart / Flutter
.dart_tool/
.packages
build/
pubspec.lock

# Flutter-specific
.flutter-plugins
.flutter-plugins-dependencies
*.iml

# Coverage
coverage/
${COMMON}`,

  // ─── Lua ───────────────────────────────────────────────────────────
  lua: `# LuaRocks
lua_modules/
luarocks/

# Compiled
*.luac
${COMMON}`,

  // ─── R ─────────────────────────────────────────────────────────────
  r: `# R session / history
.Rhistory
.Rdata
.RData
.Ruserdata
.Rproj.user/

# Package build
*.tar.gz
*.Rcheck/
${COMMON}`,

  // ─── Objective-C ───────────────────────────────────────────────────
  'objective-c': `# Xcode
DerivedData/
xcuserdata/
*.xccheckout
*.xcscmblueprint
build/

# CocoaPods
Pods/

# Compiled
*.o
*.a
*.dylib
*.dSYM/
${COMMON}`,
};

// ─── Aliases ─────────────────────────────────────────────────────────
// Map common alternative names and abbreviations to canonical keys.
/* eslint-disable @typescript-eslint/no-non-null-assertion */
TEMPLATES['c#']     = TEMPLATES.csharp!;
TEMPLATES['c++']    = TEMPLATES.cpp!;
TEMPLATES.ts        = TEMPLATES.typescript!;
TEMPLATES.js        = TEMPLATES.javascript!;
TEMPLATES.golang    = TEMPLATES.go!;
TEMPLATES.py        = TEMPLATES.python!;
TEMPLATES.rs        = TEMPLATES.rust!;
TEMPLATES.kt        = TEMPLATES.kotlin!;
TEMPLATES.rb        = TEMPLATES.ruby!;
TEMPLATES.ex        = TEMPLATES.elixir!;
TEMPLATES.hs        = TEMPLATES.haskell!;
TEMPLATES.flutter   = TEMPLATES.dart!;
TEMPLATES.objc      = TEMPLATES['objective-c']!;
TEMPLATES['obj-c']  = TEMPLATES['objective-c']!;
/* eslint-enable @typescript-eslint/no-non-null-assertion */

/**
 * Returns a `.gitignore` body for the given target language.
 * Falls back to the common OS/editor rules when the language is unknown.
 */
export function gitignoreForLanguage(language: string): string {
  const key = language.toLowerCase().trim();
  return TEMPLATES[key] ?? COMMON;
}
