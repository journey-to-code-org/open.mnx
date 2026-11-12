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
  "review: moved code keeps its rewrites and its meaning on one line (1)": {
    options: {"useDefineForClassFields": false},
    source: `
    class A {
      x = [1, // one
           2];
      static s = \`a
    b\`;
      y = "z";
    }
    globalThis.result = [new A().x, A.s, new A().y];`,
  },
  "review: moved code keeps its rewrites and its meaning on one line (2)": {
    options: {"useDefineForClassFields": false},
    source: `
    class A {
      static s = \`a
    b\`;
      t = "c\\
    d";
    }
    globalThis.result = [A.s, new A().t];`,
  },
  "review: moved code keeps its rewrites and its meaning on one line (3)": {
    options: {"useDefineForClassFields": false},
    source: `
    class Outer {
      a = 1;
      m() {
        class Inner { b = 2; constructor(public c: number) {} }
        return new Inner(3);
      }
      static Nested = class { x = 4; constructor(private y = 5) {} get v() { return this.y; } };
    }
    const i = new Outer().m();
    globalThis.result = [Object.keys(i), Object.keys(new Outer.Nested()), new Outer.Nested().v];`,
  },
  "review: moved code keeps its rewrites and its meaning on one line (4)": {
    options: {"useDefineForClassFields": false},
    source: `
    namespace N {
      export let base = 1;
      export class K {
        v = base + 1;
        w = <number>(<unknown>base);
        make = () => new (class { constructor(public z = 9) {} })();
      }
    }
    globalThis.result = [new N.K().v, new N.K().w, new N.K().make().z];`,
  },
  "review: #private fields and accessor storage are assigned in order (1)": {
    options: {"useDefineForClassFields": false},
    source: `
    const log: string[] = [];
    const d = (v: any, ctx: any) => (x: any) => { log.push(String(ctx.name)); return x; };
    class A {
      @d x = 1;
      #p = log.push("#p");
      @d y = 2;
    }
    new A();
    globalThis.result = [log];`,
  },
  "review: #private fields and accessor storage are assigned in order (2)": {
    options: {"useDefineForClassFields": false},
    source: `
    class A {
      x = 1;
      #p = this.x + 1;
      get p() { return this.#p; }
    }
    globalThis.result = [new A().p];`,
  },
  "review: #private fields and accessor storage are assigned in order (3)": {
    options: {"useDefineForClassFields": false},
    source: `
    class A {
      x = 1;
      accessor a = this.x + 1;
    }
    globalThis.result = [new A().a];`,
  },
  "review: decorators with namespace references and multi-line arguments (1)": {
    options: {"target": "es2022"},
    source: `
    namespace N {
      export const tag = "t";
      const d = (n: string) => (v: any, ctx: any) => { (globalThis as any).seen = n; };
      export class K { @d(tag) m() {} }
    }
    globalThis.result = [(globalThis as any).seen];`,
  },
  "review: decorators with namespace references and multi-line arguments (2)": {
    options: {"target": "es2022"},
    source: `
    const d = (o: any) => (t: any, k?: any) => { (globalThis as any).seen = o; };
    @d({
      tag: "x",
      text: \`a
    b\`,
    })
    class K {}
    globalThis.result = [(globalThis as any).seen];`,
  },
  "review: a decorated field before an undecorated computed name": {
    options: {"target": "es2022"},
    source: `
    const d = (v: any, c?: any) => v;
    class K { @d s = 2; [Symbol.iterator]() { return [1][Symbol.iterator](); } @d t = 3; ["u" + 1] = 4; }
    const k = new K();
    globalThis.result = [k.s, k.t, [...k], (k as any).u1];`,
  },
  "review: <T>x where the brackets mattered (1)": `
    function f(): number {
      return <number>
        (5 as any);
    }
    const g = () => <any>{ a: 1 };
    globalThis.result = [f(), g()];`,
  "review: <T>x where the brackets mattered (2)": `
    let r: any;
    <any>function () { r = "called"; }();
    globalThis.result = [r];`,
  "review: parameter properties with constructor overloads": `
    class A {
      constructor(x: number);
      constructor(x: string);
      constructor(public x: any) {}
    }
    globalThis.result = [Object.keys(new A(1)), new A(2).x];`,
  "review: merged and dotted namespaces, and enums in them (1)": `
    namespace A {
      export namespace B { export const x = 1; }
      export namespace B { export const y = x + 1; }
    }
    globalThis.result = [A.B.x, A.B.y];`,
  "review: merged and dotted namespaces, and enums in them (2)": `
    namespace A {
      export class C { static k = 1; }
      export namespace C { export const extra = 2; }
    }
    globalThis.result = [A.C.k, (A.C as any).extra];`,
  "review: merged and dotted namespaces, and enums in them (3)": `
    namespace A {
      export enum E { X = 1 }
      export enum E { Y = 2 }
      enum F { P = E.X + 1, Q }
      export const f = F.Q;
    }
    globalThis.result = [A.E.X, A.E.Y, A.f];`,
  "review: merged and dotted namespaces, and enums in them (4)": `
    namespace A.B { export const x = 1; }
    namespace A.B { export const y = x + 1; }
    namespace A { export const z = B.y; }
    globalThis.result = [A.B.x, A.B.y, A.z];`,
  "review: merged and dotted namespaces, and enums in them (5)": `
    namespace A {
      export enum E { X = 1 }
      export enum E { Y = 2 }
    }
    globalThis.result = [A.E.X, A.E.Y];`,
  "review: namespace references to shadowed names, destructuring, its own name (1)": `
    const x = 1;
    namespace N { export const x = 2; }
    namespace N { globalThis.result = [x]; }`,
  "review: namespace references to shadowed names, destructuring, its own name (2)": `
    namespace N {
      export let x = 1;
      const obj = { x: 5 };
      ({ x } = obj);
      globalThis.result = [N.x];
    }`,
  "review: namespace references to shadowed names, destructuring, its own name (3)": `
    namespace N {
      const N = 5;
      export const y = N + 1;
    }
    globalThis.result = [N.y];`,
  "review: a line break after export const in a namespace": `
    namespace N {
      export const
        a = 1;
    }
    const at = new Error().stack!.split("\\n")[1].match(/:(\\d+):\\d+\\)?$/)![1];
    globalThis.result = [Number(at), N.a];`,
  "review: enum numbers, templates, constants and scopes (1)": `
    enum E { A = -0, B = 0.1 + 0.2, C = 1e21, D = 2 ** 53 + 2, F = 1/3, G = 0xFF, H = 5e-7, I = 1_000 }
    globalThis.result = [Object.entries(E).map(([k, v]) => [k, Object.is(v, -0) ? "-0" : v])];`,
  "review: enum numbers, templates, constants and scopes (2)": `
    const Other = { A: 5 };
    enum E { Other = 1, B = Other + 1 }
    enum F { X = "x", Y = \`\${X}y\`, Z = X.length }
    globalThis.result = [Object.entries(E), Object.entries(F)];`,
  "review: enum numbers, templates, constants and scopes (3)": `
    enum E { A = "a" }
    enum G { B = E.A, C = E["A"] + "c", D = \`t\${E.A}\` }
    const enum CE { K = 3 }
    enum H { M = CE.K, N }
    globalThis.result = [Object.entries(G), Object.entries(H)];`,
  "review: enum numbers, templates, constants and scopes (4)": `
    enum E { A = 1, B = ((A: number) => A * 2)(5), C = [10].map(A => A)[0], D = { A: 7 }.A }
    globalThis.result = [Object.entries(E)];`,
  "review: enum numbers, templates, constants and scopes (5)": `
    const n = 3;
    enum E { A = 1, B = (n as number) + A, C = n! }
    globalThis.result = [Object.entries(E)];`,
  "review: enum numbers, templates, constants and scopes (6)": `
    namespace N {
      export const base = 2;
      export enum E { A = base * "ab".length, B = A + 1 }
    }
    globalThis.result = [Object.entries(N.E)];`,
  "review: enum numbers, templates, constants and scopes (7)": `
    namespace NS { export const base = 10; export enum Inner { X = 3 } }
    enum E { A = NS.base, B, C = NS.Inner.X * 2 }
    globalThis.result = [Object.entries(E)];`,
  "review: an enum member from a const": `
    const base = 4;
    enum Size { Small, Large = base * 2, Big }
    globalThis.result = [Object.entries(Size)];`,
  "review: a legacy class decorator's class sees what it returns": {
    options: {"experimentalDecorators": true},
    source: `
    function wrap(cls: any) { return class extends cls { static tag = "wrapped"; }; }
    @wrap class A {
      static self() { return A; }
      m() { return A; }
    }
    globalThis.result = [(A as any).tag, A.self() === A, new A().m() === A, (A.self() as any).tag];`,
  },
  'review: a static initializer sees the class a legacy decorator is applied to': {
    options: { experimentalDecorators: true },
    source: `
    function wrap(cls: any) { return class extends cls { static tag = "wrapped"; }; }
    @wrap class A {
      static named = A.name;
      static self() { return A; }
    }
    globalThis.result = [A.named, (A as any).tag, A.self() === A];`,
  },
  'review: decorators before a computed name, with fields assigned in the constructor': {
    options: { target: 'es2022', useDefineForClassFields: false },
    source: `
    const d = (v: any, c?: any) => v;
    class K { @d s = 2; [Symbol.iterator]() { return [1][Symbol.iterator](); } @d t = 3; ["u" + 1] = 4; }
    const k = new K();
    globalThis.result = [k.s, k.t, [...k], (k as any).u1];`,
  },
  'review: an enum member after one from an enum in a namespace': `
    namespace NS { export enum Inner { X = 3 } }
    enum E { C = NS.Inner.X * 2, D }
    globalThis.result = [Object.entries(E)];`,
  'review: a namespace\'s own binding wins over another declaration\'s export': `
    namespace N { export const x = 2; }
    namespace N { const x = 5; export const y = x; function f(x: number) { return x; } export const z = f(7); }
    globalThis.result = [N.x, N.y, N.z];`,
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
