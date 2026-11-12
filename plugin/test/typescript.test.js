// TypeScript in `<script lang="ts">`, checked against TypeScript itself: each fixture is reduced
// to JavaScript by the compiler (`zubra request`, command `typescript`) and by `tsc`, both run, and
// what they observe must be the same. The compiler writes enums differently (an object literal
// where it can), so this is what says the difference doesn't show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const compiler = process.env.ZUBRA_COMPILER ?? join(here, '../../target/debug/zubra');
const tsc = join(here, '../node_modules/.bin/tsc');

const fixtures = {
  'numeric, auto-incremented, with reverse mapping': `
    enum Size { Small, Medium = 4, Large }
    globalThis.result = [Object.entries(Size), Size[4], Size.Large];`,
  'members from earlier members, arithmetic and bitwise': `
    enum Flags { None = 0, A = 1 << 0, B = 1 << 1, AB = A | B, Not = ~A, Neg = -B, Mix = (AB * 3) % 5 - 1, Shift = -16 >> 2, Zero = -16 >>> 28, Pow = 2 ** 3 }
    globalThis.result = Object.entries(Flags);`,
  'strings and template strings': `
    enum Tone { Warm = "warm", Cool = \`cool\`, Both = Warm + "-" + Cool }
    globalThis.result = Object.entries(Tone);`,
  'heterogeneous': `
    enum Mixed { No = 0, Yes = "YES", Again = 7, Next }
    globalThis.result = Object.entries(Mixed);`,
  'computed members, and members after them': `
    const base = 10;
    enum Computed { A = "abc".length, B = A * 2, C = base + 1, D = 5, E }
    globalThis.result = Object.entries(Computed);`,
  'merged declarations': `
    enum Merged { A = 1, B }
    enum Merged { C = B + 10, D }
    globalThis.result = Object.entries(Merged);`,
  "names that aren't identifiers, and duplicate values": `
    enum Odd { "my-key" = 1, 'with space' = 1, Plain = 2, ["computed"] = 3 }
    globalThis.result = [Object.entries(Odd), Odd[1]];`,
  'one enum from another': `
    enum First { A = 2 }
    enum Second { B = First.A * 3, C = First["A"] + 1, D = \`x\` + First.A }
    globalThis.result = Object.entries(Second);`,
  'infinite and NaN members': `
    enum Edge { Big = 1 / 0, Small = -1 / 0, Odd = 0 / 0 }
    globalThis.result = [String(Edge.Big), String(Edge.Small), String(Edge.Odd), Edge.Odd !== Edge.Odd];`,
  'a const enum, read by member': `
    const enum Local { One = 1, Two = One + 1, Name = "n" }
    globalThis.result = [Local.One, Local.Two, Local.Name];`,
  'a namespace: exported values, functions, classes, nested and merged': `
    namespace Shapes {
      export const sides = 4;
      export let count = sides + 1;
      export function area(side: number) { return side * sides + count; }
      export class Box { constructor(public side: number) {} }
      count = 10;
      const hidden = 2;
      export namespace Inner { export const twice = hidden * 2; }
      export enum Kind { Square, Round = "round" }
      export import Twice = Inner.twice;
      export type Unused = number;
      export const short = { count };
    }
    namespace Shapes {
      export const again = area(1) + sides;
    }
    namespace Shapes.Deep.Down { export const level = 3; }
    globalThis.result = [Shapes.sides, Shapes.count, Shapes.area(2), new Shapes.Box(5).side, Shapes.Inner.twice, Shapes.Kind.Round, Shapes.Kind[0], Shapes.Twice, Shapes.short, Shapes.again, Shapes.Deep.Down.level, Object.keys(Shapes)];`,
  'a namespace merged into a function, and one with only types': `
    function greet(name: string) { return greet.prefix + name; }
    namespace greet { export const prefix = "hi "; }
    namespace OnlyTypes { export interface A { a: number } export type B = string; }
    globalThis.result = [greet("you"), typeof OnlyTypes];`,
  'parameter properties, as fields, in a subclass after super()': `
    class Base { constructor(public base: number) {} }
    class Point extends Base {
      label = "p";
      constructor(public x: number, private readonly y = 2, protected override z?: number) {
        const before = x + 1;
        super(before);
      }
      sum() { return this.x + this.y + this.base; }
    }
    const point = new Point(3);
    globalThis.result = [point.sum(), Object.keys(point), point.label];`,
  'a this parameter, <T>value and an import alias': `
    namespace Config { export const port = 8080; export namespace Types { export type T = string } }
    import Port = Config.port;
    import T = Config.Types.T;
    function describe(this: { name: string }, suffix: string) { return this.name + suffix; }
    const n = <number>(<unknown>"5");
    globalThis.result = [describe.call({ name: "a" }, "!"), n, Port];`,
  'without useDefineForClassFields: fields are assignments in the constructor': {
    options: { useDefineForClassFields: false },
    source: `
    class Base { constructor(public base: number) {} }
    class Assigned extends Base {
      y = this.x * 2;
      declared: number;
      static counted = 1;
      #own = 5;
      ["computed"] = "c";
      constructor(public x: number) {
        super(x)
      }
      read() { return this.#own; }
    }
    class Plain { a = 1; b?: string; }
    class Derived extends Assigned { extra = this.y + 1 }
    const item = new Derived(2);
    globalThis.result = [Object.keys(item), item.y, item.extra, item.read(), Assigned.counted, Object.keys(new Plain())];`,
  },
  'legacy decorators (experimentalDecorators)': {
    options: { experimentalDecorators: true },
    source: `
    const log: string[] = [];
    function track(name: string) {
      return (target: any, key?: string, descriptor?: PropertyDescriptor) => {
        log.push(name + ":" + (typeof target === "function" ? "class " + target.name : "proto") + ":" + String(key) + ":" + typeof descriptor);
        if (descriptor && typeof descriptor.value === "function") {
          const original = descriptor.value;
          descriptor.value = function (...args: any[]) { return original.apply(this, args) * 10; };
        }
      };
    }
    function sealed<T extends new (...args: any[]) => object>(constructor: T) {
      log.push("sealed:" + constructor.name);
      return class extends constructor { sealed = true };
    }
    function inject(token: string) {
      return (target: any, key: string | undefined, index: number) => { log.push("param:" + token + ":" + String(key) + ":" + index); };
    }
    @sealed
    @track("class")
    class Service {
      @track("static") static make() { return 1; }
      @track("method") @track("second") run(@inject("arg") value: number) { return value; }
      @track("field") name = "s";
      @track("getter") get size() { return 2; }
      set size(value: number) {}
      constructor(@inject("ctor") public readonly id: number) {}
    }
    class Plain { @track("plain") go() { return 3; } }
    const service = new Service(7);
    globalThis.result = [log, service.run(2), Service.make(), new Plain().go(), (service as any).sealed, service.id];`,
  },
  'standard decorators: class, methods, fields, accessors, and their initializers': {
    options: { target: 'es2022' },
    source: `
    const log: string[] = [];
    function d(name: string) {
      log.push("evaluate " + name);
      return (value: any, context: any) => {
        log.push(name + ":" + context.kind + ":" + String(context.name) + ":" + context.static + ":" + context.private + ":" + typeof value);
        context.addInitializer?.(function (this: any) { log.push("init " + name + ":" + (typeof this === "function" ? "class" : "instance")); });
        if (context.kind === "field") return function (this: any, v: any) { log.push("field " + name + " = " + v); return v * 10; };
        if (context.kind === "method") return function (this: any, ...args: any[]) { return "wrapped " + value.apply(this, args); };
        if (context.kind === "accessor") return { get(this: any) { return value.get.call(this) + 100; }, init(v: any) { return v + 1; } };
        if (context.kind === "class") { log.push("class name " + value.name); return class extends value { extra = "subclassed" }; }
      };
    }
    @d("cls")
    class Base {}
    @d("klass")
    class A extends Base {
      @d("f") f = 1;
      g = (log.push("g"), 2);
      @d("s") static s = 3;
      static t = (log.push("t"), 4);
      @d("m") m() { return "m"; }
      @d("sm") static sm() { return "sm"; }
      @d("get") get size() { return 9; }
      @d("set") set size(value: number) { log.push("set " + value); }
      @d("acc") accessor acc = 4;
      accessor plain = 5;
      @d("sacc") static accessor sacc = 6;
      @d("pm") #pm() { return "pm"; }
      @d("pg") get #pg() { return "pg"; }
      @d("pf") #pf = 8;
      @d("pacc") accessor #pacc = 11;
      @d("lit") "my method"() { return "lit"; }
      @d("comp") [String("computed")] = 12;
      @d("bare") bare: number;
      read() { return [this.#pm(), this.#pg, this.#pf, this.#pacc, #pm in this]; }
      self() { return A; }
    }
    const a = new A();
    a.size = 3;
    a.plain = 50;
    globalThis.result = [log, a.f, a.g, A.s, A.t, a.m(), A.sm(), a.size, a.acc, a.plain, A.sacc, a.read(), (a as any)["my method"](), (a as any).computed, a.bare, (a as any).extra, a.self() === A, A.name, Object.getOwnPropertySymbols(A).length, Object.keys(a)];`,
  },
  'standard decorators: anonymous classes, expressions and access': {
    options: { target: 'es2022' },
    source: `
    const seen: any[] = [];
    const named = (value: any, context: any) => { seen.push([context.kind, context.name]); };
    let access: any;
    const grab = (value: any, context: any) => { access = context.access; };
    const X = @named class {};
    const Y = class { @named static make() { return 1; } };
    const Z = @named class Inner { static me() { return Inner; } };
    class Box { @grab #secret = 1; static open(box: Box) { return access.get(box); } static put(box: Box, value: number) { access.set(box, value); } @named #hidden() { return 2; } }
    const box = new Box();
    Box.put(box, 41);
    // Metadata, where a runtime has \`Symbol.metadata\` (and a subclass's starts from its parent's).
    (Symbol as any).metadata ??= Symbol("Symbol.metadata");
    const tag = (label: string) => (value: any, context: any) => { context.metadata[String(context.name)] = label; };
    class Parent { @tag("parent") a = 1; }
    class Child extends Parent { @tag("child") b = 2; }
    const meta = (Child as any)[(Symbol as any).metadata];
    globalThis.result = [seen, X.name, Y.name, Y.make(), Z.name, Z.me() === Z, Box.open(box), access.has(box), access.has({}), Object.getOwnPropertySymbols(Box).length, meta.a, meta.b, Object.keys(meta)];`,
  },
  'standard decorators on fields assigned in the constructor (useDefineForClassFields false)': {
    options: { target: 'es2022', useDefineForClassFields: false },
    source: `
    const log: string[] = [];
    const twice = (value: any, context: any) => { context.addInitializer(function (this: any) { log.push("after " + String(context.name) + " " + this[context.name]); }); return (v: any) => v * 2; };
    class Base { constructor() { log.push("base"); } }
    class A extends Base {
      @twice f = 1;
      g = 2;
      @twice static s = 3;
      @twice none: number;
      constructor() { super(); log.push("body " + this.f); }
    }
    const a = new A();
    globalThis.result = [log, a.f, a.g, A.s, a.none, Object.keys(a)];`,
  },
  'lines after an enum keep their numbers': `
    enum Lines {
      A,

      B = 3,
    }
    const at = new Error().stack.split("\\n")[1].match(/:(\\d+):\\d+\\)?$/)[1];
    globalThis.result = [Number(at)];`,
};

function viaZubra(source, compilerOptions) {
  const result = spawnSync(compiler, ['request'], {
    input: JSON.stringify({ command: 'typescript', path: '/fixture.ts', files: { '/fixture.ts': source }, compilerOptions }),
    encoding: 'utf8',
  });
  const response = JSON.parse(result.stdout);
  assert.ok(response.ok, response.error);
  return response.output;
}

function viaTsc(directory, name, source, compilerOptions = {}) {
  const file = join(directory, `${name}.ts`);
  writeFileSync(file, source);
  // `--noCheck`: emit only (the fixtures read enums in ways the checker would refuse to print).
  // `--isolatedModules`, as a component script is compiled on its own.
  const options = Object.entries(compilerOptions).flatMap(([key, value]) => [`--${key}`, String(value)]);
  spawnSync(tsc, ['--target', 'esnext', '--module', 'esnext', '--noCheck', '--isolatedModules', ...options, '--outDir', directory, file], { encoding: 'utf8' });
  return readFileSync(join(directory, `${name}.js`), 'utf8');
}

function run(code) {
  const context = vm.createContext({});
  // The fixture's lines start at 1 in both, so a stack trace's line is comparable.
  vm.runInContext(code.replace(/^"use strict";\n/, ''), context, { filename: 'fixture.js' });
  return JSON.parse(JSON.stringify(context.result));
}

const ready = existsSync(compiler) && existsSync(tsc);

test('enums: the compiler\'s JavaScript does what tsc\'s does', { skip: !ready && 'needs target/debug/zubra and TypeScript' }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'zubra-ts-'));
  let index = 0;
  for (const [name, fixture] of Object.entries(fixtures)) {
    await t.test(name, () => {
      const { source, options } = typeof fixture === 'string' ? { source: fixture } : fixture;
      const trimmed = source.replace(/^\n/, '').replace(/^ {4}/gm, '');
      const ours = viaZubra(trimmed, options);
      const theirs = viaTsc(directory, `fixture${index++}`, trimmed, options);
      assert.deepEqual(run(ours), run(theirs), `zubra:\n${ours}\n\ntsc:\n${theirs}`);
      assert.equal(ours.split('\n').length, trimmed.split('\n').length, 'the same number of lines');
    });
  }
});
