<?php

namespace Zubra\Laravel;

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\ServiceProvider;
use Zubra\Page;
use Zubra\Zubra;

/**
 * Laravel: Blade directives, a page per request, a middleware that fills in the head and scripts
 * after rendering, and a route for the modules. Discovered from composer.json (`extra.laravel`).
 *
 *     // config/zubra.php (optional): components (resource_path('components')), compiler, route ('/components')
 *     @zubra('plot-map', ['plots' => $plots, 'columns' => 4])   in a view
 *     @zubraHead                                                 in the layout's <head>
 *     @zubraScripts                                              before </body>
 */
class ZubraServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(Zubra::class, fn ($app) => new Zubra(
            (string) $app['config']->get('zubra.components', $app->resourcePath('components')),
            $app['config']->get('zubra.compiler'),
        ));
        // One page per request (and per job, under Octane), so pages don't share what they used.
        $this->app->scoped(Page::class, fn ($app) => $app->make(Zubra::class)->page());
    }

    public function boot(): void
    {
        foreach (Directives::all() as $name => $compiler) {
            Blade::directive($name, $compiler);
        }
        $route = rtrim((string) $this->app['config']->get('zubra.route', '/components'), '/');
        $this->app['router']->get("$route/{name}.js", ModuleController::class)->where('name', '[a-z0-9-]+');
        $this->app->make(Kernel::class)->pushMiddleware(Middleware::class);
    }
}
