<?php

namespace Zubra;

/**
 * Markers a layout's head and scripts leave when the page's CSS and modules are filled in after
 * rendering (a layout's `<head>` is written before the view's components are rendered).
 */
final class Deferred
{
    public const HEAD = '<!--zubra:head-->';
    public const SCRIPTS = '<!--zubra:scripts:';

    public static function scripts(string $base): string
    {
        return self::SCRIPTS . str_replace('--', '', $base) . '-->';
    }
}
