<?php

namespace Zubra\Laravel;

use Zubra\Deferred;
use Zubra\Page;

/** What compiled Blade calls: the request's Page, and markers when the middleware will fill them in. */
final class Helpers
{
    public static function render(string $name, array $props = [], array $slots = []): string
    {
        return self::page()->render($name, $props, $slots);
    }

    public static function head(): string
    {
        return self::deferred() ? Deferred::head(self::marker()) : self::page()->head();
    }

    public static function scripts(?string $base = null): string
    {
        $base ??= (string) config('zubra.scripts_base', '/components/');
        return self::deferred() ? Deferred::scripts(self::marker(), $base) : self::page()->scripts($base);
    }

    private static function page(): Page
    {
        return app(Page::class);
    }

    private static function marker(): string
    {
        return (string) request()?->attributes->get('zubra.marker');
    }

    private static function deferred(): bool
    {
        return (bool) request()?->attributes->get('zubra.deferred');
    }
}
