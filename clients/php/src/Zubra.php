<?php

namespace Zubra;

/**
 * Zubra in a PHP app, with no Node.js on the server: components are rendered to HTML by the zubra
 * compiler (a Rust binary) running as one long-lived `zubra serve` process, and served to the
 * browser as ES modules it compiles too. The browser hydrates the server's markup in place.
 *
 *     $zubra = new Zubra\Zubra(__DIR__ . '/components');   // a folder of .zb files
 *     $page = $zubra->page();                              // one per request
 *     echo $page->render('plot-map', ['plots' => $plots]); // server-rendered HTML
 *     echo $page->head(), $page->scripts();                // the CSS, then the modules
 *
 * The protocol is `zubra serve`'s JSON lines: one request per line on standard input, with every
 * component's source, and one response per line back. Laravel helpers are in Zubra\Laravel.
 *
 * The compiler is found, in order: the `compiler` argument, $ZUBRA_COMPILER, then `zubra` on the PATH.
 */
class Zubra
{
    public const VERSION = '0.1.0';
    public const HOW_TO = 'Download a binary from https://github.com/journey-to-code-org/zubra/releases and put it on the PATH, or set ZUBRA_COMPILER to its path.';

    public readonly string $dir;
    public readonly string $compiler;
    /** @var resource|null */
    private $process = null;
    /** @var array<int, resource> */
    private array $pipes = [];
    private ?array $sources = null;
    private array $css = [];
    private array $js = [];

    /** `$timeout` is how long one request may take, in seconds (null: no limit); a request that takes longer is an error, and the process is replaced. */
    public function __construct(string $components, ?string $compiler = null, private bool $cache = true, private ?float $timeout = 30.0)
    {
        $this->dir = rtrim($components, '/');
        $compiler ??= self::findCompiler();
        if ($compiler === null) {
            throw new ZubraException('zubra: no compiler found. ' . self::HOW_TO);
        }
        $this->compiler = $compiler;
    }

    public static function findCompiler(): ?string
    {
        $env = getenv('ZUBRA_COMPILER');
        if ($env !== false && $env !== '') {
            return $env;
        }
        foreach (explode(PATH_SEPARATOR, getenv('PATH') ?: '') as $dir) {
            if ($dir !== '' && is_executable("$dir/zubra")) {
                return "$dir/zubra";
            }
        }
        return null;
    }

    /** @return string[] The components in the folder, by file name (`plot-map`). */
    public function names(): array
    {
        $names = array_map(fn ($path) => basename($path, '.zb'), glob($this->dir . '/*.zb') ?: []);
        sort($names);
        return $names;
    }

    /** One request to the compiler for component `$name`: the output, or a ZubraException. */
    public function request(string $name, array $request): string
    {
        if (!in_array($name, $this->names(), true)) {
            throw new ZubraException("no component '$name' in {$this->dir}");
        }
        $body = ['path' => "/components/$name.zb", 'files' => $this->files()] + $request;
        // One line out for one line in, in order: whatever ends a request early ends the process
        // too, so the next request starts a fresh one and can't be handed this one's answer.
        $answered = false;
        try {
            if (!$this->alive()) {
                $this->start();
            }
            $line = $this->exchange(json_encode($body, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
            $response = json_decode($line, true);
            if (!is_array($response)) {
                throw new ZubraException("{$this->compiler} serve answered with something that isn't JSON: " . substr($line, 0, 200));
            }
            $answered = true;
        } finally {
            if (!$answered) {
                $this->stop();
            }
        }
        if (!$response['ok']) {
            throw new ZubraException($response['error']);
        }
        return $response['output'];
    }

    /** Component `$name` as HTML for `$props`; `$slots` is markup your server already rendered. */
    public function html(string $name, array $props = [], array $slots = []): string
    {
        return $this->request($name, ['emit' => 'html', 'props' => (object) $props, 'slots' => (object) $slots, 'slotSource' => 'html', 'partial' => true]);
    }

    /** The component's scoped CSS, including that of the components it imports. */
    public function css(string $name): string
    {
        if (!$this->cache) {
            return $this->request($name, ['emit' => 'css']);
        }
        return $this->css[$name] ??= $this->request($name, ['emit' => 'css']);
    }

    /** The module that defines the component's element (serve it as /components/<name>.js). */
    public function js(string $name, string $runtime = '@zubra/runtime'): string
    {
        if (!$this->cache) {
            return $this->request($name, ['emit' => 'js', 'runtime' => $runtime]);
        }
        return $this->js["$name\0$runtime"] ??= $this->request($name, ['emit' => 'js', 'runtime' => $runtime]);
    }

    public function page(): Page
    {
        return new Page($this);
    }

    /** Stop the compiler process (it also stops when this object goes). */
    public function close(): void
    {
        $this->stop();
    }

    public function __destruct()
    {
        $this->stop();
    }

    private function files(): array
    {
        if ($this->sources === null || !$this->cache) {
            $this->sources = [];
            foreach (glob($this->dir . '/*.zb') ?: [] as $path) {
                $this->sources['/components/' . basename($path)] = file_get_contents($path);
            }
            ksort($this->sources);
        }
        return $this->sources;
    }

    private function alive(): bool
    {
        return $this->process !== null && proc_get_status($this->process)['running'];
    }

    private function start(): void
    {
        $this->stop();
        if (!is_executable($this->compiler)) {
            throw new ZubraException("zubra: can't run the compiler at '{$this->compiler}'. " . self::HOW_TO);
        }
        $process = proc_open([$this->compiler, 'serve'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w']], $pipes);
        if (!is_resource($process)) {
            throw new ZubraException("zubra: can't run the compiler at '{$this->compiler}'. " . self::HOW_TO);
        }
        $this->process = $process;
        $this->pipes = $pipes;
    }

    private function stop(): void
    {
        if ($this->process === null) {
            return;
        }
        foreach ($this->pipes as $pipe) {
            if (is_resource($pipe)) {
                fclose($pipe);
            }
        }
        proc_terminate($this->process);
        proc_close($this->process);
        $this->process = null;
        $this->pipes = [];
    }

    private function exchange(string $line): string
    {
        if (@fwrite($this->pipes[0], $line . "\n") === false) {
            throw new ZubraException("{$this->compiler} serve stopped");
        }
        fflush($this->pipes[0]);
        $answer = '';
        $deadline = $this->timeout === null ? null : microtime(true) + $this->timeout;
        stream_set_blocking($this->pipes[1], false);
        while (!str_ends_with($answer, "\n")) {
            $read = [$this->pipes[1]];
            $write = $except = null;
            $left = $deadline === null ? null : max(0, $deadline - microtime(true));
            $ready = stream_select($read, $write, $except, $left === null ? null : (int) $left, $left === null ? null : (int) (($left - (int) $left) * 1e6));
            if ($ready === false) {
                continue; // interrupted by a signal
            }
            if ($ready === 0) {
                throw new ZubraException("{$this->compiler} serve didn't answer within {$this->timeout}s; it has been restarted");
            }
            $chunk = fread($this->pipes[1], 1 << 16);
            if ($chunk === '' || $chunk === false) {
                if (feof($this->pipes[1])) {
                    throw new ZubraException("{$this->compiler} serve stopped");
                }
                continue;
            }
            $answer .= $chunk;
        }
        return $answer;
    }
}
