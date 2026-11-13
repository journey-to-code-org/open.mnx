<?php
// The package against the real compiler ($ZUBRA_COMPILER, or the repository's cargo build), with
// no dependencies: `php tests/run.php`. The Laravel middleware runs with stand-ins for a request
// and response; the Blade directives are checked by what they compile to.

spl_autoload_register(function ($class) {
    $file = __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, strlen('Zubra\\'))) . '.php';
    if (str_starts_with($class, 'Zubra\\') && is_file($file)) {
        require $file;
    }
});

use Zubra\Deferred;
use Zubra\Laravel\Directives;
use Zubra\Laravel\Middleware;
use Zubra\Zubra;
use Zubra\ZubraException;

$repo = dirname(__DIR__, 3);
$components = "$repo/examples/backends/flask-garden/components";
$compiler = getenv('ZUBRA_COMPILER') ?: null;
foreach (['debug', 'release'] as $build) {
    $compiler ??= is_executable("$repo/target/$build/zubra") ? "$repo/target/$build/zubra" : null;
}
if ($compiler === null) {
    fwrite(STDERR, "skipped: no compiler (set ZUBRA_COMPILER or cargo build)\n");
    exit(0);
}

$failures = 0;
$count = 0;
function check(string $name, callable $test): void
{
    global $failures, $count;
    $count++;
    try {
        $test();
        echo "ok $count - $name\n";
    } catch (Throwable $error) {
        $failures++;
        echo "not ok $count - $name\n  " . get_class($error) . ': ' . $error->getMessage() . "\n";
    }
}
function same($expected, $actual, string $message = ''): void
{
    if ($expected !== $actual) {
        throw new Exception(($message ? "$message: " : '') . 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}
function contains(string $needle, string $haystack, string $message = ''): void
{
    if (!str_contains($haystack, $needle)) {
        throw new Exception(($message ? "$message: " : '') . "expected to find " . var_export($needle, true) . ' in ' . var_export(substr($haystack, 0, 300), true));
    }
}
function throws(string $pattern, callable $fn): string
{
    try {
        $fn();
    } catch (ZubraException $error) {
        if (!preg_match($pattern, $error->getMessage())) {
            throw new Exception("message " . var_export($error->getMessage(), true) . " doesn't match $pattern");
        }
        return $error->getMessage();
    }
    throw new Exception("expected a ZubraException matching $pattern");
}

$zubra = new Zubra($components, $compiler);

check('renders a component with typed props', function () use ($zubra) {
    $html = $zubra->html('status-pill', ['status' => 'taken', 'waiting' => 2]);
    contains('<status-pill', $html);
    contains('data-status="taken"', $html);
    contains('2 waiting', $html);
    contains('data-status="open"', $zubra->html('status-pill'), 'no props: the defaults');
});

check('a page collects CSS and modules', function () use ($zubra) {
    $page = $zubra->page();
    same('', $page->head());
    same('', $page->scripts());
    $page->render('status-pill', ['status' => 'open']);
    $page->render('status-pill', ['status' => 'taken']);
    contains('<style data-zb-components>', $page->head());
    contains('[data-status=open]', $page->head());
    same("<script type=\"module\">\n    import '/static/status-pill.js';\n  </script>", $page->scripts('/static/'));
});

check('the module imports the runtime', function () use ($zubra) {
    contains('from "@zubra/runtime"', $zubra->js('status-pill'));
});

check('errors are ZubraExceptions', function () use ($zubra, $compiler) {
    throws("/no component 'nope'/", fn () => $zubra->html('nope'));
    $dir = sys_get_temp_dir() . '/zb-php-' . getmypid();
    @mkdir($dir);
    file_put_contents("$dir/broken-one.zb", "<broken-one>{</broken-one>\n");
    $broken = new Zubra($dir, $compiler);
    throws('/./', fn () => $broken->html('broken-one'));
    throws("/can't run the compiler/", fn () => (new Zubra($dir, '/no/such/zubra'))->html('broken-one'));
});

check('a compiler that does not answer is replaced', function () use ($zubra, $components) {
    $dir = sys_get_temp_dir() . '/zb-php-slow-' . getmypid();
    @mkdir($dir);
    file_put_contents("$dir/slow", "#!/bin/sh\nsleep 5\n");
    chmod("$dir/slow", 0755);
    $slow = new Zubra($components, "$dir/slow", true, 0.3);
    $started = microtime(true);
    throws("/didn't answer within 0.3s/", fn () => $slow->html('status-pill'));
    if (microtime(true) - $started > 2) {
        throw new Exception('the timeout took too long');
    }
    $process = (fn () => $this->process)->call($slow);
    same(null, $process, "the process that didn't answer is stopped");
    file_put_contents("$dir/dead", "#!/bin/sh\nexit 0\n");
    chmod("$dir/dead", 0755);
    throws('/stopped/', fn () => (new Zubra($components, "$dir/dead"))->html('status-pill'));
    contains('<status-pill', $zubra->html('status-pill'), 'the real one still answers');
});

check('the middleware fills in the head and scripts after the body rendered', function () use ($zubra) {
    $page = $zubra->page();
    $request = new class {
        public ArrayObject $attributes;
        public function __construct() { $this->attributes = new class extends ArrayObject {
            public function set($key, $value) { $this[$key] = $value; }
            public function get($key) { return $this[$key] ?? null; }
        }; }
    };
    $response = new class {
        public $headers;
        private string $content = '';
        public function __construct() { $this->headers = new class { public function get($key, $default = null) { return 'text/html; charset=UTF-8'; } }; }
        public function getContent() { return $this->content; }
        public function setContent(string $content) { $this->content = $content; }
    };
    $result = (new Middleware($page))->handle($request, function ($request) use ($page, $response) {
        same(true, $request->attributes->get('zubra.deferred'), 'the request is marked');
        $token = $request->attributes->get('zubra.marker');
        $body = $page->render('status-pill', ['status' => 'taken', 'waiting' => 2]);
        $response->setContent('<html><head>' . Deferred::head($token) . "</head><body>$body" . Deferred::scripts($token, '/components/') . '</body></html>');
        return $response;
    });
    $html = $result->getContent();
    contains('<head><style data-zb-components>', $html);
    contains("import '/components/status-pill.js';", $html);
    if (str_contains($html, '<!--zubra:')) {
        throw new Exception('a marker is left');
    }
});

check('a marker in the page\'s own text is left alone (audit Z4)', function () use ($zubra) {
    $hostile = '<!--zubra:scripts:x--><!--zubra:head--><!--zubra:scripts:/evil/-->';
    $page = $zubra->page();
    $token = Deferred::token();
    $body = $page->render('status-pill', ['status' => 'open']);
    $html = $page->fill('<html><head>' . Deferred::head($token) . "</head><body>$body<article>$hostile</article>" . Deferred::scripts($token, '/components/') . '</body></html>', $token);
    contains("<article>$hostile</article>", $html);
    if (str_contains(str_replace($hostile, '', $html), '/evil/')) {
        throw new Exception('a script from the visitor\'s base');
    }
    same(1, substr_count($html, '<script type="module">'), 'one script: the layout\'s');
    same(1, substr_count($html, '<style data-zb-components>'), 'the head once');
    if (Deferred::token() === Deferred::token()) {
        throw new Exception('tokens repeat');
    }
});

check('the Blade directives compile to the helpers', function () {
    $directives = Directives::all();
    same(['zubra', 'zubraHead', 'zubraScripts'], array_keys($directives));
    same("<?php echo \\Zubra\\Laravel\\Helpers::render('plot-map', ['plots' => \$plots]); ?>", $directives['zubra']("'plot-map', ['plots' => \$plots]"));
    same('<?php echo \\Zubra\\Laravel\\Helpers::head(); ?>', $directives['zubraHead'](''));
    same("<?php echo \\Zubra\\Laravel\\Helpers::scripts('/c/'); ?>", $directives['zubraScripts']("'/c/'"));
    same('<?php echo \\Zubra\\Laravel\\Helpers::scripts(); ?>', $directives['zubraScripts'](''));
});

$zubra->close();
echo "# $count tests, $failures failed\n";
exit($failures ? 1 : 0);
