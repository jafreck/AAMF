import { describe, it, expect } from 'vitest';
import { gitignoreForLanguage } from '../src/util/gitignore-templates.js';

/** Every template must include these OS / editor artifacts. */
const COMMON_PATTERNS = ['.DS_Store', 'Thumbs.db', '.vscode/', '.idea/', '*.swp', '*~', '._*'];

function expectCommon(content: string) {
  for (const p of COMMON_PATTERNS) {
    expect(content, `missing common pattern: ${p}`).toContain(p);
  }
}

describe('gitignoreForLanguage', () => {
  // ─── Core languages used in AAMF fixtures ────────────────────────
  it('rust', () => {
    const c = gitignoreForLanguage('rust');
    expect(c).toContain('target/');
    expect(c).toContain('*.rlib');
    expect(c).toContain('*.rmeta');
    expect(c).toContain('*.profraw');
    expectCommon(c);
  });

  it('rust alias "rs"', () => {
    expect(gitignoreForLanguage('rs')).toContain('target/');
    expectCommon(gitignoreForLanguage('rs'));
  });

  it('csharp', () => {
    const c = gitignoreForLanguage('csharp');
    expect(c).toContain('bin/');
    expect(c).toContain('obj/');
    expect(c).toContain('*.nupkg');
    expectCommon(c);
  });

  it('csharp alias "c#"', () => {
    expect(gitignoreForLanguage('c#')).toContain('obj/');
    expectCommon(gitignoreForLanguage('c#'));
  });

  it('go', () => {
    const c = gitignoreForLanguage('go');
    expect(c).toContain('vendor/');
    expect(c).toContain('*.test');
    expectCommon(c);
  });

  it('go alias "golang"', () => {
    expect(gitignoreForLanguage('golang')).toContain('vendor/');
    expectCommon(gitignoreForLanguage('golang'));
  });

  it('typescript', () => {
    const c = gitignoreForLanguage('typescript');
    expect(c).toContain('node_modules/');
    expect(c).toContain('*.tsbuildinfo');
    expectCommon(c);
  });

  it('typescript alias "ts"', () => {
    expect(gitignoreForLanguage('ts')).toContain('node_modules/');
    expectCommon(gitignoreForLanguage('ts'));
  });

  it('javascript', () => {
    const c = gitignoreForLanguage('javascript');
    expect(c).toContain('node_modules/');
    expectCommon(c);
  });

  it('javascript alias "js"', () => {
    expectCommon(gitignoreForLanguage('js'));
  });

  it('python', () => {
    const c = gitignoreForLanguage('python');
    expect(c).toContain('__pycache__/');
    expect(c).toContain('.venv/');
    expect(c).toContain('.mypy_cache/');
    expectCommon(c);
  });

  it('python alias "py"', () => {
    expect(gitignoreForLanguage('py')).toContain('__pycache__/');
    expectCommon(gitignoreForLanguage('py'));
  });

  it('java', () => {
    const c = gitignoreForLanguage('java');
    expect(c).toContain('*.class');
    expect(c).toContain('*.jar');
    expect(c).toContain('.gradle/');
    expectCommon(c);
  });

  // ─── C / C++ ─────────────────────────────────────────────────────
  it('c', () => {
    const c = gitignoreForLanguage('c');
    expect(c).toContain('*.o');
    expect(c).toContain('cmake-build-*/');
    expectCommon(c);
  });

  it('cpp', () => {
    const c = gitignoreForLanguage('cpp');
    expect(c).toContain('*.o');
    expect(c).toContain('*.obj');
    expect(c).toContain('*.gch');
    expectCommon(c);
  });

  it('c++ alias', () => {
    expectCommon(gitignoreForLanguage('c++'));
  });

  // ─── Additional languages ────────────────────────────────────────
  it('kotlin', () => {
    const c = gitignoreForLanguage('kotlin');
    expect(c).toContain('*.class');
    expect(c).toContain('.gradle/');
    expect(c).toContain('.kotlin/');
    expectCommon(c);
  });

  it('kotlin alias "kt"', () => {
    expectCommon(gitignoreForLanguage('kt'));
  });

  it('swift', () => {
    const c = gitignoreForLanguage('swift');
    expect(c).toContain('.build/');
    expect(c).toContain('DerivedData/');
    expect(c).toContain('Package.resolved');
    expectCommon(c);
  });

  it('ruby', () => {
    const c = gitignoreForLanguage('ruby');
    expect(c).toContain('vendor/bundle/');
    expect(c).toContain('*.gem');
    expectCommon(c);
  });

  it('ruby alias "rb"', () => {
    expectCommon(gitignoreForLanguage('rb'));
  });

  it('php', () => {
    const c = gitignoreForLanguage('php');
    expect(c).toContain('vendor/');
    expect(c).toContain('composer.phar');
    expectCommon(c);
  });

  it('scala', () => {
    const c = gitignoreForLanguage('scala');
    expect(c).toContain('.bloop/');
    expect(c).toContain('.metals/');
    expect(c).toContain('*.class');
    expectCommon(c);
  });

  it('elixir', () => {
    const c = gitignoreForLanguage('elixir');
    expect(c).toContain('_build/');
    expect(c).toContain('deps/');
    expectCommon(c);
  });

  it('elixir alias "ex"', () => {
    expectCommon(gitignoreForLanguage('ex'));
  });

  it('haskell', () => {
    const c = gitignoreForLanguage('haskell');
    expect(c).toContain('.stack-work/');
    expect(c).toContain('dist-newstyle/');
    expectCommon(c);
  });

  it('haskell alias "hs"', () => {
    expectCommon(gitignoreForLanguage('hs'));
  });

  it('zig', () => {
    const c = gitignoreForLanguage('zig');
    expect(c).toContain('zig-out/');
    expect(c).toContain('zig-cache/');
    expectCommon(c);
  });

  it('dart', () => {
    const c = gitignoreForLanguage('dart');
    expect(c).toContain('.dart_tool/');
    expect(c).toContain('build/');
    expectCommon(c);
  });

  it('dart alias "flutter"', () => {
    expectCommon(gitignoreForLanguage('flutter'));
  });

  it('lua', () => {
    const c = gitignoreForLanguage('lua');
    expect(c).toContain('*.luac');
    expectCommon(c);
  });

  it('r', () => {
    const c = gitignoreForLanguage('r');
    expect(c).toContain('.Rhistory');
    expect(c).toContain('.Rproj.user/');
    expectCommon(c);
  });

  it('objective-c', () => {
    const c = gitignoreForLanguage('objective-c');
    expect(c).toContain('DerivedData/');
    expect(c).toContain('Pods/');
    expectCommon(c);
  });

  it('objective-c aliases', () => {
    expectCommon(gitignoreForLanguage('objc'));
    expectCommon(gitignoreForLanguage('obj-c'));
  });

  // ─── Cross-cutting behaviour ─────────────────────────────────────
  it('is case-insensitive', () => {
    expect(gitignoreForLanguage('RUST')).toBe(gitignoreForLanguage('rust'));
    expect(gitignoreForLanguage('Python')).toBe(gitignoreForLanguage('python'));
  });

  it('trims whitespace', () => {
    expect(gitignoreForLanguage('  rust  ')).toBe(gitignoreForLanguage('rust'));
  });

  it('falls back to common OS/editor rules for unknown language', () => {
    const content = gitignoreForLanguage('brainfuck');
    expectCommon(content);
    expect(content).not.toContain('target/');
    expect(content).not.toContain('node_modules');
  });

  it('common block includes macOS, Windows, and Linux artifacts', () => {
    const content = gitignoreForLanguage('unknown');
    expect(content).toContain('.DS_Store');
    expect(content).toContain('._*');
    expect(content).toContain('Thumbs.db');
    expect(content).toContain('Desktop.ini');
    expect(content).toContain('.Spotlight-V100');
    expect(content).toContain('.Trashes');
  });

  it('common block includes environment file rules', () => {
    const content = gitignoreForLanguage('rust');
    expect(content).toContain('.env');
    expect(content).toContain('!.env.example');
  });
});
